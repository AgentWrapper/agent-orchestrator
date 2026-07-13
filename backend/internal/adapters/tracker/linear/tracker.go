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
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	defaultBaseURL   = "https://api.linear.app/graphql"
	defaultUserAgent = "ao-agent-orchestrator/tracker-linear"

	listPageSize = 100
	maxListPages = 50
)

// Sentinel errors surfaced by the Linear tracker adapter.
var (
	ErrNotFound      = errors.New("linear tracker: issue not found")
	ErrRateLimited   = errors.New("linear tracker: rate limited")
	ErrAuthFailed    = errors.New("linear tracker: authentication failed")
	ErrWrongProvider = errors.New("linear tracker: id is not a linear tracker id")
	ErrBadID         = errors.New("linear tracker: malformed native id")
)

// RateLimitError is returned when Linear reports that a request, endpoint, or
// complexity budget was exhausted.
type RateLimitError struct {
	ResetAt    time.Time
	RetryAfter time.Duration
	Message    string
}

func (e *RateLimitError) Error() string {
	if e == nil {
		return ErrRateLimited.Error()
	}
	if e.Message != "" {
		return "linear tracker: rate limited: " + e.Message
	}
	return ErrRateLimited.Error()
}

// Is reports whether target is ErrRateLimited so errors.Is matches the sentinel.
func (e *RateLimitError) Is(target error) bool { return target == ErrRateLimited }

// RetryAfterDuration returns the server-advised delay before retrying, or 0.
func (e *RateLimitError) RetryAfterDuration() time.Duration {
	if e == nil {
		return 0
	}
	return e.RetryAfter
}

// RateLimitResetAt returns the time the rate limit resets, or the zero time.
func (e *RateLimitError) RateLimitResetAt() time.Time {
	if e == nil {
		return time.Time{}
	}
	return e.ResetAt
}

// Options configures a Tracker. Token is required; tests can inject HTTPClient
// and BaseURL to point at an httptest GraphQL endpoint.
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

	identityMu        sync.Mutex
	authenticatedUser *domain.TrackerUser
}

// New returns a Tracker after verifying that an API key is present.
func New(opts Options) (*Tracker, error) {
	src := opts.Token
	if src == nil {
		return nil, ErrNoToken
	}
	if _, err := src.Token(context.Background()); err != nil {
		return nil, err
	}
	t := &Tracker{
		http:      opts.HTTPClient,
		tokens:    src,
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

// Get fetches one Linear issue by UUID or shorthand identifier.
func (t *Tracker) Get(ctx context.Context, id domain.TrackerID) (domain.Issue, error) {
	if id.Provider != domain.TrackerProviderLinear {
		return domain.Issue{}, fmt.Errorf("%w: provider=%q", ErrWrongProvider, id.Provider)
	}
	native := strings.TrimSpace(id.Native)
	if native == "" {
		return domain.Issue{}, fmt.Errorf("%w: empty issue id", ErrBadID)
	}
	var resp struct {
		Issue linearIssue `json:"issue"`
	}
	if err := t.graphQL(ctx, `query Issue($id: String!) {
		issue(id: $id) {
			id
			identifier
			title
			description
			url
			state { type }
			assignee { id name displayName email }
			labels { nodes { name } }
		}
	}`, map[string]any{"id": native}, &resp); err != nil {
		return domain.Issue{}, err
	}
	if strings.TrimSpace(resp.Issue.ID) == "" {
		return domain.Issue{}, ErrNotFound
	}
	return issueFromLinear(resp.Issue), nil
}

// List returns Linear issues from one team, optionally scoped to an assignee.
func (t *Tracker) List(ctx context.Context, repo domain.TrackerRepo, filter domain.ListFilter) ([]domain.Issue, error) {
	if repo.Provider != domain.TrackerProviderLinear {
		return nil, fmt.Errorf("%w: provider=%q", ErrWrongProvider, repo.Provider)
	}
	teamID := strings.TrimSpace(repo.Native)
	if teamID == "" {
		return nil, fmt.Errorf("%w: empty team id", ErrBadID)
	}
	if len(filter.Labels) > 0 {
		return nil, fmt.Errorf("linear tracker: label filters are not supported")
	}

	query := linearIssuesQuery(filter)
	vars := map[string]any{"teamId": teamID, "first": listPageSize}
	if filter.Assignee != "" {
		vars["assigneeId"] = strings.TrimSpace(filter.Assignee)
	}

	out := make([]domain.Issue, 0)
	if filter.Limit > 0 {
		out = make([]domain.Issue, 0, filter.Limit)
	}
	for page := 0; page < maxListPages; page++ {
		var resp struct {
			Issues struct {
				Nodes    []linearIssue `json:"nodes"`
				PageInfo struct {
					HasNextPage bool   `json:"hasNextPage"`
					EndCursor   string `json:"endCursor"`
				} `json:"pageInfo"`
			} `json:"issues"`
		}
		if err := t.graphQL(ctx, query, vars, &resp); err != nil {
			return nil, err
		}
		for _, raw := range resp.Issues.Nodes {
			out = append(out, issueFromLinear(raw))
			if filter.Limit > 0 && len(out) >= filter.Limit {
				return out, nil
			}
		}
		if !resp.Issues.PageInfo.HasNextPage || strings.TrimSpace(resp.Issues.PageInfo.EndCursor) == "" {
			return out, nil
		}
		vars["after"] = resp.Issues.PageInfo.EndCursor
	}
	return nil, fmt.Errorf("linear tracker: list pagination exceeded %d pages", maxListPages)
}

// AuthenticatedUser returns the Linear user id for assignee filtering.
func (t *Tracker) AuthenticatedUser(ctx context.Context) (domain.TrackerUser, error) {
	t.identityMu.Lock()
	defer t.identityMu.Unlock()
	if t.authenticatedUser != nil {
		return *t.authenticatedUser, nil
	}
	var resp struct {
		Viewer struct {
			ID string `json:"id"`
		} `json:"viewer"`
	}
	if err := t.graphQL(ctx, `query Viewer { viewer { id } }`, nil, &resp); err != nil {
		return domain.TrackerUser{}, err
	}
	user := domain.TrackerUser{Login: strings.TrimSpace(resp.Viewer.ID)}
	if user.Login == "" {
		return domain.TrackerUser{}, errors.New("linear tracker: viewer response has no id")
	}
	t.authenticatedUser = &user
	return user, nil
}

// ListLabels is intentionally unsupported for Linear Phase 1.
func (t *Tracker) ListLabels(context.Context, domain.TrackerRepo) ([]domain.TrackerLabel, error) {
	return nil, fmt.Errorf("%w: labels are not supported by linear intake", ErrWrongProvider)
}

// ListTeams returns teams visible to the configured Linear API key.
func (t *Tracker) ListTeams(ctx context.Context) ([]domain.TrackerTeam, error) {
	teams := make([]domain.TrackerTeam, 0)
	vars := map[string]any{"first": listPageSize}
	for page := 0; page < maxListPages; page++ {
		var resp struct {
			Teams struct {
				Nodes []struct {
					ID   string `json:"id"`
					Key  string `json:"key"`
					Name string `json:"name"`
				} `json:"nodes"`
				PageInfo struct {
					HasNextPage bool   `json:"hasNextPage"`
					EndCursor   string `json:"endCursor"`
				} `json:"pageInfo"`
			} `json:"teams"`
		}
		if err := t.graphQL(ctx, `query Teams($first: Int!, $after: String) {
			teams(first: $first, after: $after) {
				nodes { id key name }
				pageInfo { hasNextPage endCursor }
			}
		}`, vars, &resp); err != nil {
			return nil, err
		}
		for _, team := range resp.Teams.Nodes {
			id := strings.TrimSpace(team.ID)
			name := strings.TrimSpace(team.Name)
			if id == "" || name == "" {
				continue
			}
			teams = append(teams, domain.TrackerTeam{ID: id, Key: strings.TrimSpace(team.Key), Name: name})
		}
		if !resp.Teams.PageInfo.HasNextPage || strings.TrimSpace(resp.Teams.PageInfo.EndCursor) == "" {
			return teams, nil
		}
		vars["after"] = resp.Teams.PageInfo.EndCursor
	}
	return nil, fmt.Errorf("linear tracker: team pagination exceeded %d pages", maxListPages)
}

// Preflight verifies that the API key can resolve the current Linear user.
func (t *Tracker) Preflight(ctx context.Context) error {
	_, err := t.AuthenticatedUser(ctx)
	return err
}

type linearIssue struct {
	ID          string `json:"id"`
	Identifier  string `json:"identifier"`
	Title       string `json:"title"`
	Description string `json:"description"`
	URL         string `json:"url"`
	State       struct {
		Type string `json:"type"`
	} `json:"state"`
	Assignee *struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		DisplayName string `json:"displayName"`
		Email       string `json:"email"`
	} `json:"assignee"`
	Labels struct {
		Nodes []struct {
			Name string `json:"name"`
		} `json:"nodes"`
	} `json:"labels"`
}

func issueFromLinear(raw linearIssue) domain.Issue {
	native := strings.TrimSpace(raw.Identifier)
	if native == "" {
		native = strings.TrimSpace(raw.ID)
	}
	labels := make([]string, 0, len(raw.Labels.Nodes))
	for _, label := range raw.Labels.Nodes {
		if name := strings.TrimSpace(label.Name); name != "" {
			labels = append(labels, name)
		}
	}
	var assignees []string
	if raw.Assignee != nil {
		for _, value := range []string{raw.Assignee.ID, raw.Assignee.DisplayName, raw.Assignee.Name, raw.Assignee.Email} {
			if value = strings.TrimSpace(value); value != "" {
				assignees = append(assignees, value)
			}
		}
	}
	return domain.Issue{
		ID:        domain.TrackerID{Provider: domain.TrackerProviderLinear, Native: native},
		Title:     raw.Title,
		Body:      raw.Description,
		State:     mapStateFromLinear(raw.State.Type),
		URL:       raw.URL,
		Labels:    labels,
		Assignees: assignees,
	}
}

func mapStateFromLinear(stateType string) domain.NormalizedIssueState {
	switch strings.ToLower(strings.TrimSpace(stateType)) {
	case "started":
		return domain.IssueInProgress
	case "completed":
		return domain.IssueDone
	case "canceled":
		return domain.IssueCancelled
	default:
		return domain.IssueOpen
	}
}

func linearIssuesQuery(filter domain.ListFilter) string {
	stateFilter := `state: { type: { in: ["triage", "backlog", "unstarted"] } }`
	if filter.State == domain.ListClosed {
		stateFilter = `state: { type: { in: ["completed", "canceled"] } }`
	}
	if filter.State == domain.ListAll {
		stateFilter = ""
	}
	parts := []string{`team: { id: { eq: $teamId } }`}
	if stateFilter != "" {
		parts = append(parts, stateFilter)
	}
	// team.id and assignee.id filters expect GraphQL ID, not String; declaring
	// these as String! makes Linear reject the whole query with
	// GRAPHQL_VALIDATION_FAILED, so no issues are ever listed.
	vars := `($teamId: ID!, $first: Int!, $after: String)`
	if strings.TrimSpace(filter.Assignee) != "" {
		vars = `($teamId: ID!, $assigneeId: ID!, $first: Int!, $after: String)`
		parts = append(parts, `assignee: { id: { eq: $assigneeId } }`)
	}
	return fmt.Sprintf(`query Issues%s {
		issues(first: $first, after: $after, orderBy: updatedAt, filter: { %s }) {
			nodes {
				id
				identifier
				title
				description
				url
				state { type }
				assignee { id name displayName email }
				labels { nodes { name } }
			}
			pageInfo { hasNextPage endCursor }
		}
	}`, vars, strings.Join(parts, " "))
}

type graphQLRequest struct {
	Query     string         `json:"query"`
	Variables map[string]any `json:"variables,omitempty"`
}

type graphQLResponse struct {
	Data   json.RawMessage `json:"data"`
	Errors []graphQLError  `json:"errors,omitempty"`
}

type graphQLError struct {
	Message    string `json:"message"`
	Extensions struct {
		Code string `json:"code"`
	} `json:"extensions"`
}

func (t *Tracker) graphQL(ctx context.Context, query string, variables map[string]any, out any) error {
	body, err := json.Marshal(graphQLRequest{Query: query, Variables: variables})
	if err != nil {
		return fmt.Errorf("linear tracker: encode graphql request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.baseURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("linear tracker: build graphql request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", t.userAgent)
	tok, err := t.tokens.Token(ctx)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", tok)

	resp, err := t.http.Do(req)
	if err != nil {
		return fmt.Errorf("linear tracker: graphql request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return fmt.Errorf("linear tracker: read graphql response: %w", readErr)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return classifyHTTPError(resp, respBody)
	}
	var envelope graphQLResponse
	if err := json.Unmarshal(respBody, &envelope); err != nil {
		return fmt.Errorf("linear tracker: decode graphql envelope: %w", err)
	}
	if len(envelope.Errors) > 0 {
		return classifyGraphQLErrors(envelope.Errors)
	}
	if len(envelope.Data) == 0 || string(envelope.Data) == "null" {
		return errors.New("linear tracker: graphql response has no data")
	}
	if err := json.Unmarshal(envelope.Data, out); err != nil {
		return fmt.Errorf("linear tracker: decode graphql data: %w", err)
	}
	return nil
}

func classifyHTTPError(resp *http.Response, body []byte) error {
	msg := strings.TrimSpace(string(body))
	switch resp.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Errorf("%w: %s", ErrAuthFailed, msg)
	case http.StatusTooManyRequests:
		return rateLimited(resp, msg)
	case http.StatusNotFound:
		return fmt.Errorf("%w: %s", ErrNotFound, msg)
	default:
		return fmt.Errorf("linear tracker: %d %s", resp.StatusCode, msg)
	}
}

func rateLimited(resp *http.Response, msg string) error {
	e := &RateLimitError{Message: msg}
	if ra := resp.Header.Get("Retry-After"); ra != "" {
		if sec, err := time.ParseDuration(ra + "s"); err == nil && sec >= 0 {
			e.RetryAfter = sec
		}
	}
	for _, name := range []string{
		"X-RateLimit-Requests-Reset",
		"X-RateLimit-Endpoint-Requests-Reset",
		"X-RateLimit-Complexity-Reset",
	} {
		if reset := parseEpochMillis(resp.Header.Get(name)); !reset.IsZero() && reset.After(e.ResetAt) {
			e.ResetAt = reset
		}
	}
	return e
}

func parseEpochMillis(raw string) time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}
	}
	var ms int64
	if _, err := fmt.Sscanf(raw, "%d", &ms); err != nil || ms <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms).UTC()
}

func classifyGraphQLErrors(errs []graphQLError) error {
	messages := make([]string, 0, len(errs))
	for _, err := range errs {
		messages = append(messages, strings.TrimSpace(err.Message))
		switch strings.ToUpper(strings.TrimSpace(err.Extensions.Code)) {
		case "AUTHENTICATION_ERROR", "FORBIDDEN", "UNAUTHORIZED":
			return fmt.Errorf("%w: %s", ErrAuthFailed, strings.Join(messages, "; "))
		case "NOT_FOUND":
			return fmt.Errorf("%w: %s", ErrNotFound, strings.Join(messages, "; "))
		}
	}
	return fmt.Errorf("linear tracker: graphql errors: %s", strings.Join(messages, "; "))
}
