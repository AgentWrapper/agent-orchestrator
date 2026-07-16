// Package gitlab implements the read-only issue tracker port with GitLab's
// REST API.
package gitlab

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	scmgitlab "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/gitlab"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	listPageSize    = 100
	labelInProgress = "in-progress"
	labelInReview   = "in-review"
)

var (
	// ErrNotFound deliberately combines forbidden and missing issue responses so
	// callers cannot use this adapter to probe confidential issue existence.
	ErrNotFound = errors.New("gitlab tracker: issue not found or unavailable")
	// ErrWrongProvider identifies a tracker routing error.
	ErrWrongProvider = errors.New("gitlab tracker: id is not a gitlab tracker id")
	// ErrBadID identifies a malformed canonical issue ID or project path.
	ErrBadID = errors.New("gitlab tracker: malformed native id")
	// ErrAuthFailed is the shared GitLab authentication category.
	ErrAuthFailed = scmgitlab.ErrAuthFailed
	// ErrForbidden is the shared GitLab authorization category.
	ErrForbidden = scmgitlab.ErrForbidden
	// ErrRateLimited is the shared GitLab rate-limit category.
	ErrRateLimited = scmgitlab.ErrRateLimited
)

var errLimitReached = errors.New("gitlab tracker: result limit reached")

// Options configures a Tracker around the connection-scoped GitLab client.
// Host is the canonical connection host, including a non-default port when
// present, but without a URL scheme or path.
type Options struct {
	Client *scmgitlab.Client
	Host   string
}

// Tracker implements ports.Tracker for GitLab issues.
type Tracker struct {
	client *scmgitlab.Client
	host   string
}

var _ ports.Tracker = (*Tracker)(nil)

// New constructs a GitLab issue tracker.
func New(opts Options) (*Tracker, error) {
	if opts.Client == nil {
		return nil, errors.New("gitlab tracker: client is required")
	}
	host := strings.ToLower(strings.TrimSpace(opts.Host))
	if host == "" || strings.ContainsAny(host, "/?#@ \t\n\r") {
		return nil, fmt.Errorf("%w: invalid host", ErrBadID)
	}
	return &Tracker{client: opts.Client, host: host}, nil
}

type issuePayload struct {
	IID         int             `json:"iid"`
	Title       string          `json:"title"`
	Description string          `json:"description"`
	State       string          `json:"state"`
	WebURL      string          `json:"web_url"`
	Labels      []string        `json:"labels"`
	Assignees   []assigneeValue `json:"assignees"`
}

type assigneeValue struct {
	Username string `json:"username"`
}

// Get returns one normalized issue from its canonical GitLab ID.
func (t *Tracker) Get(ctx context.Context, id domain.TrackerID) (domain.Issue, error) {
	project, iid, err := t.parseID(id)
	if err != nil {
		return domain.Issue{}, err
	}
	path := fmt.Sprintf("/projects/%s/issues/%d", scmgitlab.EncodedProjectPath(project), iid)
	var payload issuePayload
	if _, err := t.client.DoJSON(ctx, http.MethodGet, path, nil, nil, &payload); err != nil {
		if errors.Is(err, scmgitlab.ErrForbidden) || errors.Is(err, scmgitlab.ErrNotFound) {
			return domain.Issue{}, ErrNotFound
		}
		return domain.Issue{}, err
	}
	return t.normalizeIssue(project, payload)
}

// List returns issues from all GitLab visibility scopes, following every page
// until exhausted or the requested result limit is satisfied.
func (t *Tracker) List(ctx context.Context, repo domain.TrackerRepo, filter domain.ListFilter) ([]domain.Issue, error) {
	if repo.Provider != domain.TrackerProviderGitLab {
		return nil, fmt.Errorf("%w: provider=%q", ErrWrongProvider, repo.Provider)
	}
	project, err := normalizeProject(repo.Native)
	if err != nil {
		return nil, err
	}

	query := url.Values{
		"scope":    {"all"},
		"state":    {gitlabListState(filter.State)},
		"per_page": {strconv.Itoa(listPageSize)},
	}
	if len(filter.Labels) > 0 {
		query.Set("labels", strings.Join(filter.Labels, ","))
	}
	switch {
	case filter.Assignee == "*":
		query.Set("assignee_id", "Any")
	case strings.EqualFold(filter.Assignee, "none"):
		query.Set("assignee_id", "None")
	case filter.Assignee != "":
		query.Add("assignee_username[]", filter.Assignee)
	}

	issues := make([]domain.Issue, 0)
	if filter.Limit > 0 {
		issues = make([]domain.Issue, 0, filter.Limit)
	}
	path := "/projects/" + scmgitlab.EncodedProjectPath(project) + "/issues"
	err = t.client.GetJSONPages(ctx, path, query, func(body []byte) error {
		var page []issuePayload
		if err := json.Unmarshal(body, &page); err != nil {
			return errors.New("gitlab tracker: decode issue list")
		}
		for _, payload := range page {
			issue, err := t.normalizeIssue(project, payload)
			if err != nil {
				return err
			}
			if !hasAllLabels(issue.Labels, filter.Labels) {
				continue
			}
			issues = append(issues, issue)
			if filter.Limit > 0 && len(issues) >= filter.Limit {
				return errLimitReached
			}
		}
		return nil
	})
	if errors.Is(err, errLimitReached) {
		return issues, nil
	}
	if err != nil {
		return nil, err
	}
	return issues, nil
}

// Preflight verifies that GitLab accepts the configured credential.
func (t *Tracker) Preflight(ctx context.Context) error {
	_, err := t.client.DoJSON(ctx, http.MethodGet, "/user", nil, nil, nil)
	return err
}

func (t *Tracker) parseID(id domain.TrackerID) (string, int, error) {
	if id.Provider != domain.TrackerProviderGitLab {
		return "", 0, fmt.Errorf("%w: provider=%q", ErrWrongProvider, id.Provider)
	}
	prefix := t.host + "/"
	if len(id.Native) <= len(prefix) || !strings.EqualFold(id.Native[:len(prefix)], prefix) {
		return "", 0, fmt.Errorf("%w: host mismatch", ErrBadID)
	}
	remainder := id.Native[len(prefix):]
	delimiter := strings.LastIndex(remainder, "#!")
	if delimiter <= 0 || strings.Contains(remainder[:delimiter], "#!") {
		return "", 0, fmt.Errorf("%w: missing #!iid", ErrBadID)
	}
	project, err := normalizeProject(remainder[:delimiter])
	if err != nil {
		return "", 0, err
	}
	iidText := remainder[delimiter+2:]
	iid, err := strconv.Atoi(iidText)
	if err != nil || iid <= 0 {
		return "", 0, fmt.Errorf("%w: invalid iid", ErrBadID)
	}
	return project, iid, nil
}

func (t *Tracker) normalizeIssue(project string, payload issuePayload) (domain.Issue, error) {
	if payload.IID <= 0 {
		return domain.Issue{}, errors.New("gitlab tracker: issue response has invalid iid")
	}
	state, err := normalizeState(payload.State, payload.Labels)
	if err != nil {
		return domain.Issue{}, err
	}
	assignees := make([]string, 0, len(payload.Assignees))
	for _, assignee := range payload.Assignees {
		if assignee.Username != "" {
			assignees = append(assignees, assignee.Username)
		}
	}
	labels := append([]string(nil), payload.Labels...)
	if len(labels) == 0 {
		labels = nil
	}
	if len(assignees) == 0 {
		assignees = nil
	}
	return domain.Issue{
		ID: domain.TrackerID{
			Provider: domain.TrackerProviderGitLab,
			Native:   fmt.Sprintf("%s/%s#!%d", t.host, project, payload.IID),
		},
		Title:     payload.Title,
		Body:      payload.Description,
		State:     state,
		URL:       payload.WebURL,
		Labels:    labels,
		Assignees: assignees,
	}, nil
}

func normalizeState(state string, labels []string) (domain.NormalizedIssueState, error) {
	switch strings.ToLower(state) {
	case "closed":
		return domain.IssueDone, nil
	case "opened", "open":
		var inProgress bool
		for _, label := range labels {
			switch {
			case strings.EqualFold(label, labelInReview):
				return domain.IssueInReview, nil
			case strings.EqualFold(label, labelInProgress):
				inProgress = true
			}
		}
		if inProgress {
			return domain.IssueInProgress, nil
		}
		return domain.IssueOpen, nil
	default:
		return "", errors.New("gitlab tracker: unsupported issue state")
	}
}

func gitlabListState(state domain.ListStateFilter) string {
	switch state {
	case domain.ListOpen:
		return "opened"
	case domain.ListClosed:
		return "closed"
	default:
		return "all"
	}
}

func hasAllLabels(actual, required []string) bool {
	for _, wanted := range required {
		matched := false
		for _, label := range actual {
			if strings.EqualFold(label, wanted) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	return true
}

func normalizeProject(native string) (string, error) {
	if native != strings.TrimSpace(native) {
		return "", fmt.Errorf("%w: invalid project", ErrBadID)
	}
	project := strings.TrimSuffix(native, ".git")
	if project == "" {
		return "", fmt.Errorf("%w: invalid project", ErrBadID)
	}
	if strings.ContainsAny(project, "\\:#!? \t\n\r") {
		return "", fmt.Errorf("%w: invalid project", ErrBadID)
	}
	parts := strings.Split(project, "/")
	if len(parts) < 2 {
		return "", fmt.Errorf("%w: project requires namespace", ErrBadID)
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return "", fmt.Errorf("%w: invalid project segment", ErrBadID)
		}
	}
	return project, nil
}
