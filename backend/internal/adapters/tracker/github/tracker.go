package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	defaultBaseURL   = "https://api.github.com"
	defaultUserAgent = "ao-agent-orchestrator/tracker-github"

	// Status labels used by humans (and other tooling) on GitHub Issues.
	// Get's reverse mapping recognizes them so an externally-labeled issue
	// reports as in_progress / review. The adapter does NOT write these
	// labels in v1 — see issue #40 for the write-side work.
	labelInProgress = "in-progress"
	labelInReview   = "in-review"

	stateClosedGH = "closed"
	reasonNotPlan = "not_planned"

	// List pagination — GitHub's per_page maxes at 100. ListFilter.Limit is
	// an optional total-result cap; page size stays at the provider max.
	listPageSize = 100
	// Guard against a pathological Link cycle. At GitHub's max page size this
	// still permits a 5k-issue intake sweep before failing loud.
	maxListPages = 50
)

// Sentinel errors. Adapter-level callers should match on these via
// errors.Is; the orchestrator's lifecycle code is intentionally insulated
// from raw HTTP status codes.
var (
	ErrNotFound      = errors.New("github tracker: issue not found")
	ErrRateLimited   = errors.New("github tracker: rate limited")
	ErrAuthFailed    = errors.New("github tracker: authentication failed")
	ErrWrongProvider = errors.New("github tracker: id is not a github tracker id")
	ErrBadID         = errors.New("github tracker: malformed native id")
)

// RateLimitError is returned when GitHub reports the request was rate-limited.
// Callers that want to back off intelligently can extract ResetAt /
// RetryAfter via errors.As; callers that only need the category can use
// errors.Is(err, ErrRateLimited).
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
		return "github tracker: rate limited: " + e.Message
	}
	return ErrRateLimited.Error()
}

// Is lets errors.Is match a *RateLimitError against the ErrRateLimited sentinel.
func (e *RateLimitError) Is(target error) bool { return target == ErrRateLimited }

// Options configures a Tracker. All fields except Token are optional —
// production code typically sets Token alone; tests inject HTTPClient and
// BaseURL to point at an httptest fake.
type Options struct {
	Token      TokenSource
	HTTPClient *http.Client
	BaseURL    string
	UserAgent  string
}

// Tracker implements ports.Tracker against the GitHub REST API.
//
// Construction performs a fail-fast token presence check (no network call).
// The first AuthenticatedUser or Preflight call validates the token against
// GitHub and caches the returned identity. Failures are intentionally not
// cached so a transient startup glitch remains recoverable.
type Tracker struct {
	http      *http.Client
	tokens    TokenSource
	baseURL   string
	userAgent string

	// listCache stores one entry per distinct List request path. The key
	// space is naturally bounded by intake-enabled repo/filter pairs, so no
	// eviction is needed here.
	listCacheMu sync.Mutex
	listCache   map[string]listCacheEntry
	labelCache  map[string]labelCacheEntry

	// identityMu serializes the one-time GET /user call and protects the cached
	// identity so the observer and API can share one adapter safely.
	identityMu        sync.Mutex
	authenticatedUser *domain.TrackerUser
}

type listCacheEntry struct {
	etag     string
	issues   []domain.Issue
	nextPath string
}

type labelCacheEntry struct {
	etag     string
	labels   []domain.TrackerLabel
	nextPath string
}

// New returns a Tracker. It fails fast when no token can be obtained so
// daemons crash at startup rather than at first issue lookup.
func New(opts Options) (*Tracker, error) {
	src := opts.Token
	if src == nil {
		return nil, ErrNoToken
	}
	if _, err := src.Token(context.Background()); err != nil {
		return nil, err
	}
	t := &Tracker{
		http:       opts.HTTPClient,
		tokens:     src,
		baseURL:    opts.BaseURL,
		userAgent:  opts.UserAgent,
		listCache:  map[string]listCacheEntry{},
		labelCache: map[string]labelCacheEntry{},
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

// Statically assert Tracker satisfies the port. If this stops compiling, the
// port shape changed and the adapter needs to follow.
var _ ports.Tracker = (*Tracker)(nil)

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

// ghIssue is the subset of fields we read off the REST issue payload.
// PullRequest is present (non-nil) iff GitHub considers this row a PR —
// the /repos/{o}/{r}/issues endpoint conflates the two. List uses it to
// filter PRs out client-side so the SM never sees a PR number as an issue.
type ghIssue struct {
	Number      int              `json:"number"`
	Title       string           `json:"title"`
	Body        string           `json:"body"`
	State       string           `json:"state"`
	StateReason string           `json:"state_reason"`
	HTMLURL     string           `json:"html_url"`
	Labels      []ghLabel        `json:"labels"`
	Assignees   []ghUser         `json:"assignees"`
	PullRequest *json.RawMessage `json:"pull_request,omitempty"`
}

type ghLabel struct {
	Name        string `json:"name"`
	Color       string `json:"color"`
	Description string `json:"description"`
}

type ghUser struct {
	Login string `json:"login"`
}

// Get fetches a single issue by id and maps it onto the normalized domain.Issue.
func (t *Tracker) Get(ctx context.Context, id domain.TrackerID) (domain.Issue, error) {
	owner, repo, number, err := t.parseID(id)
	if err != nil {
		return domain.Issue{}, err
	}
	path := fmt.Sprintf("/repos/%s/%s/issues/%d", owner, repo, number)

	resp, err := t.do(ctx, http.MethodGet, path, nil)
	if err != nil {
		return domain.Issue{}, err
	}
	var raw ghIssue
	if err := json.Unmarshal(resp, &raw); err != nil {
		return domain.Issue{}, fmt.Errorf("github tracker: decode issue: %w", err)
	}
	return issueFromGH(owner, repo, raw), nil
}

// issueFromGH projects a raw GitHub issue payload into the normalized
// domain.Issue. owner and repo are passed in because the TrackerID.Native
// shape is "owner/repo#N" and we want the returned ID to round-trip
// through the same adapter even if the original caller used a zero
// Provider.
func issueFromGH(owner, repo string, raw ghIssue) domain.Issue {
	labels := make([]string, 0, len(raw.Labels))
	for _, l := range raw.Labels {
		labels = append(labels, l.Name)
	}
	assignees := make([]string, 0, len(raw.Assignees))
	for _, a := range raw.Assignees {
		assignees = append(assignees, a.Login)
	}
	out := domain.Issue{
		ID: domain.TrackerID{
			Provider: domain.TrackerProviderGitHub,
			Native:   fmt.Sprintf("%s/%s#%d", owner, repo, raw.Number),
		},
		Title:     raw.Title,
		Body:      raw.Body,
		State:     mapStateFromGitHub(raw.State, raw.StateReason, labels),
		URL:       raw.HTMLURL,
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

// mapStateFromGitHub projects GitHub's open/closed + state_reason + labels
// surface onto the normalized state. "in-review" wins over "in-progress"
// when both labels are present (the workflow is progress -> review -> done).
func mapStateFromGitHub(state, reason string, labels []string) domain.NormalizedIssueState {
	if strings.EqualFold(state, stateClosedGH) {
		if strings.EqualFold(reason, reasonNotPlan) {
			return domain.IssueCancelled
		}
		return domain.IssueDone
	}
	var hasProgress, hasReview bool
	for _, l := range labels {
		switch {
		case strings.EqualFold(l, labelInProgress):
			hasProgress = true
		case strings.EqualFold(l, labelInReview):
			hasReview = true
		}
	}
	switch {
	case hasReview:
		return domain.IssueInReview
	case hasProgress:
		return domain.IssueInProgress
	default:
		return domain.IssueOpen
	}
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

// List returns issues for a repo, filtered by state/labels/assignee. PRs
// that GitHub's /issues endpoint conflates into the response are filtered
// out client-side. GitHub pagination is followed until no next link remains;
// ListFilter.Limit, when set, caps the total accumulated issue count.
func (t *Tracker) List(ctx context.Context, repo domain.TrackerRepo, filter domain.ListFilter) ([]domain.Issue, error) {
	if repo.Provider != domain.TrackerProviderGitHub {
		return nil, fmt.Errorf("%w: provider=%q", ErrWrongProvider, repo.Provider)
	}
	owner, repoName, err := parseGitHubRepo(repo.Native)
	if err != nil {
		return nil, err
	}

	q := url.Values{}
	switch filter.State {
	case domain.ListOpen:
		q.Set("state", "open")
	case domain.ListClosed:
		q.Set("state", "closed")
	default:
		q.Set("state", "all")
	}
	if len(filter.Labels) > 0 {
		q.Set("labels", strings.Join(filter.Labels, ","))
	}
	if filter.Assignee != "" {
		q.Set("assignee", filter.Assignee)
	}
	q.Set("per_page", strconv.Itoa(listPageSize))

	path := fmt.Sprintf("/repos/%s/%s/issues?%s", owner, repoName, q.Encode())
	out := make([]domain.Issue, 0)
	if filter.Limit > 0 {
		out = make([]domain.Issue, 0, filter.Limit)
	}
	for page := 0; path != ""; page++ {
		if page >= maxListPages {
			return nil, fmt.Errorf("github tracker: list pagination exceeded %d pages", maxListPages)
		}
		t.listCacheMu.Lock()
		cached, hasCached := t.listCache[path]
		t.listCacheMu.Unlock()

		resp, etag, nextPath, notModified, err := t.roundTrip(ctx, http.MethodGet, path, nil, cached.etag)
		if err != nil {
			return nil, err
		}
		if notModified {
			if hasCached {
				if etag != "" && etag != cached.etag {
					t.listCacheMu.Lock()
					t.listCache[path] = listCacheEntry{etag: etag, issues: cached.issues, nextPath: cached.nextPath}
					t.listCacheMu.Unlock()
				}
				var done bool
				out, done = appendIssuesWithLimit(out, cloneIssues(cached.issues), filter.Limit)
				if done {
					break
				}
				path = cached.nextPath
				continue
			}
			// A 304 requires a prior validator, but if a server violates that
			// contract, retry unconditionally rather than returning no data.
			resp, etag, nextPath, notModified, err = t.roundTrip(ctx, http.MethodGet, path, nil, "")
			if err != nil {
				return nil, err
			}
			if notModified {
				return nil, fmt.Errorf("github tracker: unexpected 304 for uncached list")
			}
		}
		var raw []ghIssue
		if err := json.Unmarshal(resp, &raw); err != nil {
			return nil, fmt.Errorf("github tracker: decode list: %w", err)
		}
		pageIssues := make([]domain.Issue, 0, len(raw))
		for _, r := range raw {
			if r.PullRequest != nil {
				continue
			}
			pageIssues = append(pageIssues, issueFromGH(owner, repoName, r))
		}
		if etag != "" {
			t.listCacheMu.Lock()
			t.listCache[path] = listCacheEntry{etag: etag, issues: cloneIssues(pageIssues), nextPath: nextPath}
			t.listCacheMu.Unlock()
		} else if hasCached {
			t.listCacheMu.Lock()
			delete(t.listCache, path)
			t.listCacheMu.Unlock()
		}
		var done bool
		out, done = appendIssuesWithLimit(out, pageIssues, filter.Limit)
		if done {
			break
		}
		path = nextPath
	}
	return out, nil
}

func appendIssuesWithLimit(dst, src []domain.Issue, limit int) ([]domain.Issue, bool) {
	if limit <= 0 {
		return append(dst, src...), false
	}
	remaining := limit - len(dst)
	if remaining <= 0 {
		return dst, true
	}
	if len(src) > remaining {
		return append(dst, src[:remaining]...), true
	}
	dst = append(dst, src...)
	return dst, len(dst) >= limit
}

func cloneIssues(in []domain.Issue) []domain.Issue {
	out := make([]domain.Issue, len(in))
	copy(out, in)
	return out
}

// ListLabels returns every label configured on a GitHub repository. Each page
// is conditionally revalidated with its ETag so callers can refresh cheaply.
func (t *Tracker) ListLabels(ctx context.Context, repo domain.TrackerRepo) ([]domain.TrackerLabel, error) {
	if repo.Provider != domain.TrackerProviderGitHub {
		return nil, fmt.Errorf("%w: provider=%q", ErrWrongProvider, repo.Provider)
	}
	owner, repoName, err := parseGitHubRepo(repo.Native)
	if err != nil {
		return nil, err
	}
	path := fmt.Sprintf("/repos/%s/%s/labels?per_page=%d", owner, repoName, listPageSize)
	labels := make([]domain.TrackerLabel, 0)
	for page := 0; path != ""; page++ {
		if page >= maxListPages {
			return nil, fmt.Errorf("github tracker: label pagination exceeded %d pages", maxListPages)
		}
		t.listCacheMu.Lock()
		cached, hasCached := t.labelCache[path]
		t.listCacheMu.Unlock()

		resp, etag, nextPath, notModified, err := t.roundTrip(ctx, http.MethodGet, path, nil, cached.etag)
		if err != nil {
			return nil, err
		}
		if notModified {
			if !hasCached {
				return nil, fmt.Errorf("github tracker: unexpected 304 for uncached labels")
			}
			labels = append(labels, cloneLabels(cached.labels)...)
			path = cached.nextPath
			continue
		}
		var raw []ghLabel
		if err := json.Unmarshal(resp, &raw); err != nil {
			return nil, fmt.Errorf("github tracker: decode labels: %w", err)
		}
		pageLabels := make([]domain.TrackerLabel, 0, len(raw))
		for _, label := range raw {
			if strings.TrimSpace(label.Name) == "" {
				continue
			}
			pageLabels = append(pageLabels, domain.TrackerLabel{
				Name:        label.Name,
				Color:       label.Color,
				Description: label.Description,
			})
		}
		t.listCacheMu.Lock()
		if etag == "" {
			delete(t.labelCache, path)
		} else {
			t.labelCache[path] = labelCacheEntry{etag: etag, labels: cloneLabels(pageLabels), nextPath: nextPath}
		}
		t.listCacheMu.Unlock()
		labels = append(labels, pageLabels...)
		path = nextPath
	}
	return labels, nil
}

func cloneLabels(in []domain.TrackerLabel) []domain.TrackerLabel {
	out := make([]domain.TrackerLabel, len(in))
	copy(out, in)
	return out
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

// AuthenticatedUser returns the login accepted by GitHub's GET /user endpoint.
// Successful checks are cached for the lifetime of the Tracker. Failures are
// not cached so callers can recover from transient GitHub errors.
func (t *Tracker) AuthenticatedUser(ctx context.Context) (domain.TrackerUser, error) {
	t.identityMu.Lock()
	defer t.identityMu.Unlock()
	if t.authenticatedUser != nil {
		return *t.authenticatedUser, nil
	}
	body, err := t.do(ctx, http.MethodGet, "/user", nil)
	if err != nil {
		return domain.TrackerUser{}, err
	}
	var user domain.TrackerUser
	if err := json.Unmarshal(body, &user); err != nil {
		return domain.TrackerUser{}, fmt.Errorf("github tracker: decode authenticated user: %w", err)
	}
	user.Login = strings.TrimSpace(user.Login)
	if user.Login == "" {
		return domain.TrackerUser{}, errors.New("github tracker: authenticated user response has no login")
	}
	t.authenticatedUser = &user
	return user, nil
}

// Preflight verifies the configured token is currently accepted by GitHub
// (one GET /user). It does NOT prove the token has the repo scope or
// visibility needed for any specific Get/List call — those may still fail
// with ErrAuthFailed even after a successful Preflight. The guarantee is
// "token exists and is valid against GitHub's identity endpoint", not
// "token can do everything the SM will ask of it." Per-repo authorization
// is detected lazily at the first Get/List against that repo.
//
// Successful checks share the cached identity used by AuthenticatedUser.
func (t *Tracker) Preflight(ctx context.Context) error {
	_, err := t.AuthenticatedUser(ctx)
	return err
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

func (t *Tracker) do(ctx context.Context, method, path string, body any) ([]byte, error) {
	respBody, _, _, _, err := t.roundTrip(ctx, method, path, body, "")
	return respBody, err
}

func (t *Tracker) roundTrip(ctx context.Context, method, path string, body any, ifNoneMatch string) ([]byte, string, string, bool, error) {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, "", "", false, fmt.Errorf("github tracker: encode body: %w", err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, t.baseURL+path, rdr)
	if err != nil {
		return nil, "", "", false, fmt.Errorf("github tracker: build request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if ifNoneMatch != "" {
		req.Header.Set("If-None-Match", ifNoneMatch)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", t.userAgent)
	tok, err := t.tokens.Token(ctx)
	if err != nil {
		return nil, "", "", false, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)

	resp, err := t.http.Do(req)
	if err != nil {
		return nil, "", "", false, fmt.Errorf("github tracker: %s %s: %w", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	etag := resp.Header.Get("ETag")
	nextPath := parseLinkNext(resp.Header.Get("Link"), t.baseURL)
	if resp.StatusCode == http.StatusNotModified {
		return nil, etag, nextPath, true, nil
	}
	respBody, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return nil, "", "", false, fmt.Errorf("github tracker: read response body: %w", readErr)
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return respBody, etag, nextPath, false, nil
	}
	return respBody, etag, nextPath, false, classifyError(resp, respBody)
}

func parseLinkNext(linkHeader, baseURL string) string {
	for _, part := range strings.Split(linkHeader, ",") {
		part = strings.TrimSpace(part)
		if part == "" || !strings.HasPrefix(part, "<") {
			continue
		}
		urlEnd := strings.Index(part, ">")
		if urlEnd < 0 {
			continue
		}
		rawURL := part[1:urlEnd]
		if !linkHasRelNext(part[urlEnd+1:]) {
			continue
		}
		return relativePathForLink(rawURL, baseURL)
	}
	return ""
}

func linkHasRelNext(params string) bool {
	for _, param := range strings.Split(params, ";") {
		name, value, ok := strings.Cut(strings.TrimSpace(param), "=")
		if !ok || !strings.EqualFold(name, "rel") {
			continue
		}
		value = strings.Trim(value, `"`)
		for _, rel := range strings.Fields(value) {
			if strings.EqualFold(rel, "next") {
				return true
			}
		}
	}
	return false
}

func relativePathForLink(rawLink, baseURL string) string {
	if strings.HasPrefix(rawLink, "/") {
		return rawLink
	}
	base, err := url.Parse(baseURL)
	if err != nil {
		return ""
	}
	u, err := url.Parse(rawLink)
	if err != nil {
		return ""
	}
	if !u.IsAbs() {
		u = base.ResolveReference(u)
	}
	if u.Path == "" {
		return ""
	}
	path := u.EscapedPath()
	if u.RawQuery != "" {
		path += "?" + u.RawQuery
	}
	return path
}

func classifyError(resp *http.Response, body []byte) error {
	msg := githubMessage(body)
	switch resp.StatusCode {
	case http.StatusNotFound:
		return fmt.Errorf("%w: %s", ErrNotFound, msg)
	case http.StatusTooManyRequests:
		return rateLimited(resp, msg)
	case http.StatusUnauthorized:
		// 401 is unambiguously an auth failure. GitHub never uses 401 for
		// rate limiting; that's always 403 or 429.
		return fmt.Errorf("%w: %s", ErrAuthFailed, msg)
	case http.StatusForbidden:
		// GitHub returns 403 for primary rate-limit exhaustion, for
		// secondary/abuse limits, and for genuine auth/permission failures.
		// Disambiguate by signal: primary limit sets X-RateLimit-Remaining=0;
		// secondary/abuse sets Retry-After (often without the Remaining
		// header); either case mentions "rate limit" / "abuse" in the body.
		// Everything else is an auth/permission failure (token missing the
		// right scope, repo not visible to this token, etc).
		if isRateLimited(resp, msg) {
			return rateLimited(resp, msg)
		}
		return fmt.Errorf("%w: %s", ErrAuthFailed, msg)
	}
	return fmt.Errorf("github tracker: %d %s", resp.StatusCode, msg)
}

func isRateLimited(resp *http.Response, msg string) bool {
	if rem := resp.Header.Get("X-RateLimit-Remaining"); rem != "" {
		if n, err := strconv.Atoi(rem); err == nil && n == 0 {
			return true
		}
	}
	if resp.Header.Get("Retry-After") != "" {
		return true
	}
	low := strings.ToLower(msg)
	return strings.Contains(low, "rate limit") || strings.Contains(low, "abuse detection")
}

func rateLimited(resp *http.Response, msg string) error {
	e := &RateLimitError{Message: msg}
	if reset := resp.Header.Get("X-RateLimit-Reset"); reset != "" {
		if sec, err := strconv.ParseInt(reset, 10, 64); err == nil && sec > 0 {
			e.ResetAt = time.Unix(sec, 0)
		}
	}
	if ra := resp.Header.Get("Retry-After"); ra != "" {
		if sec, err := strconv.Atoi(ra); err == nil && sec >= 0 {
			e.RetryAfter = time.Duration(sec) * time.Second
		}
	}
	return e
}

func githubMessage(body []byte) string {
	var p struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &p) == nil && p.Message != "" {
		return p.Message
	}
	return strings.TrimSpace(string(body))
}

// ---------------------------------------------------------------------------
// ID parsing
// ---------------------------------------------------------------------------

func (t *Tracker) parseID(id domain.TrackerID) (owner, repo string, number int, err error) {
	// Strict: the Session Manager picks an adapter by Provider, so reaching
	// this adapter with a non-github Provider is a routing bug, not user
	// input. Empty Provider is treated the same way — it would round-trip
	// to an Issue whose ID can't be re-routed.
	if id.Provider != domain.TrackerProviderGitHub {
		return "", "", 0, fmt.Errorf("%w: provider=%q", ErrWrongProvider, id.Provider)
	}
	return parseGitHubID(id.Native)
}

// parseGitHubID accepts "owner/repo#NUM" and returns the three components.
// Forms like "owner/repo/issues/NUM" or bare numbers are intentionally
// rejected so the rest of the system has one canonical id shape.
func parseGitHubID(native string) (owner, repo string, number int, err error) {
	hash := strings.IndexByte(native, '#')
	if hash < 0 {
		return "", "", 0, fmt.Errorf("%w: missing #issue", ErrBadID)
	}
	repoPart := native[:hash]
	numPart := native[hash+1:]
	owner, repo, err = parseGitHubRepo(repoPart)
	if err != nil {
		return "", "", 0, err
	}
	n, parseErr := strconv.Atoi(numPart)
	if parseErr != nil || n <= 0 {
		return "", "", 0, fmt.Errorf("%w: bad issue number %q", ErrBadID, numPart)
	}
	return owner, repo, n, nil
}

// parseGitHubRepo accepts "owner/repo" and rejects empty segments,
// embedded slashes, "#", and whitespace. Leading dots are kept legal —
// "owner/.github" is a real GitHub convention for repo-level config repos.
func parseGitHubRepo(native string) (owner, repo string, err error) {
	if native == "" {
		return "", "", fmt.Errorf("%w: empty repo", ErrBadID)
	}
	slash := strings.IndexByte(native, '/')
	if slash < 0 {
		return "", "", fmt.Errorf("%w: missing owner/repo separator", ErrBadID)
	}
	owner = native[:slash]
	repo = native[slash+1:]
	if owner == "" || repo == "" {
		return "", "", fmt.Errorf("%w: empty owner or repo segment", ErrBadID)
	}
	if strings.ContainsAny(owner, "/# \t\n\r") {
		return "", "", fmt.Errorf("%w: invalid owner segment %q", ErrBadID, owner)
	}
	if strings.ContainsAny(repo, "/# \t\n\r") {
		return "", "", fmt.Errorf("%w: invalid repo segment %q", ErrBadID, repo)
	}
	return owner, repo, nil
}
