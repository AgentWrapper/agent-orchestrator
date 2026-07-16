package gitlab

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type gitlabUser struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Bot      bool   `json:"bot"`
	Type     string `json:"type"`
}

type mergeRequestPayload struct {
	IID                  int        `json:"iid"`
	State                string     `json:"state"`
	Draft                bool       `json:"draft"`
	WorkInProgress       bool       `json:"work_in_progress"`
	Title                string     `json:"title"`
	WebURL               string     `json:"web_url"`
	SourceBranch         string     `json:"source_branch"`
	TargetBranch         string     `json:"target_branch"`
	SHA                  string     `json:"sha"`
	SourceProjectID      int64      `json:"source_project_id"`
	TargetProjectID      int64      `json:"target_project_id"`
	Author               gitlabUser `json:"author"`
	DetailedMergeStatus  string     `json:"detailed_merge_status"`
	MergeStatus          string     `json:"merge_status"`
	HasConflicts         bool       `json:"has_conflicts"`
	DivergedCommitsCount int        `json:"diverged_commits_count"`
	MergeCommitSHA       string     `json:"merge_commit_sha"`
	SquashCommitSHA      string     `json:"squash_commit_sha"`
	CreatedAt            string     `json:"created_at"`
	UpdatedAt            string     `json:"updated_at"`
	MergedAt             string     `json:"merged_at"`
	ClosedAt             string     `json:"closed_at"`
	DiffRefs             struct {
		BaseSHA  string `json:"base_sha"`
		HeadSHA  string `json:"head_sha"`
		StartSHA string `json:"start_sha"`
	} `json:"diff_refs"`
}

type projectPayload struct {
	ID                int64  `json:"id"`
	PathWithNamespace string `json:"path_with_namespace"`
}

type pipelinePayload struct {
	ID        int64  `json:"id"`
	SHA       string `json:"sha"`
	Status    string `json:"status"`
	WebURL    string `json:"web_url"`
	UpdatedAt string `json:"updated_at"`
}

type jobPayload struct {
	ID                 int64            `json:"id"`
	Name               string           `json:"name"`
	Status             string           `json:"status"`
	WebURL             string           `json:"web_url"`
	Retried            bool             `json:"retried"`
	DownstreamPipeline *pipelinePayload `json:"downstream_pipeline"`
}

type approvalsPayload struct {
	Approved          bool `json:"approved"`
	ApprovalsRequired int  `json:"approvals_required"`
	ApprovalsLeft     int  `json:"approvals_left"`
	ApprovedBy        []struct {
		User gitlabUser `json:"user"`
	} `json:"approved_by"`
}

type discussionPayload struct {
	ID    string        `json:"id"`
	Notes []notePayload `json:"notes"`
}

type notePayload struct {
	ID         int64      `json:"id"`
	Body       string     `json:"body"`
	WebURL     string     `json:"web_url"`
	System     bool       `json:"system"`
	Resolvable bool       `json:"resolvable"`
	Resolved   bool       `json:"resolved"`
	Author     gitlabUser `json:"author"`
	Position   struct {
		NewPath string `json:"new_path"`
		OldPath string `json:"old_path"`
		NewLine int    `json:"new_line"`
		OldLine int    `json:"old_line"`
	} `json:"position"`
}

type diffStats struct {
	Additions    int
	Deletions    int
	ChangedFiles int
	Complete     bool
}

func normalizeRawDiff(raw []byte) diffStats {
	if len(raw) == 0 || !utf8.Valid(raw) {
		return diffStats{}
	}
	stats := diffStats{Complete: true}
	for _, line := range strings.Split(string(raw), "\n") {
		switch {
		case strings.HasPrefix(line, "diff --git "):
			stats.ChangedFiles++
		case strings.HasPrefix(line, "+++") || strings.HasPrefix(line, "---"):
		case strings.HasPrefix(line, "+"):
			stats.Additions++
		case strings.HasPrefix(line, "-"):
			stats.Deletions++
		}
	}
	if stats.ChangedFiles == 0 {
		return diffStats{}
	}
	return stats
}

func normalizeMR(mr mergeRequestPayload, headRepo string, stats diffStats) ports.SCMPRObservation {
	draft := mr.Draft || mr.WorkInProgress
	merged := strings.EqualFold(mr.State, "merged")
	closed := strings.EqualFold(mr.State, "closed") && !merged
	state := domain.PRStateOpen
	switch {
	case merged:
		state = domain.PRStateMerged
	case closed:
		state = domain.PRStateClosed
	case draft:
		state = domain.PRStateDraft
	}
	mergeCommit := mr.MergeCommitSHA
	if mergeCommit == "" {
		mergeCommit = mr.SquashCommitSHA
	}
	mergeStatus := mr.DetailedMergeStatus
	if mergeStatus == "" {
		mergeStatus = mr.MergeStatus
	}
	providerMergeable := "unknown"
	if mr.HasConflicts || mergeStatus == "conflict" {
		providerMergeable = "conflicting"
	} else if mergeStatus == "mergeable" {
		providerMergeable = "mergeable"
	} else if mergeStatus != "" {
		providerMergeable = "blocked"
	}
	return ports.SCMPRObservation{
		URL: mr.WebURL, HTMLURL: mr.WebURL, Number: mr.IID, State: string(state), Draft: draft, Merged: merged, Closed: closed,
		SourceBranch: mr.SourceBranch, HeadRepo: headRepo, TargetBranch: mr.TargetBranch,
		HeadSHA: firstNonEmptyString(mr.DiffRefs.HeadSHA, mr.SHA), BaseSHA: mr.DiffRefs.BaseSHA,
		Title: mr.Title, Additions: stats.Additions, Deletions: stats.Deletions, ChangedFiles: stats.ChangedFiles,
		DiffStatsComplete: stats.Complete, Author: mr.Author.Username, MergeCommitSHA: mergeCommit,
		ProviderState: mr.State, ProviderMergeable: providerMergeable, ProviderMergeStateStatus: mergeStatus,
		CreatedAtProvider: parseGitLabTime(mr.CreatedAt), UpdatedAtProvider: parseGitLabTime(mr.UpdatedAt),
		MergedAtProvider: parseGitLabTime(mr.MergedAt), ClosedAtProvider: parseGitLabTime(mr.ClosedAt),
	}
}

func normalizeJobStatus(status string) domain.PRCheckStatus {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "success":
		return domain.PRCheckPassed
	case "failed":
		return domain.PRCheckFailed
	case "canceled":
		return domain.PRCheckCancelled
	case "running":
		return domain.PRCheckInProgress
	case "created", "waiting_for_resource", "preparing", "pending", "scheduled":
		return domain.PRCheckQueued
	case "skipped":
		return domain.PRCheckSkipped
	default:
		return domain.PRCheckUnknown
	}
}

func normalizeJobs(jobs []jobPayload) []ports.SCMCheckObservation {
	out := make([]ports.SCMCheckObservation, 0, len(jobs))
	for _, job := range jobs {
		if job.Retried || job.ID <= 0 || strings.TrimSpace(job.Name) == "" {
			continue
		}
		status := job.Status
		if job.DownstreamPipeline != nil {
			status = job.DownstreamPipeline.Status
		}
		out = append(out, ports.SCMCheckObservation{
			Name: job.Name, Status: string(normalizeJobStatus(status)), Conclusion: strings.ToLower(status),
			URL: job.WebURL, ProviderID: strconv.FormatInt(job.ID, 10),
		})
	}
	return out
}

func aggregateCI(pipelineStatus string, checks []ports.SCMCheckObservation) domain.CIState {
	failed, pending, unknown, passed := false, false, false, false
	for _, check := range checks {
		switch domain.PRCheckStatus(check.Status) {
		case domain.PRCheckFailed, domain.PRCheckCancelled:
			failed = true
		case domain.PRCheckQueued, domain.PRCheckInProgress:
			pending = true
		case domain.PRCheckPassed:
			passed = true
		default:
			unknown = true
		}
	}
	switch strings.ToLower(pipelineStatus) {
	case "failed", "canceled":
		failed = true
	case "created", "waiting_for_resource", "preparing", "pending", "running", "scheduled":
		pending = true
	case "skipped", "manual":
		unknown = true
	case "success":
		if len(checks) == 0 {
			passed = true
		}
	default:
		unknown = true
	}
	switch {
	case failed:
		return domain.CIFailing
	case pending:
		return domain.CIPending
	case unknown:
		return domain.CIUnknown
	case passed:
		return domain.CIPassing
	default:
		return domain.CIUnknown
	}
}

func failedChecks(checks []ports.SCMCheckObservation) []ports.SCMCheckObservation {
	out := make([]ports.SCMCheckObservation, 0)
	for _, check := range checks {
		status := domain.PRCheckStatus(check.Status)
		if status == domain.PRCheckFailed || status == domain.PRCheckCancelled {
			out = append(out, check)
		}
	}
	return out
}

func failedFingerprint(head string, checks []ports.SCMCheckObservation) string {
	if len(checks) == 0 {
		return ""
	}
	parts := make([]string, 0, len(checks))
	for _, check := range checks {
		parts = append(parts, strings.Join([]string{head, check.ProviderID, check.Name, check.Status, check.Conclusion}, "\x00"))
	}
	sort.Strings(parts)
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x1e")))
	return hex.EncodeToString(sum[:])
}

func approvalDecision(status string, approval approvalsPayload) (domain.ReviewDecision, bool) {
	if strings.EqualFold(status, "requested_changes") {
		return domain.ReviewChangesRequest, false
	}
	satisfied := approval.Approved || approval.ApprovalsLeft == 0
	if approval.ApprovalsLeft > 0 || strings.EqualFold(status, "not_approved") {
		return domain.ReviewRequired, false
	}
	if approval.Approved {
		return domain.ReviewApproved, true
	}
	return domain.ReviewNone, satisfied
}

func approvalReviews(approval approvalsPayload, mrURL string) []ports.SCMReviewSummaryObservation {
	out := make([]ports.SCMReviewSummaryObservation, 0, len(approval.ApprovedBy))
	for _, item := range approval.ApprovedBy {
		out = append(out, ports.SCMReviewSummaryObservation{
			ID: strconv.FormatInt(item.User.ID, 10), Author: item.User.Username,
			State: string(domain.ReviewApproved), URL: mrURL, IsBot: isGitLabBot(item.User),
		})
	}
	return out
}

func normalizeMergeability(status string, conflicts, draft bool, ci domain.CIState, review domain.ReviewDecision, approvalsSatisfied bool) ports.SCMMergeabilityObservation {
	state := strings.ToLower(strings.TrimSpace(status))
	out := ports.SCMMergeabilityObservation{State: string(domain.MergeUnknown)}
	add := func(blocker string) {
		if !stringSliceContains(out.Blockers, blocker) {
			out.Blockers = append(out.Blockers, blocker)
		}
	}
	if conflicts || state == "conflict" {
		out.State = string(domain.MergeConflicting)
		out.Conflict = true
		add("conflicts")
		return out
	}
	if state == "need_rebase" {
		out.State = string(domain.MergeBlocked)
		out.BehindBase = true
		add("behind_base")
	}
	if state == "checking" || state == "preparing" || state == "unchecked" {
		add("checking")
		return out
	}
	switch state {
	case "not_approved":
		out.State = string(domain.MergeBlocked)
		add("review_required")
	case "requested_changes":
		out.State = string(domain.MergeBlocked)
		add("changes_requested")
	case "discussions_not_resolved":
		out.State = string(domain.MergeBlocked)
		add("discussions_not_resolved")
	}
	if draft {
		out.State = string(domain.MergeBlocked)
		add("draft")
	}
	switch ci {
	case domain.CIFailing:
		out.State = string(domain.MergeBlocked)
		add("ci_failing")
	case domain.CIPending:
		out.State = string(domain.MergeBlocked)
		add("ci_pending")
	case domain.CIUnknown:
		add("ci_unknown")
	}
	switch review {
	case domain.ReviewChangesRequest:
		out.State = string(domain.MergeBlocked)
		add("changes_requested")
	case domain.ReviewRequired:
		out.State = string(domain.MergeBlocked)
		add("review_required")
	}
	if !approvalsSatisfied {
		out.State = string(domain.MergeBlocked)
		add("review_required")
	}
	if out.State == string(domain.MergeBlocked) {
		return out
	}
	if state == "mergeable" && ci == domain.CIPassing && approvalsSatisfied && !draft {
		out.State = string(domain.MergeMergeable)
		out.Mergeable = true
	}
	return out
}

func normalizeDiscussion(discussion discussionPayload, mrURL string) (ports.SCMReviewThreadObservation, bool) {
	thread := ports.SCMReviewThreadObservation{ID: discussion.ID, Resolved: true}
	hasHuman := false
	hasResolvable := false
	for _, note := range discussion.Notes {
		if note.System {
			continue
		}
		bot := isGitLabBot(note.Author)
		if !bot {
			hasHuman = true
		}
		if note.Resolvable {
			hasResolvable = true
			if !note.Resolved {
				thread.Resolved = false
			}
		}
		if thread.Path == "" {
			thread.Path = firstNonEmptyString(note.Position.NewPath, note.Position.OldPath)
			thread.Line = note.Position.NewLine
			if thread.Line == 0 {
				thread.Line = note.Position.OldLine
			}
		}
		url := note.WebURL
		if url == "" && note.ID > 0 && mrURL != "" {
			url = fmt.Sprintf("%s#note_%d", mrURL, note.ID)
		}
		thread.Comments = append(thread.Comments, ports.SCMReviewCommentObservation{
			ID: strconv.FormatInt(note.ID, 10), Author: note.Author.Username, Body: note.Body, URL: url, IsBot: bot,
		})
	}
	thread.IsBot = !hasHuman
	return thread, hasResolvable && hasHuman
}

func isGitLabBot(user gitlabUser) bool {
	return user.Bot || strings.EqualFold(user.Type, "bot")
}

var secretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(PRIVATE-TOKEN\s*[:=]\s*)\S+`),
	regexp.MustCompile(`(?i)(Authorization\s*[:=]\s*(?:Bearer\s+)?)\S+`),
	regexp.MustCompile(`\bglpat-[A-Za-z0-9_-]+\b`),
}

func sanitizeTrace(raw []byte) string {
	text := strings.ToValidUTF8(string(raw), "")
	for i, pattern := range secretPatterns {
		if i < 2 {
			text = pattern.ReplaceAllString(text, "${1}[REDACTED]")
		} else {
			text = pattern.ReplaceAllString(text, "[REDACTED]")
		}
	}
	lines := strings.Split(strings.TrimRight(text, "\r\n"), "\n")
	if len(lines) > 20 {
		lines = lines[len(lines)-20:]
	}
	return strings.Join(lines, "\n")
}

func parseGitLabTime(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}
	}
	return parsed
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func stringSliceContains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
