package gitlab

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// RepoPRListGuard fetches the cheapest open-MR page. GitLab instances that do
// not expose a validator always return NotModified=false.
func (p *Provider) RepoPRListGuard(ctx context.Context, repo ports.SCMRepo, revision string) (ports.SCMGuardResult, error) {
	query := url.Values{"state": {"opened"}, "order_by": {"updated_at"}, "sort": {"desc"}, "per_page": {"1"}}
	var response Response
	err := p.withSlot(ctx, func() error {
		var err error
		headers := http.Header{}
		if strings.TrimSpace(revision) != "" {
			headers.Set("If-None-Match", revision)
		}
		response, err = p.client.doJSONWithHeaders(ctx, http.MethodGet, "/projects/"+EncodedProjectPath(projectPath(repo))+"/merge_requests", query, headers, nil, nil)
		return err
	})
	if err != nil {
		return ports.SCMGuardResult{}, p.apiError("guard open merge requests", err)
	}
	etag := firstNonEmptyString(strings.TrimSpace(response.Header.Get("ETag")), revision)
	return ports.SCMGuardResult{ETag: etag, NotModified: response.StatusCode == http.StatusNotModified}, nil
}

// ListOpenPRsByRepo returns every open MR and resolves fork source projects so
// branch attribution never mistakes a same-named fork branch for a local one.
func (p *Provider) ListOpenPRsByRepo(ctx context.Context, repo ports.SCMRepo) ([]ports.SCMPRObservation, error) {
	query := url.Values{"state": {"opened"}, "order_by": {"updated_at"}, "sort": {"desc"}, "per_page": {"100"}}
	var payloads []mergeRequestPayload
	err := p.withSlot(ctx, func() error {
		return p.client.GetJSONPages(ctx, "/projects/"+EncodedProjectPath(projectPath(repo))+"/merge_requests", query, func(body []byte) error {
			var page []mergeRequestPayload
			if err := json.Unmarshal(body, &page); err != nil {
				return errors.New("gitlab scm: decode merge request list")
			}
			payloads = append(payloads, page...)
			return nil
		})
	})
	if err != nil {
		return nil, p.apiError("list open merge requests", err)
	}
	paths, err := p.resolveSourceProjects(ctx, payloads)
	if err != nil {
		return nil, err
	}
	out := make([]ports.SCMPRObservation, 0, len(payloads))
	for _, mr := range payloads {
		headRepo := projectPath(repo)
		if mr.SourceProjectID != 0 && mr.SourceProjectID != mr.TargetProjectID {
			headRepo = paths[mr.SourceProjectID]
			if headRepo == "" {
				return nil, errors.New("gitlab scm: source project response missing path")
			}
		}
		out = append(out, normalizeMR(mr, headRepo, diffStats{}))
	}
	return out, nil
}

// CommitChecksGuard returns a synthetic revision for the newest pipeline on
// the requested commit. It always consults GitLab before declaring a match.
func (p *Provider) CommitChecksGuard(ctx context.Context, repo ports.SCMRepo, headSHA, revision string) (ports.SCMGuardResult, error) {
	if strings.TrimSpace(headSHA) == "" {
		return ports.SCMGuardResult{}, fmt.Errorf("%w: empty head sha", ports.ErrSCMNotFound)
	}
	pipelines, err := p.listPipelines(ctx, "/projects/"+EncodedProjectPath(projectPath(repo))+"/pipelines", url.Values{
		"sha": {headSHA}, "order_by": {"id"}, "sort": {"desc"}, "per_page": {"100"},
	})
	if err != nil {
		return ports.SCMGuardResult{}, err
	}
	latest, ok := selectPipeline(pipelines, headSHA)
	material := "none\x00" + headSHA
	if ok {
		material = fmt.Sprintf("%d\x00%s\x00%s\x00%s", latest.ID, latest.SHA, latest.Status, latest.UpdatedAt)
	}
	sum := sha256.Sum256([]byte(material))
	next := hex.EncodeToString(sum[:])
	return ports.SCMGuardResult{ETag: next, NotModified: revision != "" && revision == next}, nil
}

// FetchPullRequests fetches refs concurrently while the provider-wide request
// semaphore limits all GitLab calls to four in flight. Missing MRs are omitted;
// remaining observations preserve input order.
func (p *Provider) FetchPullRequests(ctx context.Context, refs []ports.SCMPRRef) ([]ports.SCMObservation, error) {
	if len(refs) == 0 {
		return nil, nil
	}
	results := make([]ports.SCMObservation, len(refs))
	found := make([]bool, len(refs))
	errs := make([]error, len(refs))
	var wg sync.WaitGroup
	for i := range refs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			observation, err := p.fetchPullRequest(ctx, refs[i])
			if errors.Is(err, ports.ErrSCMNotFound) {
				return
			}
			if err != nil {
				errs[i] = err
				return
			}
			results[i] = observation
			found[i] = true
		}()
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	out := make([]ports.SCMObservation, 0, len(refs))
	for i := range results {
		if found[i] {
			out = append(out, results[i])
		}
	}
	return out, nil
}

func (p *Provider) fetchPullRequest(ctx context.Context, ref ports.SCMPRRef) (ports.SCMObservation, error) {
	query := url.Values{"include_diverged_commits_count": {"true"}, "with_merge_status_recheck": {"true"}}
	var mr mergeRequestPayload
	if err := p.getJSON(ctx, mrAPIPath(ref.Repo, ref.Number), query, &mr); err != nil {
		return ports.SCMObservation{}, p.apiError("fetch merge request", err)
	}
	if mr.IID == 0 {
		mr.IID = ref.Number
	}
	headRepo := projectPath(ref.Repo)
	if mr.SourceProjectID != 0 && mr.SourceProjectID != mr.TargetProjectID {
		project, err := p.fetchProject(ctx, mr.SourceProjectID)
		if err != nil {
			return ports.SCMObservation{}, err
		}
		headRepo = project.PathWithNamespace
		if headRepo == "" {
			return ports.SCMObservation{}, errors.New("gitlab scm: source project response missing path")
		}
	}
	stats := diffStats{}
	raw, err := p.getRaw(ctx, mrAPIPath(ref.Repo, ref.Number, "raw_diffs"), nil)
	if err != nil {
		if !errors.Is(err, ErrResponseTooLarge) {
			return ports.SCMObservation{}, p.apiError("fetch merge request diff", err)
		}
	} else {
		stats = normalizeRawDiff(raw)
	}
	pr := normalizeMR(mr, headRepo, stats)
	if pr.URL == "" {
		pr.URL = firstNonEmptyString(ref.URL, p.mergeRequestURL(projectPath(ref.Repo), ref.Number))
		pr.HTMLURL = pr.URL
	}
	obs := ports.SCMObservation{
		Fetched: true, ObservedAt: p.client.now().UTC(), Provider: "gitlab", Host: ref.Repo.Host,
		Repo: projectPath(ref.Repo), PR: pr,
		CI:           ports.SCMCIObservation{Summary: string(domain.CIUnknown), HeadSHA: pr.HeadSHA},
		Review:       ports.SCMReviewObservation{Decision: string(domain.ReviewNone)},
		Mergeability: ports.SCMMergeabilityObservation{State: string(domain.MergeUnknown)},
	}
	if pr.Merged || pr.Closed {
		return obs, nil
	}
	ci, err := p.fetchCI(ctx, ref.Repo, ref.Number, pr.HeadSHA)
	if err != nil {
		return ports.SCMObservation{}, err
	}
	approval, err := p.fetchApprovals(ctx, ref.Repo, ref.Number)
	if err != nil {
		return ports.SCMObservation{}, err
	}
	status := pr.ProviderMergeStateStatus
	decision, satisfied := approvalDecision(status, approval)
	obs.CI = ci
	obs.Review = ports.SCMReviewObservation{Decision: string(decision), Reviews: approvalReviews(approval, pr.URL)}
	obs.Mergeability = normalizeMergeability(status, mr.HasConflicts, pr.Draft, domain.CIState(ci.Summary), decision, satisfied)
	if mr.DivergedCommitsCount > 0 && !obs.Mergeability.Conflict {
		obs.Mergeability.State = string(domain.MergeBlocked)
		obs.Mergeability.Mergeable = false
		obs.Mergeability.BehindBase = true
		if !stringSliceContains(obs.Mergeability.Blockers, "behind_base") {
			obs.Mergeability.Blockers = append(obs.Mergeability.Blockers, "behind_base")
		}
	}
	return obs, nil
}

// FetchFailedCheckLogTail fetches a bounded GitLab job trace and returns only a
// scrubbed 20-line tail.
func (p *Provider) FetchFailedCheckLogTail(ctx context.Context, repo ports.SCMRepo, check ports.SCMCheckObservation) (string, error) {
	if strings.TrimSpace(check.ProviderID) == "" {
		return "", nil
	}
	jobID, err := strconv.ParseInt(check.ProviderID, 10, 64)
	if err != nil || jobID <= 0 {
		return "", errors.New("gitlab scm: invalid job id")
	}
	raw, err := p.getRaw(ctx, "/projects/"+EncodedProjectPath(projectPath(repo))+"/jobs/"+strconv.FormatInt(jobID, 10)+"/trace", nil)
	if err != nil {
		return "", p.apiError("fetch job trace", err)
	}
	return sanitizeTrace(raw), nil
}

// FetchReviewThreads reads approval state and a bounded paginated discussion
// window. System and bot-only discussions cannot trigger human review work.
func (p *Provider) FetchReviewThreads(ctx context.Context, ref ports.SCMPRRef) (ports.SCMReviewObservation, error) {
	var mr mergeRequestPayload
	if err := p.getJSON(ctx, mrAPIPath(ref.Repo, ref.Number), nil, &mr); err != nil {
		return ports.SCMReviewObservation{}, p.apiError("fetch merge request review state", err)
	}
	approval, err := p.fetchApprovals(ctx, ref.Repo, ref.Number)
	if err != nil {
		return ports.SCMReviewObservation{}, err
	}
	status := firstNonEmptyString(mr.DetailedMergeStatus, mr.MergeStatus)
	decision, _ := approvalDecision(status, approval)
	mrURL := firstNonEmptyString(mr.WebURL, ref.URL, p.mergeRequestURL(projectPath(ref.Repo), ref.Number))
	out := ports.SCMReviewObservation{Decision: string(decision), Reviews: approvalReviews(approval, mrURL)}
	page := 1
	for ; page <= p.maxDiscussionPages; page++ {
		query := url.Values{"per_page": {"100"}, "page": {strconv.Itoa(page)}}
		var response Response
		var discussions []discussionPayload
		err := p.withSlot(ctx, func() error {
			var callErr error
			response, callErr = p.client.DoJSON(ctx, http.MethodGet, mrAPIPath(ref.Repo, ref.Number, "discussions"), query, nil, &discussions)
			return callErr
		})
		if err != nil {
			return ports.SCMReviewObservation{}, p.apiError("fetch merge request discussions", err)
		}
		for _, discussion := range discussions {
			thread, keep := normalizeDiscussion(discussion, mrURL)
			if keep {
				out.Threads = append(out.Threads, thread)
			}
		}
		next, hasNext, paginationErr := discussionNextPage(response.Header, page)
		if paginationErr != nil {
			return ports.SCMReviewObservation{}, paginationErr
		}
		if !hasNext {
			break
		}
		if page == p.maxDiscussionPages {
			out.Partial = true
			break
		}
		if next != page+1 {
			return ports.SCMReviewObservation{}, ErrInvalidPagination
		}
	}
	return out, nil
}

func (p *Provider) fetchCI(ctx context.Context, repo ports.SCMRepo, iid int, headSHA string) (ports.SCMCIObservation, error) {
	pipelines, err := p.listPipelines(ctx, mrAPIPath(repo, iid, "pipelines"), url.Values{"per_page": {"100"}})
	if err != nil {
		return ports.SCMCIObservation{}, err
	}
	pipeline, ok := selectPipeline(pipelines, headSHA)
	if !ok {
		pipelines, err = p.listPipelines(ctx, "/projects/"+EncodedProjectPath(projectPath(repo))+"/pipelines", url.Values{
			"sha": {headSHA}, "order_by": {"id"}, "sort": {"desc"}, "per_page": {"100"},
		})
		if err != nil {
			return ports.SCMCIObservation{}, err
		}
		pipeline, ok = selectPipeline(pipelines, headSHA)
	}
	if !ok {
		return ports.SCMCIObservation{Summary: string(domain.CIUnknown), HeadSHA: headSHA}, nil
	}
	jobs, err := p.listJobs(ctx, "/projects/"+EncodedProjectPath(projectPath(repo))+"/pipelines/"+strconv.FormatInt(pipeline.ID, 10)+"/jobs", url.Values{
		"include_retried": {"false"}, "per_page": {"100"},
	})
	if err != nil {
		return ports.SCMCIObservation{}, err
	}
	bridges, err := p.listJobs(ctx, "/projects/"+EncodedProjectPath(projectPath(repo))+"/pipelines/"+strconv.FormatInt(pipeline.ID, 10)+"/bridges", url.Values{"per_page": {"100"}})
	if err != nil && !errors.Is(err, ports.ErrSCMNotFound) {
		return ports.SCMCIObservation{}, err
	}
	checks := append(normalizeJobs(jobs), normalizeJobs(bridges)...)
	failed := failedChecks(checks)
	return ports.SCMCIObservation{
		Summary: string(aggregateCI(pipeline.Status, checks)), HeadSHA: headSHA, Checks: checks,
		FailedChecks: failed, FailedFingerprint: failedFingerprint(headSHA, failed),
	}, nil
}

func (p *Provider) listPipelines(ctx context.Context, endpoint string, query url.Values) ([]pipelinePayload, error) {
	var out []pipelinePayload
	err := p.withSlot(ctx, func() error {
		return p.client.GetJSONPages(ctx, endpoint, query, func(body []byte) error {
			var page []pipelinePayload
			if err := json.Unmarshal(body, &page); err != nil {
				return errors.New("gitlab scm: decode pipelines")
			}
			out = append(out, page...)
			return nil
		})
	})
	if err != nil {
		return nil, p.apiError("list pipelines", err)
	}
	return out, nil
}

func (p *Provider) listJobs(ctx context.Context, endpoint string, query url.Values) ([]jobPayload, error) {
	var out []jobPayload
	err := p.withSlot(ctx, func() error {
		return p.client.GetJSONPages(ctx, endpoint, query, func(body []byte) error {
			var page []jobPayload
			if err := json.Unmarshal(body, &page); err != nil {
				return errors.New("gitlab scm: decode jobs")
			}
			out = append(out, page...)
			return nil
		})
	})
	if err != nil {
		return nil, p.apiError("list pipeline jobs", err)
	}
	return out, nil
}

func selectPipeline(pipelines []pipelinePayload, headSHA string) (pipelinePayload, bool) {
	candidates := make([]pipelinePayload, 0, len(pipelines))
	for _, pipeline := range pipelines {
		if pipeline.SHA == headSHA {
			candidates = append(candidates, pipeline)
		}
	}
	if len(candidates) == 0 {
		return pipelinePayload{}, false
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		iTime := parseGitLabTime(candidates[i].UpdatedAt)
		jTime := parseGitLabTime(candidates[j].UpdatedAt)
		if !iTime.Equal(jTime) {
			return iTime.After(jTime)
		}
		return candidates[i].ID > candidates[j].ID
	})
	return candidates[0], true
}

func (p *Provider) fetchApprovals(ctx context.Context, repo ports.SCMRepo, iid int) (approvalsPayload, error) {
	var approval approvalsPayload
	if err := p.getJSON(ctx, mrAPIPath(repo, iid, "approvals"), nil, &approval); err != nil {
		return approvalsPayload{}, p.apiError("fetch merge request approvals", err)
	}
	return approval, nil
}

func (p *Provider) resolveSourceProjects(ctx context.Context, mergeRequests []mergeRequestPayload) (map[int64]string, error) {
	ids := map[int64]struct{}{}
	for _, mr := range mergeRequests {
		if mr.SourceProjectID != 0 && mr.SourceProjectID != mr.TargetProjectID {
			ids[mr.SourceProjectID] = struct{}{}
		}
	}
	out := map[int64]string{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	var firstErr error
	for id := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			project, err := p.fetchProject(ctx, id)
			mu.Lock()
			defer mu.Unlock()
			if err != nil && firstErr == nil {
				firstErr = err
				return
			}
			out[id] = project.PathWithNamespace
		}()
	}
	wg.Wait()
	return out, firstErr
}

func (p *Provider) fetchProject(ctx context.Context, id int64) (projectPayload, error) {
	var project projectPayload
	if err := p.getJSON(ctx, "/projects/"+strconv.FormatInt(id, 10), nil, &project); err != nil {
		return projectPayload{}, p.apiError("fetch source project", err)
	}
	return project, nil
}

func (p *Provider) getJSON(ctx context.Context, endpoint string, query url.Values, out any) error {
	return p.withSlot(ctx, func() error {
		_, err := p.client.DoJSON(ctx, http.MethodGet, endpoint, query, nil, out)
		return err
	})
}

func (p *Provider) getRaw(ctx context.Context, endpoint string, query url.Values) ([]byte, error) {
	var body []byte
	err := p.withSlot(ctx, func() error {
		var err error
		body, err = p.client.GetRaw(ctx, endpoint, query)
		return err
	})
	return body, err
}

func discussionNextPage(header http.Header, current int) (int, bool, error) {
	if raw := strings.TrimSpace(header.Get("X-Next-Page")); raw != "" {
		page, err := strconv.Atoi(raw)
		if err != nil || page <= current {
			return 0, false, ErrInvalidPagination
		}
		return page, true, nil
	}
	if raw := linkNext(header.Get("Link")); raw != "" {
		next, err := url.Parse(raw)
		if err != nil {
			return 0, false, ErrInvalidPagination
		}
		page, err := strconv.Atoi(next.Query().Get("page"))
		if err != nil || page <= current {
			return 0, false, ErrInvalidPagination
		}
		return page, true, nil
	}
	return 0, false, nil
}
