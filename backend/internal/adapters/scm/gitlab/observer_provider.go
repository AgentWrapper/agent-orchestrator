package gitlab

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	ciFailureLogTailLines       = 20
	reviewDiscussionPageSize    = 100
	reviewCommentLimitPerThread = 5
	pipelineJobsPageSize        = 100
	fetchConcurrency            = 5
)

// ---------------------------------------------------------------------------
// ParseRepository
// ---------------------------------------------------------------------------

// ParseRepository parses a Git remote URL and returns an SCMRepo if the host
// belongs to a GitLab instance.
func (p *Provider) ParseRepository(remote string) (ports.SCMRepo, bool) {
	return parseGitLabRepo(remote)
}

func parseGitLabRepo(remote string) (ports.SCMRepo, bool) {
	remote = strings.TrimSpace(remote)
	if remote == "" {
		return ports.SCMRepo{}, false
	}

	// SSH: git@gitlab.com:owner/repo.git
	if m := sshRemoteRe.FindStringSubmatch(remote); m != nil {
		host := m[1]
		if !isGitLabHost(host) {
			return ports.SCMRepo{}, false
		}
		owner, name, ok := splitOwnerRepo(strings.TrimSuffix(m[2], ".git"))
		if !ok {
			return ports.SCMRepo{}, false
		}
		return makeGitLabRepo(host, owner, name), true
	}

	// HTTPS: https://gitlab.com/owner/repo.git
	u, err := url.Parse(remote)
	if err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" {
		host := u.Hostname()
		if !isGitLabHost(host) {
			return ports.SCMRepo{}, false
		}
		path := strings.TrimPrefix(u.Path, "/")
		path = strings.TrimSuffix(path, ".git")
		owner, name, ok := splitOwnerRepo(path)
		if !ok {
			return ports.SCMRepo{}, false
		}
		return makeGitLabRepo(host, owner, name), true
	}

	return ports.SCMRepo{}, false
}

var sshRemoteRe = regexp.MustCompile(`^git@([^:]+):(.+)$`)

func splitOwnerRepo(p string) (string, string, bool) {
	parts := strings.SplitN(p, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func makeGitLabRepo(host, owner, name string) ports.SCMRepo {
	return ports.SCMRepo{
		Provider: "gitlab",
		Host:     host,
		Owner:    owner,
		Name:     name,
		Repo:     owner + "/" + name,
	}
}

func isGitLabHost(host string) bool {
	if host == "gitlab.com" || host == "www.gitlab.com" {
		return true
	}
	if customHost := os.Getenv("AO_GITLAB_HOST"); customHost != "" && host == customHost {
		return true
	}
	if host == "github.com" || host == "www.github.com" || host == "api.github.com" ||
		strings.HasSuffix(host, ".github.com") || strings.HasSuffix(host, ".ghe.io") {
		return false
	}
	return strings.Contains(host, "gitlab")
}

// ---------------------------------------------------------------------------
// RepoPRListGuard
// ---------------------------------------------------------------------------

// RepoPRListGuard returns an ETag-based guard for the open merge-request list
// of a project, allowing the observer to skip unchanged data.
func (p *Provider) RepoPRListGuard(ctx context.Context, repo ports.SCMRepo, etag string) (ports.SCMGuardResult, error) {
	path := fmt.Sprintf("/projects/%s/merge_requests", projectPath(repo.Owner, repo.Name))
	q := url.Values{
		"state":    {"opened"},
		"order_by": {"updated_at"},
		"sort":     {"desc"},
		"per_page": {"1"},
	}
	resp, err := p.client.doRESTWithETag(ctx, path, q, etag)
	if err != nil {
		return ports.SCMGuardResult{}, err
	}
	return ports.SCMGuardResult{
		ETag:        resp.ETag,
		NotModified: resp.NotModified,
	}, nil
}

// ---------------------------------------------------------------------------
// ListOpenPRsByRepo
// ---------------------------------------------------------------------------

// ListPRsByRepo lists merge requests in a project, optionally filtered to
// those updated after updatedAfter (zero = full listing). Uses state=all so
// closed/merged MRs are also discovered for state-transition tracking, and
// follows Link rel=next to paginate all pages.
func (p *Provider) ListPRsByRepo(ctx context.Context, repo ports.SCMRepo, updatedAfter time.Time) ([]ports.SCMPRObservation, error) {
	var result []ports.SCMPRObservation
	q := url.Values{
		"state":    {"all"},
		"order_by": {"updated_at"},
		"sort":     {"desc"},
		"per_page": {"100"},
	}
	if !updatedAfter.IsZero() {
		q.Set("updated_after", updatedAfter.UTC().Format(time.RFC3339Nano))
	}
	path := fmt.Sprintf("/projects/%s/merge_requests", projectPath(repo.Owner, repo.Name))
	_, err := p.clientForHost(repo.Host).doGETPaginated(ctx, path, q, func(body []byte) error {
		var mrs []restMR
		if err := json.Unmarshal(body, &mrs); err != nil {
			return fmt.Errorf("gitlab scm: unmarshal MR list: %w", err)
		}
		for i := range mrs {
			result = append(result, mrToSCMPRObservation(repo, &mrs[i]))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

type restMR struct {
	IID                 int    `json:"iid"`
	Title               string `json:"title"`
	State               string `json:"state"`
	Draft               bool   `json:"draft"`
	WebURL              string `json:"web_url"`
	SourceBranch        string `json:"source_branch"`
	TargetBranch        string `json:"target_branch"`
	SHA                 string `json:"sha"`
	MergeStatus         string `json:"merge_status"`
	DetailedMergeStatus string `json:"detailed_merge_status"`

	DiffStats struct {
		Additions int `json:"additions"`
		Deletions int `json:"deletions"`
		Changes   int `json:"changes"`
	} `json:"diff_stats"`

	Author struct {
		Username string `json:"username"`
	} `json:"author"`

	SourceProjectID int `json:"source_project_id"`
	TargetProjectID int `json:"target_project_id"`

	BaseSHA        string `json:"diff_refs.base_sha"`
	MergeCommitSHA string `json:"merge_commit_sha"`

	CreatedAt *time.Time `json:"created_at"`
	UpdatedAt *time.Time `json:"updated_at"`
	MergedAt  *time.Time `json:"merged_at"`
	ClosedAt  *time.Time `json:"closed_at"`

	BlockingDiscussionsResolved bool `json:"blocking_discussions_resolved"`
}

type restDiffRefs struct {
	BaseSHA string `json:"base_sha"`
}

func mrToSCMPRObservation(repo ports.SCMRepo, mr *restMR) ports.SCMPRObservation {
	state := normalizeMRState(mr.State, mr.Draft)
	merged := mr.State == "merged"
	closed := mr.State == "closed" || mr.State == "locked"
	return ports.SCMPRObservation{
		URL:                      mr.WebURL,
		HTMLURL:                  mr.WebURL,
		Number:                   mr.IID,
		State:                    string(state),
		Draft:                    mr.Draft,
		Merged:                   merged,
		Closed:                   closed,
		SourceBranch:             mr.SourceBranch,
		HeadRepo:                 repo.Repo,
		TargetBranch:             mr.TargetBranch,
		HeadSHA:                  mr.SHA,
		Title:                    mr.Title,
		Additions:                mr.DiffStats.Additions,
		Deletions:                mr.DiffStats.Deletions,
		ChangedFiles:             mr.DiffStats.Changes,
		Author:                   mr.Author.Username,
		ProviderState:            mr.State,
		ProviderMergeable:        mr.MergeStatus,
		ProviderMergeStateStatus: effectiveMergeStatus(mr),
		CreatedAtProvider:        safeTime(mr.CreatedAt),
		UpdatedAtProvider:        safeTime(mr.UpdatedAt),
		MergedAtProvider:         safeTime(mr.MergedAt),
		ClosedAtProvider:         safeTime(mr.ClosedAt),
	}
}

func normalizeMRState(state string, draft bool) domain.PRState {
	switch state {
	case "opened":
		if draft {
			return domain.PRStateDraft
		}
		return domain.PRStateOpen
	case "merged":
		return domain.PRStateMerged
	case "closed", "locked":
		return domain.PRStateClosed
	default:
		return domain.PRStateClosed
	}
}

func effectiveMergeStatus(mr *restMR) string {
	if mr.DetailedMergeStatus != "" {
		return mr.DetailedMergeStatus
	}
	return mr.MergeStatus
}

func safeTime(t *time.Time) time.Time {
	if t == nil {
		return time.Time{}
	}
	return *t
}

// ---------------------------------------------------------------------------
// CommitChecksGuard
// ---------------------------------------------------------------------------

// CommitChecksGuard returns a hash-based guard for the latest pipeline status
// of a commit, allowing the observer to skip unchanged CI state.
func (p *Provider) CommitChecksGuard(ctx context.Context, repo ports.SCMRepo, headSHA, etag string) (ports.SCMGuardResult, error) {
	if headSHA == "" {
		return ports.SCMGuardResult{}, fmt.Errorf("gitlab scm: empty head SHA: %w", ErrNotFound)
	}
	path := fmt.Sprintf("/projects/%s/pipelines", projectPath(repo.Owner, repo.Name))
	q := url.Values{
		"sha":      {headSHA},
		"per_page": {"1"},
		"order_by": {"id"},
		"sort":     {"desc"},
	}
	resp, err := p.client.doGET(ctx, path, q)
	if err != nil {
		return ports.SCMGuardResult{}, err
	}
	h := sha256.Sum256(resp.Body)
	newETag := hex.EncodeToString(h[:])
	return ports.SCMGuardResult{
		ETag:        newETag,
		NotModified: etag == newETag,
	}, nil
}

// ---------------------------------------------------------------------------
// FetchPullRequests
// ---------------------------------------------------------------------------

// FetchPullRequests fetches detailed observations for a batch of merge requests,
// including MR metadata, CI status, approvals, and mergeability.
func (p *Provider) FetchPullRequests(ctx context.Context, refs []ports.SCMPRRef) ([]ports.SCMObservation, error) {
	if len(refs) > 25 {
		return nil, fmt.Errorf("gitlab scm: batch size %d exceeds limit 25", len(refs))
	}
	results := make([]ports.SCMObservation, len(refs))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, fetchConcurrency)
	var firstErr error

	for i, ref := range refs {
		wg.Add(1)
		go func(idx int, r ports.SCMPRRef) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			obs, err := p.fetchSingleMR(ctx, r)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				p.logger.Warn("gitlab scm: fetch MR failed", "repo", r.Repo.Repo, "mr", r.Number, "err", err)
				if firstErr == nil {
					firstErr = err
				}
				results[idx] = ports.SCMObservation{
					Provider: "gitlab",
					Host:     r.Repo.Host,
					Repo:     r.Repo.Repo,
					PR:       ports.SCMPRObservation{Number: r.Number, URL: r.URL},
				}
				return
			}
			results[idx] = obs
		}(i, ref)
	}
	wg.Wait()
	return results, nil
}

func (p *Provider) fetchSingleMR(ctx context.Context, ref ports.SCMPRRef) (ports.SCMObservation, error) {
	repo := ref.Repo
	now := time.Now()

	// 1. Fetch MR detail
	mrPath := fmt.Sprintf("/projects/%s/merge_requests/%d", projectPath(repo.Owner, repo.Name), ref.Number)
	mrResp, err := p.client.doGET(ctx, mrPath, nil)
	if err != nil {
		return ports.SCMObservation{}, err
	}
	var mr restMR
	if err := json.Unmarshal(mrResp.Body, &mr); err != nil {
		return ports.SCMObservation{}, fmt.Errorf("gitlab scm: unmarshal MR detail: %w", err)
	}

	// Decode diff_refs for base SHA
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(mrResp.Body, &raw); err == nil {
		if drRaw, ok := raw["diff_refs"]; ok {
			var dr restDiffRefs
			if json.Unmarshal(drRaw, &dr) == nil {
				mr.BaseSHA = dr.BaseSHA
			}
		}
	}

	prObs := mrToSCMPRObservation(repo, &mr)
	prObs.BaseSHA = mr.BaseSHA
	prObs.MergeCommitSHA = mr.MergeCommitSHA

	// 2. Fetch CI (pipelines + jobs)
	ciObs := p.fetchCI(ctx, repo, mr.SHA)

	// 3. Fetch approvals for review decision
	reviewDecision := p.fetchApprovalDecision(ctx, repo, ref.Number)

	// 4. Build mergeability
	mergeObs := mergeabilityFromMR(&mr, ciObs.Summary, string(reviewDecision))

	return ports.SCMObservation{
		Fetched:      true,
		ObservedAt:   now,
		Provider:     "gitlab",
		Host:         repo.Host,
		Repo:         repo.Repo,
		PR:           prObs,
		CI:           ciObs,
		Review:       ports.SCMReviewObservation{Decision: string(reviewDecision)},
		Mergeability: mergeObs,
	}, nil
}

func (p *Provider) fetchCI(ctx context.Context, repo ports.SCMRepo, headSHA string) ports.SCMCIObservation {
	if headSHA == "" {
		return ports.SCMCIObservation{Summary: string(domain.CIUnknown)}
	}

	path := fmt.Sprintf("/projects/%s/pipelines", projectPath(repo.Owner, repo.Name))
	q := url.Values{
		"sha":      {headSHA},
		"per_page": {"10"},
		"order_by": {"id"},
		"sort":     {"desc"},
	}
	resp, err := p.client.doGET(ctx, path, q)
	if err != nil {
		p.logger.Warn("gitlab scm: fetch pipelines failed", "repo", repo.Repo, "err", err)
		return ports.SCMCIObservation{Summary: string(domain.CIUnknown), HeadSHA: headSHA}
	}

	var pipelines []restPipeline
	if err := json.Unmarshal(resp.Body, &pipelines); err != nil || len(pipelines) == 0 {
		return ports.SCMCIObservation{Summary: string(domain.CIUnknown), HeadSHA: headSHA}
	}

	latest := pipelines[0]
	ciState := pipelineStatusToCI(latest.Status)

	// Fetch jobs from the latest pipeline
	checks, failedChecks := p.fetchPipelineJobs(ctx, repo, latest.ID)

	fp := gitlabFailedFingerprint(headSHA, failedChecks)

	return ports.SCMCIObservation{
		Summary:           string(ciState),
		HeadSHA:           headSHA,
		FailedFingerprint: fp,
		Checks:            checks,
		FailedChecks:      failedChecks,
	}
}

type restPipeline struct {
	ID     int    `json:"id"`
	Status string `json:"status"`
	SHA    string `json:"sha"`
}

func (p *Provider) fetchPipelineJobs(ctx context.Context, repo ports.SCMRepo, pipelineID int) ([]ports.SCMCheckObservation, []ports.SCMCheckObservation) {
	path := fmt.Sprintf("/projects/%s/pipelines/%d/jobs", projectPath(repo.Owner, repo.Name), pipelineID)
	q := url.Values{"per_page": {strconv.Itoa(pipelineJobsPageSize)}}
	resp, err := p.client.doGET(ctx, path, q)
	if err != nil {
		p.logger.Warn("gitlab scm: fetch pipeline jobs failed", "repo", repo.Repo, "pipeline", pipelineID, "err", err)
		return nil, nil
	}

	var jobs []restJob
	if err := json.Unmarshal(resp.Body, &jobs); err != nil {
		return nil, nil
	}

	var checks, failed []ports.SCMCheckObservation
	for _, j := range jobs {
		status := jobStatusToCheckStatus(j.Status)
		check := ports.SCMCheckObservation{
			Name:       j.Name,
			Status:     string(status),
			Conclusion: j.Status,
			URL:        j.WebURL,
			ProviderID: strconv.Itoa(j.ID),
		}
		checks = append(checks, check)
		if isFailingCheckStatus(status) {
			failed = append(failed, check)
		}
	}
	return checks, failed
}

type restJob struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
	WebURL string `json:"web_url"`
}

func (p *Provider) fetchApprovalDecision(ctx context.Context, repo ports.SCMRepo, mrIID int) domain.ReviewDecision {
	path := fmt.Sprintf("/projects/%s/merge_requests/%d/approvals", projectPath(repo.Owner, repo.Name), mrIID)
	resp, err := p.client.doGET(ctx, path, nil)
	if err != nil {
		p.logger.Warn("gitlab scm: fetch approvals failed", "repo", repo.Repo, "mr", mrIID, "err", err)
		return domain.ReviewNone
	}

	var approvals restApprovals
	if err := json.Unmarshal(resp.Body, &approvals); err != nil {
		return domain.ReviewNone
	}

	if approvals.Approved {
		return domain.ReviewApproved
	}
	if approvals.ApprovalsRequired > 0 && len(approvals.ApprovedBy) < approvals.ApprovalsRequired {
		return domain.ReviewRequired
	}
	return domain.ReviewNone
}

type restApprovals struct {
	Approved          bool `json:"approved"`
	ApprovalsRequired int  `json:"approvals_required"`
	ApprovedBy        []struct {
		User struct {
			Username string `json:"username"`
		} `json:"user"`
	} `json:"approved_by"`
}

// ---------------------------------------------------------------------------
// FetchFailedCheckLogTail
// ---------------------------------------------------------------------------

// FetchFailedCheckLogTail returns the last N lines of a failed CI job's trace.
func (p *Provider) FetchFailedCheckLogTail(ctx context.Context, repo ports.SCMRepo, check ports.SCMCheckObservation) (string, error) {
	jobID := check.ProviderID
	if jobID == "" {
		return "", fmt.Errorf("gitlab scm: empty job ID")
	}
	path := fmt.Sprintf("/projects/%s/jobs/%s/trace", projectPath(repo.Owner, repo.Name), jobID)
	body, err := p.client.doGETRaw(ctx, path, nil)
	if err != nil {
		return "", err
	}
	return tailLines(string(body), ciFailureLogTailLines), nil
}

// ---------------------------------------------------------------------------
// FetchReviewThreads
// ---------------------------------------------------------------------------

// FetchReviewThreads fetches discussion threads and approval state for a merge
// request.
func (p *Provider) FetchReviewThreads(ctx context.Context, ref ports.SCMPRRef) (ports.SCMReviewObservation, error) {
	repo := ref.Repo

	// Fetch discussions
	path := fmt.Sprintf("/projects/%s/merge_requests/%d/discussions", projectPath(repo.Owner, repo.Name), ref.Number)
	q := url.Values{"per_page": {strconv.Itoa(reviewDiscussionPageSize)}}
	resp, err := p.client.doGET(ctx, path, q)
	if err != nil {
		return ports.SCMReviewObservation{}, err
	}

	var discussions []restDiscussion
	if err := json.Unmarshal(resp.Body, &discussions); err != nil {
		return ports.SCMReviewObservation{}, fmt.Errorf("gitlab scm: unmarshal discussions: %w", err)
	}

	var threads []ports.SCMReviewThreadObservation
	for _, d := range discussions {
		if d.IndividualNote {
			continue
		}
		if len(d.Notes) == 0 {
			continue
		}
		firstNote := d.Notes[0]
		if firstNote.System {
			continue
		}

		resolved := true
		allBot := true
		var comments []ports.SCMReviewCommentObservation
		filePath := ""
		line := 0

		for j, n := range d.Notes {
			if n.System {
				continue
			}
			isBot := isBotAuthor(n.Author.Username)
			if !isBot {
				allBot = false
			}
			if !n.Resolved && n.Resolvable {
				resolved = false
			}
			if j == 0 && n.Position != nil {
				filePath = n.Position.NewPath
				line = n.Position.NewLine
			}
			if j < reviewCommentLimitPerThread {
				comments = append(comments, ports.SCMReviewCommentObservation{
					ID:     strconv.Itoa(n.ID),
					Author: n.Author.Username,
					Body:   n.Body,
					URL:    n.noteURL(ref),
					IsBot:  isBot,
				})
			}
		}

		threads = append(threads, ports.SCMReviewThreadObservation{
			ID:       d.ID,
			Path:     filePath,
			Line:     line,
			Resolved: resolved,
			IsBot:    allBot,
			Comments: comments,
		})
	}

	// Fetch approval state for review summaries
	decision := p.fetchApprovalDecision(ctx, repo, ref.Number)

	approvalPath := fmt.Sprintf("/projects/%s/merge_requests/%d/approvals", projectPath(repo.Owner, repo.Name), ref.Number)
	approvalResp, _ := p.client.doGET(ctx, approvalPath, nil)
	var reviews []ports.SCMReviewSummaryObservation
	if approvalResp.Body != nil {
		var approvals restApprovals
		if json.Unmarshal(approvalResp.Body, &approvals) == nil {
			for _, ab := range approvals.ApprovedBy {
				reviews = append(reviews, ports.SCMReviewSummaryObservation{
					Author: ab.User.Username,
					State:  string(domain.ReviewApproved),
					IsBot:  isBotAuthor(ab.User.Username),
				})
			}
		}
	}

	return ports.SCMReviewObservation{
		Decision: string(decision),
		Reviews:  reviews,
		Threads:  threads,
		Partial:  len(discussions) >= reviewDiscussionPageSize,
	}, nil
}

type restDiscussion struct {
	ID             string     `json:"id"`
	IndividualNote bool       `json:"individual_note"`
	Notes          []restNote `json:"notes"`
}

type restNote struct {
	ID         int    `json:"id"`
	Body       string `json:"body"`
	System     bool   `json:"system"`
	Resolvable bool   `json:"resolvable"`
	Resolved   bool   `json:"resolved"`
	Author     struct {
		Username string `json:"username"`
	} `json:"author"`
	Position *restNotePosition `json:"position"`
}

type restNotePosition struct {
	NewPath string `json:"new_path"`
	NewLine int    `json:"new_line"`
}

func (n *restNote) noteURL(ref ports.SCMPRRef) string {
	return fmt.Sprintf("%s#note_%d", ref.URL, n.ID)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func pipelineStatusToCI(status string) domain.CIState {
	switch status {
	case "success":
		return domain.CIPassing
	case "failed", "canceled":
		return domain.CIFailing
	case "running", "pending", "created", "waiting_for_resource", "preparing", "scheduled":
		return domain.CIPending
	default:
		return domain.CIUnknown
	}
}

func jobStatusToCheckStatus(status string) domain.PRCheckStatus {
	switch status {
	case "success":
		return domain.PRCheckPassed
	case "failed":
		return domain.PRCheckFailed
	case "canceled":
		return domain.PRCheckCancelled
	case "running", "preparing":
		return domain.PRCheckInProgress
	case "pending", "created", "waiting_for_resource", "scheduled":
		return domain.PRCheckQueued
	case "skipped", "manual":
		return domain.PRCheckSkipped
	default:
		return domain.PRCheckUnknown
	}
}

func isFailingCheckStatus(s domain.PRCheckStatus) bool {
	return s == domain.PRCheckFailed || s == domain.PRCheckCancelled
}

func mergeabilityFromMR(mr *restMR, ciState, reviewDecision string) ports.SCMMergeabilityObservation {
	ms := effectiveMergeStatus(mr)
	var blockers []string

	switch ms {
	case "can_be_merged":
		mergeable := true
		if ciState == string(domain.CIFailing) {
			blockers = append(blockers, "ci_failing")
			mergeable = false
		}
		if reviewDecision == string(domain.ReviewRequired) {
			blockers = append(blockers, "review_required")
			mergeable = false
		}
		if mr.Draft {
			blockers = append(blockers, "draft")
			mergeable = false
		}
		if mergeable {
			return ports.SCMMergeabilityObservation{
				State:     string(domain.MergeMergeable),
				Mergeable: true,
			}
		}
		return ports.SCMMergeabilityObservation{
			State:    string(domain.MergeBlocked),
			Blockers: blockers,
		}

	case "cannot_be_merged", "cannot_be_merged_recheck":
		return ports.SCMMergeabilityObservation{
			State:    string(domain.MergeConflicting),
			Conflict: true,
			Blockers: []string{"conflicts"},
		}

	case "checking", "unchecked", "":
		return ports.SCMMergeabilityObservation{
			State: string(domain.MergeUnknown),
		}

	case "ci_must_pass", "ci_still_running":
		return ports.SCMMergeabilityObservation{
			State:    string(domain.MergeBlocked),
			Blockers: []string{"ci_failing"},
		}

	case "discussions_not_resolved":
		return ports.SCMMergeabilityObservation{
			State:    string(domain.MergeBlocked),
			Blockers: []string{"discussions_unresolved"},
		}

	case "draft_status":
		return ports.SCMMergeabilityObservation{
			State:    string(domain.MergeBlocked),
			Blockers: []string{"draft"},
		}

	case "not_approved":
		return ports.SCMMergeabilityObservation{
			State:    string(domain.MergeBlocked),
			Blockers: []string{"review_required"},
		}

	default:
		return ports.SCMMergeabilityObservation{
			State:    string(domain.MergeBlocked),
			Blockers: []string{"blocked_by_provider"},
		}
	}
}

var botUsernameRe = regexp.MustCompile(`^project_\d+_bot`)

func isBotAuthor(username string) bool {
	if strings.HasSuffix(username, "[bot]") || strings.HasSuffix(username, "-bot") {
		return true
	}
	switch username {
	case "gitlab-bot", "ghost", "dependabot[bot]", "renovate[bot]",
		"sast-bot", "codeclimate[bot]", "sonarcloud[bot]", "snyk-bot":
		return true
	}
	return botUsernameRe.MatchString(username)
}

func gitlabFailedFingerprint(headSHA string, checks []ports.SCMCheckObservation) string {
	if len(checks) == 0 {
		return ""
	}
	parts := make([]string, len(checks))
	for i, c := range checks {
		parts[i] = headSHA + "\x00" + c.Name + "\x00" + c.Status + "\x00" + c.Conclusion + "\x00" + c.URL + "\x00" + c.ProviderID
	}
	sort.Strings(parts)
	h := sha256.Sum256([]byte(strings.Join(parts, "\x1e")))
	return hex.EncodeToString(h[:])
}

func tailLines(s string, n int) string {
	lines := strings.Split(s, "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}
