// Package linear implements ports.Tracker against Linear's GraphQL API. The
// project-config scope is the team key (e.g. "ENG"); intake reads issues for
// that team and maps Linear's workflow-state types onto NormalizedIssueState.
package linear

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	defaultBaseURL   = "https://api.linear.app/graphql"
	defaultUserAgent = "ao-agent-orchestrator/tracker-linear"
	defaultListLimit = 30
	maxListLimit     = 100
)

// Sentinels mirror the GitHub adapter so observer code can treat them the same.
var (
	ErrNotFound      = errors.New("linear tracker: issue not found")
	ErrAuthFailed    = errors.New("linear tracker: authentication failed")
	ErrWrongProvider = errors.New("linear tracker: id is not a linear tracker id")
	ErrBadID         = errors.New("linear tracker: malformed native id")
)

// Options mirrors github.Options. Token is required; HTTPClient/BaseURL/UserAgent
// are test injection points.
type Options struct {
	Token      TokenSource
	HTTPClient *http.Client
	BaseURL    string
	UserAgent  string
}

// Tracker implements ports.Tracker against Linear's GraphQL API.
type Tracker struct {
	http      *http.Client
	tokens    TokenSource
	baseURL   string
	userAgent string
}

// New constructs a Tracker. It fails fast when no token can be obtained so the
// daemon crashes at startup rather than at first list.
func New(opts Options) (*Tracker, error) {
	if opts.Token == nil {
		return nil, ErrNoToken
	}
	if _, err := opts.Token.Token(context.Background()); err != nil {
		return nil, err
	}
	t := &Tracker{
		http:      opts.HTTPClient,
		tokens:    opts.Token,
		baseURL:   opts.BaseURL,
		userAgent: opts.UserAgent,
	}
	if t.http == nil {
		t.http = &http.Client{Timeout: 30 * time.Second}
	}
	if t.baseURL == "" {
		t.baseURL = defaultBaseURL
	}
	if t.userAgent == "" {
		t.userAgent = defaultUserAgent
	}
	return t, nil
}

var _ ports.Tracker = (*Tracker)(nil)

// ---------------------------------------------------------------------------
// GraphQL DTOs
// ---------------------------------------------------------------------------

type lnIssue struct {
	Identifier  string   `json:"identifier"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	URL         string   `json:"url"`
	State       lnState  `json:"state"`
	Labels      lnLabels `json:"labels"`
	Assignee    *lnUser  `json:"assignee"`
	Assignees   lnUsers  `json:"assignees"` // tolerate array form for forward compatibility
}

type lnState struct {
	Type string `json:"type"`
	Name string `json:"name"`
}

type lnLabels struct {
	Nodes []struct {
		Name string `json:"name"`
	} `json:"nodes"`
}

type lnUser struct {
	DisplayName string `json:"displayName"`
	Name        string `json:"name"`
}

type lnUsers struct {
	Nodes []lnUser `json:"nodes"`
}

type lnGraphQLResp struct {
	Data   json.RawMessage `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors,omitempty"`
}

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

const getIssueQuery = `query GetIssue($id: String!) {
  issue(id: $id) {
    identifier
    title
    description
    url
    state { type name }
    labels { nodes { name } }
    assignee { displayName name }
  }
}`

// Get fetches one issue by its Linear identifier (e.g. "ENG-123").
func (t *Tracker) Get(ctx context.Context, id domain.TrackerID) (domain.Issue, error) {
	if id.Provider != domain.TrackerProviderLinear {
		return domain.Issue{}, fmt.Errorf("%w: provider=%q", ErrWrongProvider, id.Provider)
	}
	native := strings.TrimSpace(id.Native)
	if native == "" {
		return domain.Issue{}, fmt.Errorf("%w: empty native id", ErrBadID)
	}
	var resp struct {
		Issue *lnIssue `json:"issue"`
	}
	if err := t.query(ctx, getIssueQuery, map[string]any{"id": native}, &resp); err != nil {
		return domain.Issue{}, err
	}
	if resp.Issue == nil {
		return domain.Issue{}, fmt.Errorf("%w: %s", ErrNotFound, native)
	}
	return issueFromLN(*resp.Issue), nil
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const listIssuesQuery = `query ListIssues($filter: IssueFilter!, $first: Int!) {
  issues(filter: $filter, first: $first) {
    nodes {
      identifier
      title
      description
      url
      state { type name }
      labels { nodes { name } }
      assignee { displayName name }
    }
  }
}`

// List returns issues for a Linear team key. The IssueFilter is composed from
// the team key, state coarse filter, labels, and assignee — all optional.
func (t *Tracker) List(ctx context.Context, repo domain.TrackerRepo, filter domain.ListFilter) ([]domain.Issue, error) {
	if repo.Provider != domain.TrackerProviderLinear {
		return nil, fmt.Errorf("%w: provider=%q", ErrWrongProvider, repo.Provider)
	}
	team := strings.TrimSpace(repo.Native)
	if team == "" {
		return nil, fmt.Errorf("%w: empty team key", ErrBadID)
	}

	issueFilter := map[string]any{
		"team": map[string]any{"key": map[string]any{"eq": team}},
	}
	if states := listStateTypes(filter.State); len(states) > 0 {
		issueFilter["state"] = map[string]any{"type": map[string]any{"in": states}}
	}
	if len(filter.Labels) > 0 {
		issueFilter["labels"] = map[string]any{"name": map[string]any{"in": filter.Labels}}
	}
	if a := strings.TrimSpace(filter.Assignee); a != "" && a != "*" {
		issueFilter["assignee"] = map[string]any{"displayName": map[string]any{"eq": a}}
	}

	limit := filter.Limit
	if limit <= 0 {
		limit = defaultListLimit
	}
	if limit > maxListLimit {
		limit = maxListLimit
	}

	var resp struct {
		Issues struct {
			Nodes []lnIssue `json:"nodes"`
		} `json:"issues"`
	}
	if err := t.query(ctx, listIssuesQuery, map[string]any{"filter": issueFilter, "first": limit}, &resp); err != nil {
		return nil, err
	}
	out := make([]domain.Issue, 0, len(resp.Issues.Nodes))
	for _, raw := range resp.Issues.Nodes {
		out = append(out, issueFromLN(raw))
	}
	return out, nil
}

// listStateTypes maps the coarse open/closed/all filter onto Linear's set of
// workflow state types.
func listStateTypes(state domain.ListStateFilter) []string {
	switch state {
	case domain.ListOpen:
		return []string{"backlog", "unstarted", "triage", "started"}
	case domain.ListClosed:
		return []string{"completed", "cancelled"}
	default:
		return nil
	}
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const preflightQuery = `query Viewer { viewer { id } }`

// Preflight verifies the token by issuing a viewer query.
func (t *Tracker) Preflight(ctx context.Context) error {
	var resp struct {
		Viewer struct {
			ID string `json:"id"`
		} `json:"viewer"`
	}
	return t.query(ctx, preflightQuery, nil, &resp)
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

func issueFromLN(raw lnIssue) domain.Issue {
	labels := make([]string, 0, len(raw.Labels.Nodes))
	for _, l := range raw.Labels.Nodes {
		if name := strings.TrimSpace(l.Name); name != "" {
			labels = append(labels, name)
		}
	}
	var assignees []string
	if raw.Assignee != nil {
		if name := pickDisplay(*raw.Assignee); name != "" {
			assignees = append(assignees, name)
		}
	}
	for _, u := range raw.Assignees.Nodes {
		if name := pickDisplay(u); name != "" {
			assignees = append(assignees, name)
		}
	}
	out := domain.Issue{
		ID: domain.TrackerID{
			Provider: domain.TrackerProviderLinear,
			Native:   strings.TrimSpace(raw.Identifier),
		},
		Title:     raw.Title,
		Body:      raw.Description,
		State:     mapStateFromLinear(raw.State.Type),
		URL:       raw.URL,
		Labels:    labels,
		Assignees: assignees,
	}
	if len(out.Labels) == 0 {
		out.Labels = nil
	}
	if len(out.Assignees) == 0 {
		out.Assignees = nil
	}
	return out
}

func pickDisplay(u lnUser) string {
	if name := strings.TrimSpace(u.DisplayName); name != "" {
		return name
	}
	return strings.TrimSpace(u.Name)
}

// mapStateFromLinear projects Linear's workflow-state type onto the normalized
// cross-provider state vocabulary.
func mapStateFromLinear(stateType string) domain.NormalizedIssueState {
	switch strings.ToLower(strings.TrimSpace(stateType)) {
	case "started":
		return domain.IssueInProgress
	case "completed":
		return domain.IssueDone
	case "cancelled", "canceled":
		return domain.IssueCancelled
	default:
		return domain.IssueOpen
	}
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

func (t *Tracker) query(ctx context.Context, query string, variables map[string]any, out any) error {
	payload := map[string]any{"query": query}
	if variables != nil {
		payload["variables"] = variables
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("linear tracker: encode request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.baseURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("linear tracker: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", t.userAgent)
	tok, err := t.tokens.Token(ctx)
	if err != nil {
		return err
	}
	// Linear personal API keys go as the raw header value; OAuth tokens carry
	// the "Bearer " prefix already. Either way the token is passed through opaque.
	req.Header.Set("Authorization", tok)

	resp, err := t.http.Do(req)
	if err != nil {
		return fmt.Errorf("linear tracker: POST: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return fmt.Errorf("linear tracker: read response: %w", readErr)
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return fmt.Errorf("%w: %s", ErrAuthFailed, strings.TrimSpace(string(respBody)))
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("linear tracker: %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	var gql lnGraphQLResp
	if err := json.Unmarshal(respBody, &gql); err != nil {
		return fmt.Errorf("linear tracker: decode response: %w", err)
	}
	if len(gql.Errors) > 0 {
		return fmt.Errorf("linear tracker: graphql error: %s", gql.Errors[0].Message)
	}
	if out != nil && len(gql.Data) > 0 {
		if err := json.Unmarshal(gql.Data, out); err != nil {
			return fmt.Errorf("linear tracker: decode data: %w", err)
		}
	}
	return nil
}
