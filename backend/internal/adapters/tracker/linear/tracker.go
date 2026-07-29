// Package linear implements AO's read-only tracker port against Linear's
// GraphQL API.
package linear

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	defaultBaseURL  = "https://api.linear.app/graphql"
	defaultPageSize = 50
	maxListPages    = 100

	issueFields = `
		id
		title
		description
		url
		state { type name }
		labels { nodes { name } }
		assignee { name }
	`
)

// Sentinel errors returned by the Linear adapter.
var (
	ErrNoAPIKey      = errors.New("linear tracker: AO_LINEAR_API_KEY is not configured")
	ErrNotFound      = errors.New("linear tracker: issue or scope not found")
	ErrAuthFailed    = errors.New("linear tracker: authentication failed")
	ErrRateLimited   = errors.New("linear tracker: rate limited")
	ErrWrongProvider = errors.New("linear tracker: id is not a linear tracker id")
	ErrBadScope      = errors.New(`linear tracker: scope must be "team:<id>" or "project:<id>"`)
)

// Options configures a Tracker. Tests use BaseURL and HTTPClient to point at an
// httptest server; production reads APIKey from AO_LINEAR_API_KEY.
type Options struct {
	APIKey     string
	BaseURL    string
	HTTPClient *http.Client
}

// Tracker implements the read-only tracker port using GraphQL queries only.
type Tracker struct {
	apiKey  string
	baseURL string
	http    *http.Client

	preflightOK atomic.Bool
	preflightMu sync.Mutex
}

// New constructs a Linear tracker without making a network request.
func New(opts Options) (*Tracker, error) {
	apiKey := strings.TrimSpace(opts.APIKey)
	if apiKey == "" {
		apiKey = strings.TrimSpace(os.Getenv("AO_LINEAR_API_KEY"))
	}
	if apiKey == "" {
		return nil, ErrNoAPIKey
	}
	baseURL := strings.TrimSpace(opts.BaseURL)
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &Tracker{apiKey: apiKey, baseURL: baseURL, http: client}, nil
}

var _ ports.Tracker = (*Tracker)(nil)

// Get returns one normalized issue. Linear accepts either its stable UUID or a
// human identifier such as AO-17; the returned native id is always the UUID.
func (t *Tracker) Get(ctx context.Context, id domain.TrackerID) (domain.Issue, error) {
	if id.Provider != domain.TrackerProviderLinear {
		return domain.Issue{}, fmt.Errorf("%w: provider=%q", ErrWrongProvider, id.Provider)
	}
	native := strings.TrimSpace(id.Native)
	if native == "" {
		return domain.Issue{}, ErrNotFound
	}
	var data struct {
		Issue *linearIssue `json:"issue"`
	}
	query := `query Issue($id: String!) { issue(id: $id) {` + issueFields + `} }`
	if err := t.do(ctx, query, map[string]any{"id": native}, &data); err != nil {
		return domain.Issue{}, err
	}
	if data.Issue == nil {
		return domain.Issue{}, ErrNotFound
	}
	return issueFromLinear(*data.Issue), nil
}

// List returns normalized issues from a Linear team or project scope.
func (t *Tracker) List(ctx context.Context, scope domain.TrackerScope, filter domain.ListFilter) ([]domain.Issue, error) {
	if scope.Provider != domain.TrackerProviderLinear {
		return nil, fmt.Errorf("%w: provider=%q", ErrWrongProvider, scope.Provider)
	}
	kind, scopeID, err := parseScope(scope.Native)
	if err != nil {
		return nil, err
	}
	query := listQuery(kind)
	var (
		after   any
		issues  []domain.Issue
		cursors = map[string]bool{}
	)
	for page := 0; page < maxListPages; page++ {
		var data listData
		if err := t.do(ctx, query, map[string]any{
			"scope": scopeID,
			"first": defaultPageSize,
			"after": after,
		}, &data); err != nil {
			return nil, err
		}
		connection := data.connection(kind)
		if connection == nil {
			return nil, ErrNotFound
		}
		for _, raw := range connection.Nodes {
			issue := issueFromLinear(raw)
			if matchesFilter(issue, filter) {
				issues = append(issues, issue)
				if filter.Limit > 0 && len(issues) >= filter.Limit {
					return issues[:filter.Limit], nil
				}
			}
		}
		if !connection.PageInfo.HasNextPage {
			return issues, nil
		}
		if connection.PageInfo.EndCursor == nil || *connection.PageInfo.EndCursor == "" || cursors[*connection.PageInfo.EndCursor] {
			return nil, errors.New("linear tracker: invalid pagination cursor")
		}
		cursors[*connection.PageInfo.EndCursor] = true
		after = *connection.PageInfo.EndCursor
	}
	return nil, fmt.Errorf("linear tracker: pagination exceeded %d pages", maxListPages)
}

// Preflight verifies AO_LINEAR_API_KEY by querying the authenticated viewer.
// Successful validation is cached; failures remain retryable.
func (t *Tracker) Preflight(ctx context.Context) error {
	if t.preflightOK.Load() {
		return nil
	}
	t.preflightMu.Lock()
	defer t.preflightMu.Unlock()
	if t.preflightOK.Load() {
		return nil
	}
	var data struct {
		Viewer *struct {
			ID string `json:"id"`
		} `json:"viewer"`
	}
	if err := t.do(ctx, `query Viewer { viewer { id } }`, nil, &data); err != nil {
		return err
	}
	if data.Viewer == nil || data.Viewer.ID == "" {
		return ErrAuthFailed
	}
	t.preflightOK.Store(true)
	return nil
}

type linearIssue struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	URL         string `json:"url"`
	State       struct {
		Type string `json:"type"`
		Name string `json:"name"`
	} `json:"state"`
	Labels struct {
		Nodes []struct {
			Name string `json:"name"`
		} `json:"nodes"`
	} `json:"labels"`
	Assignee *struct {
		Name string `json:"name"`
	} `json:"assignee"`
}

type issueConnection struct {
	Nodes    []linearIssue `json:"nodes"`
	PageInfo struct {
		HasNextPage bool    `json:"hasNextPage"`
		EndCursor   *string `json:"endCursor"`
	} `json:"pageInfo"`
}

type listData struct {
	Team *struct {
		Issues issueConnection `json:"issues"`
	} `json:"team"`
	Project *struct {
		Issues issueConnection `json:"issues"`
	} `json:"project"`
}

func (d listData) connection(kind string) *issueConnection {
	if kind == "team" && d.Team != nil {
		return &d.Team.Issues
	}
	if kind == "project" && d.Project != nil {
		return &d.Project.Issues
	}
	return nil
}

func issueFromLinear(raw linearIssue) domain.Issue {
	labels := make([]string, 0, len(raw.Labels.Nodes))
	for _, label := range raw.Labels.Nodes {
		if label.Name != "" {
			labels = append(labels, label.Name)
		}
	}
	var assignees []string
	if raw.Assignee != nil && raw.Assignee.Name != "" {
		assignees = []string{raw.Assignee.Name}
	}
	return domain.Issue{
		ID:        domain.TrackerID{Provider: domain.TrackerProviderLinear, Native: raw.ID},
		Title:     raw.Title,
		Body:      raw.Description,
		State:     mapState(raw.State.Type, raw.State.Name),
		URL:       raw.URL,
		Labels:    labels,
		Assignees: assignees,
	}
}

func mapState(stateType, name string) domain.NormalizedIssueState {
	switch strings.ToLower(strings.TrimSpace(stateType)) {
	case "completed":
		return domain.IssueDone
	case "canceled", "cancelled":
		return domain.IssueCancelled
	case "started":
		if strings.Contains(strings.ToLower(name), "review") {
			return domain.IssueInReview
		}
		return domain.IssueInProgress
	default:
		return domain.IssueOpen
	}
}

func matchesFilter(issue domain.Issue, filter domain.ListFilter) bool {
	switch filter.State {
	case domain.ListOpen:
		if issue.State == domain.IssueDone || issue.State == domain.IssueCancelled {
			return false
		}
	case domain.ListClosed:
		if issue.State != domain.IssueDone && issue.State != domain.IssueCancelled {
			return false
		}
	}
	for _, label := range filter.Labels {
		if !containsFold(issue.Labels, label) {
			return false
		}
	}
	assignee := strings.TrimSpace(filter.Assignee)
	switch {
	case assignee == "":
		return true
	case assignee == "*":
		return len(issue.Assignees) > 0
	case strings.EqualFold(assignee, "none"):
		return len(issue.Assignees) == 0
	default:
		return containsFold(issue.Assignees, assignee)
	}
}

func containsFold(values []string, needle string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), strings.TrimSpace(needle)) {
			return true
		}
	}
	return false
}

func parseScope(native string) (kind, id string, err error) {
	native = strings.TrimSpace(native)
	kind, id, ok := strings.Cut(native, ":")
	if !ok || (kind != "team" && kind != "project") || strings.TrimSpace(id) == "" {
		return "", "", ErrBadScope
	}
	return kind, strings.TrimSpace(id), nil
}

func listQuery(kind string) string {
	return `query Issues($scope: String!, $first: Int!, $after: String) {
		` + kind + `(id: $scope) {
			issues(first: $first, after: $after) {
				nodes {` + issueFields + `}
				pageInfo { hasNextPage endCursor }
			}
		}
	}`
}

type graphqlEnvelope struct {
	Data   json.RawMessage `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

func (t *Tracker) do(ctx context.Context, query string, variables map[string]any, out any) error {
	body, err := json.Marshal(map[string]any{"query": query, "variables": variables})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.baseURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", t.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := t.http.Do(req)
	if err != nil {
		return fmt.Errorf("linear tracker: request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	payload, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return fmt.Errorf("linear tracker: read response: %w", err)
	}
	switch resp.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return ErrAuthFailed
	case http.StatusTooManyRequests:
		return ErrRateLimited
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("linear tracker: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(payload)))
	}
	var envelope graphqlEnvelope
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return fmt.Errorf("linear tracker: decode response: %w", err)
	}
	if len(envelope.Errors) > 0 {
		message := envelope.Errors[0].Message
		lower := strings.ToLower(message)
		switch {
		case strings.Contains(lower, "auth"), strings.Contains(lower, "unauthorized"), strings.Contains(lower, "api key"):
			return fmt.Errorf("%w: %s", ErrAuthFailed, message)
		case strings.Contains(lower, "rate limit"):
			return fmt.Errorf("%w: %s", ErrRateLimited, message)
		default:
			return fmt.Errorf("linear tracker: graphql: %s", message)
		}
	}
	if err := json.Unmarshal(envelope.Data, out); err != nil {
		return fmt.Errorf("linear tracker: decode data: %w", err)
	}
	return nil
}
