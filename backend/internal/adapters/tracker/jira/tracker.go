// Package jira implements ports.Tracker against Jira Cloud's REST API. The
// project-config scope is the project key plus the Jira site base URL; intake
// constructs a JQL query and maps Jira statusCategory onto NormalizedIssueState.
package jira

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	defaultUserAgent = "ao-agent-orchestrator/tracker-jira"
	defaultListLimit = 30
	maxListLimit     = 100

	searchPath = "/rest/api/3/search"
	issuePath  = "/rest/api/3/issue/"
)

// Sentinels for callers.
var (
	ErrNotFound      = errors.New("jira tracker: issue not found")
	ErrAuthFailed    = errors.New("jira tracker: authentication failed")
	ErrWrongProvider = errors.New("jira tracker: id is not a jira tracker id")
	ErrBadID         = errors.New("jira tracker: malformed native id")
	ErrNoBaseURL     = errors.New("jira tracker: no base URL")
)

// Options mirrors the other tracker adapters. Credentials are required; the
// site BaseURL travels per-call via domain.TrackerRepo.BaseURL so a single
// adapter instance can serve multiple Jira tenants under one account.
type Options struct {
	Credentials CredentialSource
	HTTPClient  *http.Client
	UserAgent   string
}

// Tracker implements ports.Tracker against Jira Cloud REST.
type Tracker struct {
	http      *http.Client
	creds     CredentialSource
	userAgent string
}

// New constructs a Tracker; it fails fast when no credentials can be obtained.
func New(opts Options) (*Tracker, error) {
	if opts.Credentials == nil {
		return nil, ErrNoCredentials
	}
	if _, _, err := opts.Credentials.Credentials(context.Background()); err != nil {
		return nil, err
	}
	t := &Tracker{
		http:      opts.HTTPClient,
		creds:     opts.Credentials,
		userAgent: opts.UserAgent,
	}
	if t.http == nil {
		t.http = &http.Client{Timeout: 30 * time.Second}
	}
	if t.userAgent == "" {
		t.userAgent = defaultUserAgent
	}
	return t, nil
}

var _ ports.Tracker = (*Tracker)(nil)

// ---------------------------------------------------------------------------
// REST DTOs
// ---------------------------------------------------------------------------

type jrIssue struct {
	Key    string   `json:"key"`
	Fields jrFields `json:"fields"`
}

type jrFields struct {
	Summary     string         `json:"summary"`
	Description any            `json:"description"` // Atlassian Document Format or string
	Status      jrStatus       `json:"status"`
	Labels      []string       `json:"labels"`
	Assignee    *jrUser        `json:"assignee"`
	IssueType   *jrIssueType   `json:"issuetype"`
}

type jrStatus struct {
	Name           string             `json:"name"`
	StatusCategory jrStatusCategory   `json:"statusCategory"`
}

type jrStatusCategory struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}

type jrUser struct {
	AccountID    string `json:"accountId"`
	DisplayName  string `json:"displayName"`
	EmailAddress string `json:"emailAddress"`
}

type jrIssueType struct {
	Name string `json:"name"`
}

type jrSearchResp struct {
	Issues []jrIssue `json:"issues"`
}

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

// Get fetches one issue by Jira key (e.g. "ENG-7"). The native id MUST embed
// the Jira site so we know which tenant to query: the canonical form is
// "<baseURL>/browse/<KEY>" or, more conveniently for callers, a TrackerRepo
// with BaseURL set — but Get only sees a TrackerID. We split the BaseURL out
// of TrackerID.Native using the same browse URL convention as the URL field
// we emit; callers wanting a different shape must pre-resolve through List.
func (t *Tracker) Get(ctx context.Context, id domain.TrackerID) (domain.Issue, error) {
	if id.Provider != domain.TrackerProviderJira {
		return domain.Issue{}, fmt.Errorf("%w: provider=%q", ErrWrongProvider, id.Provider)
	}
	baseURL, key, err := splitJiraNative(id.Native)
	if err != nil {
		return domain.Issue{}, err
	}
	var raw jrIssue
	if err := t.get(ctx, baseURL+issuePath+url.PathEscape(key), &raw); err != nil {
		return domain.Issue{}, err
	}
	return issueFromJira(baseURL, raw), nil
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

// List queries Jira's REST search for one project. repo.BaseURL is required;
// repo.Native is the Jira project key.
func (t *Tracker) List(ctx context.Context, repo domain.TrackerRepo, filter domain.ListFilter) ([]domain.Issue, error) {
	if repo.Provider != domain.TrackerProviderJira {
		return nil, fmt.Errorf("%w: provider=%q", ErrWrongProvider, repo.Provider)
	}
	baseURL := normalizeBaseURL(repo.BaseURL)
	if baseURL == "" {
		return nil, ErrNoBaseURL
	}
	projectKey := strings.TrimSpace(repo.Native)
	if projectKey == "" {
		return nil, fmt.Errorf("%w: empty project key", ErrBadID)
	}

	jql := buildJQL(projectKey, filter)
	q := url.Values{}
	q.Set("jql", jql)
	q.Set("fields", "summary,description,status,labels,assignee,issuetype")
	limit := filter.Limit
	if limit <= 0 {
		limit = defaultListLimit
	}
	if limit > maxListLimit {
		limit = maxListLimit
	}
	q.Set("maxResults", strconv.Itoa(limit))

	var resp jrSearchResp
	if err := t.get(ctx, baseURL+searchPath+"?"+q.Encode(), &resp); err != nil {
		return nil, err
	}
	out := make([]domain.Issue, 0, len(resp.Issues))
	for _, raw := range resp.Issues {
		out = append(out, issueFromJira(baseURL, raw))
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

// Preflight cannot run without a base URL. The observer skips Preflight for
// Jira and lets the first List surface auth errors.
func (t *Tracker) Preflight(_ context.Context) error {
	// No-op: Jira has no global identity endpoint without a tenant base URL.
	return nil
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

func issueFromJira(baseURL string, raw jrIssue) domain.Issue {
	labels := make([]string, 0, len(raw.Fields.Labels))
	for _, l := range raw.Fields.Labels {
		if name := strings.TrimSpace(l); name != "" {
			labels = append(labels, name)
		}
	}
	var assignees []string
	if u := raw.Fields.Assignee; u != nil {
		if pick := strings.TrimSpace(u.DisplayName); pick != "" {
			assignees = append(assignees, pick)
		} else if pick := strings.TrimSpace(u.EmailAddress); pick != "" {
			assignees = append(assignees, pick)
		} else if pick := strings.TrimSpace(u.AccountID); pick != "" {
			assignees = append(assignees, pick)
		}
	}
	out := domain.Issue{
		ID: domain.TrackerID{
			Provider: domain.TrackerProviderJira,
			Native:   baseURL + "/browse/" + raw.Key,
		},
		Title:     raw.Fields.Summary,
		Body:      flattenJiraDescription(raw.Fields.Description),
		State:     mapStateFromJira(raw.Fields.Status),
		URL:       baseURL + "/browse/" + raw.Key,
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

// flattenJiraDescription accepts either a plain string or an Atlassian
// Document Format object. ADF is rendered as a best-effort plaintext join of
// its leaf text nodes — enough for the intake prompt without dragging in a
// full ADF dependency.
func flattenJiraDescription(desc any) string {
	switch v := desc.(type) {
	case nil:
		return ""
	case string:
		return v
	case map[string]any:
		var b strings.Builder
		flattenADF(v, &b)
		return strings.TrimSpace(b.String())
	default:
		return ""
	}
}

func flattenADF(node map[string]any, b *strings.Builder) {
	if t, ok := node["text"].(string); ok {
		b.WriteString(t)
	}
	if content, ok := node["content"].([]any); ok {
		for _, child := range content {
			if cm, ok := child.(map[string]any); ok {
				flattenADF(cm, b)
			}
		}
		// Insert paragraph breaks between block nodes for readability.
		if typ, _ := node["type"].(string); typ == "paragraph" || typ == "heading" {
			b.WriteString("\n")
		}
	}
}

func mapStateFromJira(status jrStatus) domain.NormalizedIssueState {
	switch strings.ToLower(strings.TrimSpace(status.StatusCategory.Key)) {
	case "done":
		// Jira distinguishes Done vs Cancelled only via status name; treat the
		// explicit "Cancelled"/"Won't Do" names as cancelled.
		name := strings.ToLower(strings.TrimSpace(status.Name))
		if strings.Contains(name, "cancel") || strings.Contains(name, "won't") || strings.Contains(name, "wont") {
			return domain.IssueCancelled
		}
		return domain.IssueDone
	case "indeterminate":
		return domain.IssueInProgress
	default:
		return domain.IssueOpen
	}
}

// buildJQL composes the JQL search expression. Quoted scalars are escaped
// by doubling embedded quotes so a `"` in a label or assignee can't break out.
func buildJQL(projectKey string, filter domain.ListFilter) string {
	parts := []string{fmt.Sprintf("project = %s", jqlQuote(projectKey))}
	switch filter.State {
	case domain.ListOpen:
		parts = append(parts, "statusCategory != Done")
	case domain.ListClosed:
		parts = append(parts, "statusCategory = Done")
	}
	if len(filter.Labels) > 0 {
		quoted := make([]string, 0, len(filter.Labels))
		for _, l := range filter.Labels {
			quoted = append(quoted, jqlQuote(l))
		}
		parts = append(parts, "labels in ("+strings.Join(quoted, ",")+")")
	}
	if a := strings.TrimSpace(filter.Assignee); a != "" && a != "*" {
		parts = append(parts, fmt.Sprintf("assignee = %s", jqlQuote(a)))
	}
	parts = append(parts, "ORDER BY created DESC")
	return strings.Join(parts, " AND ")
}

func jqlQuote(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"`
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

func (t *Tracker) get(ctx context.Context, fullURL string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fullURL, nil)
	if err != nil {
		return fmt.Errorf("jira tracker: build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", t.userAgent)
	email, token, err := t.creds.Credentials(ctx)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", basicAuth(email, token))

	resp, err := t.http.Do(req)
	if err != nil {
		return fmt.Errorf("jira tracker: GET %s: %w", fullURL, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return fmt.Errorf("jira tracker: read response: %w", readErr)
	}
	switch resp.StatusCode {
	case http.StatusOK:
		if out == nil {
			return nil
		}
		if err := json.Unmarshal(body, out); err != nil {
			return fmt.Errorf("jira tracker: decode response: %w", err)
		}
		return nil
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Errorf("%w: %s", ErrAuthFailed, strings.TrimSpace(string(body)))
	case http.StatusNotFound:
		return fmt.Errorf("%w: %s", ErrNotFound, strings.TrimSpace(string(body)))
	default:
		return fmt.Errorf("jira tracker: %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
}

func basicAuth(email, token string) string {
	creds := email + ":" + token
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(creds))
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

// normalizeBaseURL accepts "acme.atlassian.net" or "https://acme.atlassian.net"
// and returns a canonical "https://acme.atlassian.net" with no trailing slash.
// Empty input returns empty.
func normalizeBaseURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	raw = strings.TrimRight(raw, "/")
	if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") {
		return raw
	}
	return "https://" + raw
}

// splitJiraNative parses Get's id form. Accepts:
//   - "<scheme>://host/browse/KEY-NN"  (the form Get's URL field uses)
//   - "https://host|KEY-NN"            (compact form, pipe-separated)
//
// Both forms make the per-call base URL explicit so Get works without a
// separate TrackerRepo. The second form is for callers that want a stable key
// without URL-encoding ambiguity; observer code uses the first form.
func splitJiraNative(native string) (string, string, error) {
	native = strings.TrimSpace(native)
	if i := strings.LastIndex(native, "|"); i >= 0 {
		base := normalizeBaseURL(native[:i])
		key := strings.TrimSpace(native[i+1:])
		if base == "" || key == "" {
			return "", "", fmt.Errorf("%w: pipe-form missing base or key", ErrBadID)
		}
		return base, key, nil
	}
	idx := strings.Index(native, "/browse/")
	if idx < 0 {
		return "", "", fmt.Errorf("%w: expected /browse/<KEY> form", ErrBadID)
	}
	base := normalizeBaseURL(native[:idx])
	key := strings.TrimSpace(native[idx+len("/browse/"):])
	if base == "" || key == "" {
		return "", "", fmt.Errorf("%w: missing base or key", ErrBadID)
	}
	return base, key, nil
}
