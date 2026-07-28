package github

// This file contains the GitHub implementation of the provider-neutral SCM observer contract.
// It handles repository parsing, REST ETag guards, branch PR discovery, GraphQL
// batch PR reads, failed-check log tails, and review-thread pagination.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const scmBatchCheckContextLimit = 20

const (
	// githubReviewThreadPageSize fetches the latest review window cheaply for
	// the common case while still covering active review feedback.
	githubReviewThreadPageSize = 50
	// githubReviewCommentLimitPerThread stores only the leading comments needed
	// to understand a thread without making one pathological thread dominate
	// GraphQL cost.
	githubReviewCommentLimitPerThread = 5
	// githubReviewThreadMaxPages bounds the explicit older-thread fallback.
	githubReviewThreadMaxPages = 2
	// githubReviewSummaryLimit bounds submitted decisive reviews used for summary links.
	githubReviewSummaryLimit = 20
)

// ParseRepository normalizes a GitHub remote/origin URL into a provider-neutral
// repository key. It accepts https://github.com/owner/repo(.git),
// git@github.com:owner/repo(.git), and path-only owner/repo inputs used by tests.
func (p *Provider) ParseRepository(remote string) (ports.SCMRepo, bool) {
	repo, ok := parseGitHubRepo(remote)
	return repo, ok
}

// RepoPRListGuard checks GitHub's cheap open-PR-list ETag guard.
func (p *Provider) RepoPRListGuard(ctx context.Context, repo ports.SCMRepo, etag string) (ports.SCMGuardResult, error) {
	q := url.Values{}
	q.Set("state", "open")
	q.Set("sort", "updated")
	q.Set("direction", "desc")
	q.Set("per_page", "1")
	resp, err := p.client.doRESTWithETag(ctx, repoPath(repo.Owner, repo.Name, "pulls"), q, etag)
	if err != nil {
		return ports.SCMGuardResult{}, err
	}
	return ports.SCMGuardResult{ETag: firstNonEmptyHeader(resp.ETag, etag), NotModified: resp.NotModified}, nil
}

// ListOpenPRsByRepo lists every open pull request in the repository so the
// observer can attribute each to a session by head-branch prefix. It paginates
// the REST pulls endpoint; AO repos are not expected to carry thousands of
// concurrent open PRs, and the observer only calls this when the repo PR-list
// ETag guard reports a change.
func (p *Provider) ListOpenPRsByRepo(ctx context.Context, repo ports.SCMRepo) ([]ports.SCMPRObservation, error) {
	const perPage = 100
	out := []ports.SCMPRObservation{}
	for page := 1; ; page++ {
		q := url.Values{}
		q.Set("state", "open")
		q.Set("sort", "updated")
		q.Set("direction", "desc")
		q.Set("per_page", strconv.Itoa(perPage))
		q.Set("page", strconv.Itoa(page))
		resp, err := p.client.doREST(ctx, http.MethodGet, repoPath(repo.Owner, repo.Name, "pulls"), q, nil)
		if err != nil {
			return nil, err
		}
		var pulls []restListPull
		if err := json.Unmarshal(resp.Body, &pulls); err != nil {
			return nil, fmt.Errorf("github scm: decode open PR list: %w", err)
		}
		for _, pull := range pulls {
			out = append(out, restListPullToSCM(pull))
		}
		if len(pulls) < perPage {
			return out, nil
		}
	}
}

// CommitChecksGuard checks GitHub's per-commit check-runs ETag guard.
func (p *Provider) CommitChecksGuard(ctx context.Context, repo ports.SCMRepo, headSHA, etag string) (ports.SCMGuardResult, error) {
	if strings.TrimSpace(headSHA) == "" {
		return ports.SCMGuardResult{}, fmt.Errorf("%w: empty head sha", ErrNotFound)
	}
	q := url.Values{}
	q.Set("per_page", "1")
	resp, err := p.client.doRESTWithETag(ctx, repoPath(repo.Owner, repo.Name, "commits", headSHA, "check-runs"), q, etag)
	if err != nil {
		return ports.SCMGuardResult{}, err
	}
	return ports.SCMGuardResult{ETag: firstNonEmptyHeader(resp.ETag, etag), NotModified: resp.NotModified}, nil
}

// FetchPullRequests fetches normalized PR/check metadata for up to 25 PR refs in
// one GraphQL request. The observer owns chunking; this method rejects larger
// batches so tests catch accidental over-batching.
func (p *Provider) FetchPullRequests(ctx context.Context, refs []ports.SCMPRRef) ([]ports.SCMObservation, error) {
	if len(refs) == 0 {
		return nil, nil
	}
	if len(refs) > 25 {
		return nil, fmt.Errorf("github scm: batch size %d exceeds 25", len(refs))
	}
	query, aliases := buildSCMBatchQuery(refs)
	data, err := p.client.doGraphQL(ctx, query, nil)
	if err != nil {
		return nil, err
	}
	out := make([]ports.SCMObservation, 0, len(refs))
	for i, ref := range refs {
		repoData, _ := data[aliases[i]].(map[string]any)
		pr, _ := repoData["pullRequest"].(map[string]any)
		if pr == nil {
			continue
		}
		if scmContextsPaginated(pr) {
			if err := p.fetchRemainingCheckContexts(ctx, ref, pr); err != nil {
				return nil, err
			}
		}
		out = append(out, scmObservationFromGraphQL(ref, pr))
	}
	return out, nil
}

// FetchFailedCheckLogTail fetches and tails a failed GitHub Actions job log.
func (p *Provider) FetchFailedCheckLogTail(ctx context.Context, repo ports.SCMRepo, check ports.SCMCheckObservation) (string, error) {
	if check.ProviderID == "" {
		return "", nil
	}
	jobID, err := strconv.ParseInt(check.ProviderID, 10, 64)
	if err != nil {
		return "", fmt.Errorf("github scm: parse check provider id %q: %w", check.ProviderID, err)
	}
	if jobID <= 0 {
		return "", nil
	}
	log, err := p.fetchJobLogTail(ctx, repo.Owner, repo.Name, jobID)
	if err != nil {
		return "", err
	}
	return tailLines(log, ciFailureLogTailLines), nil
}

// FetchReviewThreads fetches review threads separately from the fast PR/CI path.
func (p *Provider) FetchReviewThreads(ctx context.Context, ref ports.SCMPRRef) (ports.SCMReviewObservation, error) {
	latest, reviews, decision, pi, err := p.fetchReviewThreadPage(ctx, ref, "", true)
	if err != nil {
		return ports.SCMReviewObservation{}, err
	}
	if !boolv(pi["hasPreviousPage"]) {
		return ports.SCMReviewObservation{Decision: decision, Reviews: reviews, Threads: latest}, nil
	}
	out := latest
	startCursor := str(pi["startCursor"])
	// GitHub returns nodes in connection order even when selecting last:N, so
	// latest[0] is the oldest thread in the latest window. If that boundary
	// thread is still unresolved, fetch one older window to avoid hiding older
	// active review feedback behind the normal 50-thread cost cap.
	oldestLatestUnresolved := len(latest) == 0 || !latest[0].Resolved
	if oldestLatestUnresolved {
		if startCursor == "" {
			p.logger.Warn("github scm: review thread page is partial but missing start cursor",
				"repo", repoFullName(ref.Repo), "pr", ref.Number)
		} else {
			older, _, _, olderPI, err := p.fetchReviewThreadPage(ctx, ref, startCursor, false)
			if err != nil {
				return ports.SCMReviewObservation{}, err
			}
			combined := make([]ports.SCMReviewThreadObservation, 0, len(older)+len(latest))
			combined = append(combined, older...)
			combined = append(combined, latest...)
			out = combined
			if boolv(olderPI["hasPreviousPage"]) {
				p.logger.Warn("github scm: review thread page limit reached",
					"repo", repoFullName(ref.Repo), "pr", ref.Number,
					"max_pages", githubReviewThreadMaxPages)
			}
		}
	}
	return ports.SCMReviewObservation{Decision: decision, Reviews: reviews, Threads: out, Partial: true}, nil
}

type restListPull struct {
	URL     string `json:"url"`
	HTMLURL string `json:"html_url"`
	Number  int    `json:"number"`
	State   string `json:"state"`
	Draft   bool   `json:"draft"`
	Title   string `json:"title"`
	Head    struct {
		Ref  string `json:"ref"`
		SHA  string `json:"sha"`
		Repo struct {
			FullName string `json:"full_name"`
		} `json:"repo"`
	} `json:"head"`
	Base struct {
		Ref string `json:"ref"`
		SHA string `json:"sha"`
	} `json:"base"`
	User struct {
		Login string `json:"login"`
	} `json:"user"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

func restListPullToSCM(pull restListPull) ports.SCMPRObservation {
	closed := strings.EqualFold(pull.State, "closed")
	return ports.SCMPRObservation{
		URL:               firstNonEmpty(pull.HTMLURL, pull.URL),
		Number:            pull.Number,
		State:             normalizePRState(pull.Draft, false, closed),
		Draft:             pull.Draft,
		Closed:            closed,
		SourceBranch:      pull.Head.Ref,
		HeadRepo:          pull.Head.Repo.FullName,
		TargetBranch:      pull.Base.Ref,
		HeadSHA:           pull.Head.SHA,
		Title:             pull.Title,
		Author:            pull.User.Login,
		BaseSHA:           pull.Base.SHA,
		ProviderState:     pull.State,
		HTMLURL:           pull.HTMLURL,
		CreatedAtProvider: parseGitHubTime(pull.CreatedAt),
		UpdatedAtProvider: parseGitHubTime(pull.UpdatedAt),
	}
}

func buildSCMBatchQuery(refs []ports.SCMPRRef) (string, []string) {
	aliases := make([]string, len(refs))
	var b strings.Builder
	b.WriteString("query{\n")
	for i, ref := range refs {
		alias := fmt.Sprintf("pr%d", i)
		aliases[i] = alias
		_, _ = fmt.Fprintf(&b, "%s: repository(owner:%s,name:%s){ pullRequest(number:%d){ %s } }\n",
			alias, graphQLString(ref.Repo.Owner), graphQLString(ref.Repo.Name), ref.Number, scmPRFields())
	}
	b.WriteString("}")
	return b.String(), aliases
}

func scmPRFields() string {
	return strings.ReplaceAll(`
number url state isDraft merged closed title additions deletions changedFiles
mergeable mergeStateStatus reviewDecision headRefName headRefOid baseRefName baseRefOid
createdAt updatedAt mergedAt closedAt
author{ login }
mergeCommit{ oid }
commits(last:1){ nodes{ commit{ oid statusCheckRollup{ state contexts(first:CONTEXT_LIMIT){ nodes{
  __typename
  ... on CheckRun { name status conclusion detailsUrl url databaseId }
  ... on StatusContext { context state targetUrl }
} pageInfo{ hasNextPage endCursor } } } } } }
`, "CONTEXT_LIMIT", strconv.Itoa(scmBatchCheckContextLimit))
}

func (p *Provider) fetchRemainingCheckContexts(ctx context.Context, ref ports.SCMPRRef, pr map[string]any) error {
	contexts := statusContexts(pr)
	if contexts == nil {
		return nil
	}
	cursor := pageInfoEndCursor(contexts)
	if cursor == "" {
		return fmt.Errorf("github scm: paginated check contexts for %s#%d missing end cursor", repoFullName(ref.Repo), ref.Number)
	}
	for {
		query := buildCheckContextsQuery(ref, cursor)
		data, err := p.client.doGraphQL(ctx, query, nil)
		if err != nil {
			return fmt.Errorf("github scm: fetch remaining check contexts for %s#%d: %w", repoFullName(ref.Repo), ref.Number, err)
		}
		repoData, _ := data["repo"].(map[string]any)
		pagePR, _ := repoData["pullRequest"].(map[string]any)
		if pagePR == nil {
			return fmt.Errorf("%w: pull request not found in check context response", ErrNotFound)
		}
		pageContexts := statusContexts(pagePR)
		if pageContexts == nil {
			return fmt.Errorf("github scm: check context fallback for %s#%d returned no contexts", repoFullName(ref.Repo), ref.Number)
		}
		appendStatusContextNodes(contexts, pageContexts)
		if !pageInfoHasMore(pageContexts) {
			break
		}
		cursor = pageInfoEndCursor(pageContexts)
		if cursor == "" {
			return fmt.Errorf("github scm: paginated check context page for %s#%d missing end cursor", repoFullName(ref.Repo), ref.Number)
		}
	}
	return nil
}

func buildCheckContextsQuery(ref ports.SCMPRRef, cursor string) string {
	return fmt.Sprintf(`query{
repo: repository(owner:%s,name:%s){ pullRequest(number:%d){
  commits(last:1){ nodes{ commit{ statusCheckRollup{ contexts(first:%d, after:%s){ nodes{
    __typename
    ... on CheckRun { name status conclusion detailsUrl url databaseId }
    ... on StatusContext { context state targetUrl }
  } pageInfo{ hasNextPage endCursor } } } } } }
} }
}`, graphQLString(ref.Repo.Owner), graphQLString(ref.Repo.Name), ref.Number, scmBatchCheckContextLimit, graphQLString(cursor))
}

func statusContexts(pr map[string]any) map[string]any {
	roll := statusRollup(pr)
	if roll == nil {
		return nil
	}
	contexts, _ := roll["contexts"].(map[string]any)
	return contexts
}

func appendStatusContextNodes(dst, src map[string]any) {
	if dst == nil || src == nil {
		return
	}
	merged, _ := dst["nodes"].([]any)
	for _, n := range nodes(src["nodes"]) {
		merged = append(merged, n)
	}
	dst["nodes"] = merged
	dst["pageInfo"] = src["pageInfo"]
}

func pageInfoEndCursor(connection map[string]any) string {
	pi, _ := connection["pageInfo"].(map[string]any)
	return str(pi["endCursor"])
}

func scmObservationFromGraphQL(ref ports.SCMPRRef, pr map[string]any) ports.SCMObservation {
	checks := scmChecksFromGraphQL(pr)
	failed := failedSCMChecks(checks)
	ci := string(ciSummaryFromRollupState(pr))
	prURL := firstNonEmpty(str(pr["url"]), ref.URL)
	review := string(reviewDecisionFromGraphQL(pr))
	providerMergeable := str(pr["mergeable"])
	providerMergeState := str(pr["mergeStateStatus"])
	merged := boolv(pr["merged"])
	closed := boolv(pr["closed"]) && !merged
	draft := boolv(pr["isDraft"])
	obs := ports.SCMObservation{
		Fetched:  true,
		Provider: ref.Repo.Provider,
		Host:     ref.Repo.Host,
		Repo:     repoFullName(ref.Repo),
		PR: ports.SCMPRObservation{
			URL:                      prURL,
			Number:                   int(num(pr["number"])),
			State:                    normalizePRState(draft, merged, closed),
			Draft:                    draft,
			Merged:                   merged,
			Closed:                   closed,
			SourceBranch:             str(pr["headRefName"]),
			TargetBranch:             str(pr["baseRefName"]),
			HeadSHA:                  firstNonEmpty(str(pr["headRefOid"]), latestCommitOID(pr)),
			Title:                    str(pr["title"]),
			Additions:                int(num(pr["additions"])),
			Deletions:                int(num(pr["deletions"])),
			ChangedFiles:             int(num(pr["changedFiles"])),
			Author:                   authorLogin(pr["author"]),
			BaseSHA:                  str(pr["baseRefOid"]),
			MergeCommitSHA:           mergeCommitOID(pr),
			ProviderState:            str(pr["state"]),
			ProviderMergeable:        providerMergeable,
			ProviderMergeStateStatus: providerMergeState,
			HTMLURL:                  str(pr["url"]),
			CreatedAtProvider:        parseGitHubTime(str(pr["createdAt"])),
			UpdatedAtProvider:        parseGitHubTime(str(pr["updatedAt"])),
			MergedAtProvider:         parseGitHubTime(str(pr["mergedAt"])),
			ClosedAtProvider:         parseGitHubTime(str(pr["closedAt"])),
		},
		CI: ports.SCMCIObservation{
			Summary:           ci,
			HeadSHA:           firstNonEmpty(str(pr["headRefOid"]), latestCommitOID(pr)),
			Checks:            checks,
			FailedChecks:      failed,
			FailedFingerprint: githubFailedFingerprint(firstNonEmpty(str(pr["headRefOid"]), latestCommitOID(pr)), failed),
		},
		Review: ports.SCMReviewObservation{Decision: review},
	}
	obs.Mergeability = mergeabilityObservation(providerMergeable, providerMergeState, ci, review, draft)
	return obs
}

func ciSummaryFromRollupState(pr map[string]any) domain.CIState {
	roll := statusRollup(pr)
	if roll == nil {
		return domain.CIUnknown
	}
	return mapRollupState(str(roll["state"]))
}

func scmContextsPaginated(pr map[string]any) bool {
	return pageInfoHasMore(statusContexts(pr))
}

func scmChecksFromGraphQL(pr map[string]any) []ports.SCMCheckObservation {
	roll := statusRollup(pr)
	contexts, _ := roll["contexts"].(map[string]any)
	rawNodes := nodes(contexts["nodes"])
	out := make([]ports.SCMCheckObservation, 0, len(rawNodes))
	for _, n := range rawNodes {
		typ := str(n["__typename"])
		var ch ports.SCMCheckObservation
		switch typ {
		case "CheckRun":
			ch.Name = str(n["name"])
			ch.Status = string(checkStatusFromGraphQL(n))
			ch.Conclusion = strings.ToLower(str(n["conclusion"]))
			ch.URL = firstNonEmpty(str(n["detailsUrl"]), str(n["url"]))
			if id := int64(num(n["databaseId"])); id > 0 {
				ch.ProviderID = strconv.FormatInt(id, 10)
			}
		case "StatusContext":
			ch.Name = str(n["context"])
			ch.Status = string(checkStatusFromGraphQL(n))
			ch.Conclusion = strings.ToLower(str(n["state"]))
			ch.URL = str(n["targetUrl"])
		default:
			continue
		}
		if ch.Name == "" {
			continue
		}
		out = append(out, ch)
	}
	return out
}

func failedSCMChecks(checks []ports.SCMCheckObservation) []ports.SCMCheckObservation {
	out := make([]ports.SCMCheckObservation, 0, len(checks))
	for _, ch := range checks {
		status := domain.PRCheckStatus(ch.Status)
		if status == domain.PRCheckFailed || status == domain.PRCheckCancelled {
			out = append(out, ch)
		}
	}
	return out
}

func githubFailedFingerprint(head string, checks []ports.SCMCheckObservation) string {
	if len(checks) == 0 {
		return ""
	}
	parts := make([]string, 0, len(checks))
	for _, ch := range checks {
		parts = append(parts, strings.Join([]string{head, ch.Name, ch.Status, ch.Conclusion, ch.URL, ch.ProviderID}, "\x00"))
	}
	sort.Strings(parts)
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x1e")))
	return hex.EncodeToString(sum[:])
}

func mergeabilityObservation(providerMergeable, providerMergeState, ci, review string, draft bool) ports.SCMMergeabilityObservation {
	state := strings.ToUpper(strings.TrimSpace(providerMergeState))
	mergeable := strings.ToUpper(strings.TrimSpace(providerMergeable))
	out := ports.SCMMergeabilityObservation{State: string(domain.MergeUnknown)}
	addBlocker := func(b string) { out.Blockers = append(out.Blockers, b) }
	if state == "DIRTY" || mergeable == "CONFLICTING" {
		out.State = string(domain.MergeConflicting)
		out.Conflict = true
		addBlocker("conflicts")
		return out
	}
	if state == "BEHIND" || state == "BEHIND_BASE" {
		out.BehindBase = true
		addBlocker("behind_base")
	}
	if state == "BLOCKED" {
		out.State = string(domain.MergeBlocked)
		addBlocker("blocked_by_provider")
	}
	if draft {
		out.State = string(domain.MergeBlocked)
		addBlocker("draft")
	}
	if ci == string(domain.CIFailing) {
		out.State = string(domain.MergeBlocked)
		addBlocker("ci_failing")
	}
	switch review {
	case string(domain.ReviewChangesRequest):
		out.State = string(domain.MergeBlocked)
		addBlocker("changes_requested")
	case string(domain.ReviewRequired):
		out.State = string(domain.MergeBlocked)
		addBlocker("review_required")
	}
	if out.State == string(domain.MergeBlocked) {
		return out
	}
	if state == "UNSTABLE" {
		out.State = string(domain.MergeUnstable)
		return out
	}
	if mergeable == "MERGEABLE" && (state == "CLEAN" || state == "HAS_HOOKS" || state == "") &&
		(review == "" || review == string(domain.ReviewApproved) || review == string(domain.ReviewNone)) && !draft {
		out.State = string(domain.MergeMergeable)
		out.Mergeable = true
		return out
	}
	return out
}

func (p *Provider) fetchReviewThreadPage(ctx context.Context, ref ports.SCMPRRef, beforeCursor string, includeReviews bool) ([]ports.SCMReviewThreadObservation, []ports.SCMReviewSummaryObservation, string, map[string]any, error) {
	query := buildReviewThreadsQuery(ref, beforeCursor, includeReviews)
	data, err := p.client.doGraphQL(ctx, query, nil)
	if err != nil {
		return nil, nil, "", nil, err
	}
	repoData, _ := data["repo"].(map[string]any)
	pr, _ := repoData["pullRequest"].(map[string]any)
	if pr == nil {
		return nil, nil, "", nil, fmt.Errorf("%w: pull request not found in review response", ErrNotFound)
	}
	decision := string(reviewDecisionFromGraphQL(pr))
	reviewSummaries, _ := pr["reviewSummaries"].(map[string]any)
	reviews := make([]ports.SCMReviewSummaryObservation, 0, len(nodes(reviewSummaries["nodes"])))
	for _, review := range nodes(reviewSummaries["nodes"]) {
		summary := scmReviewSummaryFromGraphQL(review)
		if summary.ID == "" && summary.URL == "" {
			continue
		}
		reviews = append(reviews, summary)
	}
	threads, _ := pr["reviewThreads"].(map[string]any)
	out := make([]ports.SCMReviewThreadObservation, 0, len(nodes(threads["nodes"])))
	for _, th := range nodes(threads["nodes"]) {
		out = append(out, scmThreadFromGraphQL(th))
	}
	pi, _ := threads["pageInfo"].(map[string]any)
	return out, reviews, decision, pi, nil
}

func buildReviewThreadsQuery(ref ports.SCMPRRef, beforeCursor string, includeReviews bool) string {
	before := "null"
	if beforeCursor != "" {
		before = graphQLString(beforeCursor)
	}
	reviewSelection := ""
	if includeReviews {
		reviewSelection = fmt.Sprintf(" reviewSummaries: reviews(last:%d, states:[APPROVED,CHANGES_REQUESTED]){ nodes{ id state url submittedAt body author{ login __typename } } }", githubReviewSummaryLimit)
	}
	return fmt.Sprintf(`query{
repo: repository(owner:%s,name:%s){ pullRequest(number:%d){ reviewDecision%s reviewThreads(last:%d, before:%s){ nodes{
  id isResolved path line
  comments(first:%d){ nodes{ id body url author{ login __typename } } }
} pageInfo{ hasPreviousPage startCursor } } } }
}`, graphQLString(ref.Repo.Owner), graphQLString(ref.Repo.Name), ref.Number, reviewSelection, githubReviewThreadPageSize, before, githubReviewCommentLimitPerThread)
}

func scmReviewSummaryFromGraphQL(review map[string]any) ports.SCMReviewSummaryObservation {
	author, _ := review["author"].(map[string]any)
	return ports.SCMReviewSummaryObservation{
		ID:          str(review["id"]),
		Author:      str(author["login"]),
		State:       string(reviewStateFromGraphQL(review["state"])),
		URL:         str(review["url"]),
		Body:        str(review["body"]),
		IsBot:       isBotAuthor(author),
		SubmittedAt: parseGitHubTime(str(review["submittedAt"])),
	}
}

func reviewStateFromGraphQL(state any) domain.ReviewDecision {
	switch strings.ToUpper(strings.TrimSpace(str(state))) {
	case "APPROVED":
		return domain.ReviewApproved
	case "CHANGES_REQUESTED":
		return domain.ReviewChangesRequest
	case "REVIEW_REQUIRED":
		return domain.ReviewRequired
	default:
		return domain.ReviewNone
	}
}

func scmThreadFromGraphQL(th map[string]any) ports.SCMReviewThreadObservation {
	out := ports.SCMReviewThreadObservation{
		ID:       str(th["id"]),
		Path:     str(th["path"]),
		Line:     int(num(th["line"])),
		Resolved: boolv(th["isResolved"]),
	}
	comments, _ := th["comments"].(map[string]any)
	commentNodes := nodes(comments["nodes"])
	allCommentsBot := len(commentNodes) > 0
	for _, cn := range commentNodes {
		author, _ := cn["author"].(map[string]any)
		isBot := isBotAuthor(author)
		if !isBot {
			allCommentsBot = false
		}
		out.Comments = append(out.Comments, ports.SCMReviewCommentObservation{
			ID:     str(cn["id"]),
			Author: str(author["login"]),
			Body:   str(cn["body"]),
			URL:    str(cn["url"]),
			IsBot:  isBot,
		})
	}
	out.IsBot = allCommentsBot
	return out
}

func parseGitHubRepo(remote string) (ports.SCMRepo, bool) {
	raw := strings.TrimSpace(remote)
	if raw == "" {
		return ports.SCMRepo{}, false
	}
	if strings.HasPrefix(raw, "git@") {
		raw = strings.TrimPrefix(raw, "git@")
		parts := strings.SplitN(raw, ":", 2)
		if len(parts) != 2 {
			return ports.SCMRepo{}, false
		}
		host := strings.ToLower(parts[0])
		owner, name, ok := splitOwnerRepo(parts[1])
		return makeGitHubRepo(host, owner, name), ok && isGitHubHost(host)
	}
	if !strings.Contains(raw, "://") && strings.Count(strings.Trim(raw, "/"), "/") == 1 {
		owner, name, ok := splitOwnerRepo(raw)
		return makeGitHubRepo("github.com", owner, name), ok
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ports.SCMRepo{}, false
	}
	host := strings.ToLower(u.Host)
	owner, name, ok := splitOwnerRepo(u.Path)
	return makeGitHubRepo(host, owner, name), ok && isGitHubHost(host)
}

func splitOwnerRepo(p string) (string, string, bool) {
	parts := strings.Split(strings.Trim(p, "/"), "/")
	if len(parts) < 2 {
		return "", "", false
	}
	owner := parts[0]
	name := strings.TrimSuffix(parts[1], ".git")
	return owner, name, owner != "" && name != ""
}

func makeGitHubRepo(host, owner, name string) ports.SCMRepo {
	return ports.SCMRepo{Provider: "github", Host: host, Owner: owner, Name: name, Repo: owner + "/" + name}
}

func isGitHubHost(host string) bool {
	return host == "github.com" || host == "www.github.com" || host == "api.github.com" || strings.HasSuffix(host, ".github.com") || strings.HasSuffix(host, ".ghe.io")
}

func graphQLString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(b)
}

func repoFullName(repo ports.SCMRepo) string {
	if repo.Repo != "" {
		return repo.Repo
	}
	return repo.Owner + "/" + repo.Name
}

func normalizePRState(draft, merged, closed bool) string {
	switch {
	case merged:
		return string(domain.PRStateMerged)
	case closed:
		return string(domain.PRStateClosed)
	case draft:
		return string(domain.PRStateDraft)
	default:
		return string(domain.PRStateOpen)
	}
}

func parseGitHubTime(s string) time.Time {
	if strings.TrimSpace(s) == "" {
		return time.Time{}
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t
	}
	return time.Time{}
}

func authorLogin(v any) string {
	author, _ := v.(map[string]any)
	return str(author["login"])
}

func mergeCommitOID(pr map[string]any) string {
	mc, _ := pr["mergeCommit"].(map[string]any)
	return str(mc["oid"])
}

func latestCommitOID(pr map[string]any) string {
	commits, _ := pr["commits"].(map[string]any)
	for _, n := range nodes(commits["nodes"]) {
		commit, _ := n["commit"].(map[string]any)
		if oid := str(commit["oid"]); oid != "" {
			return oid
		}
	}
	return ""
}
