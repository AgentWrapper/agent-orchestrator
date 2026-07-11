package notify

import (
	"fmt"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func enrich(intent Intent) (domain.NotificationRecord, error) {
	rec := domain.NotificationRecord{
		SessionID:    intent.SessionID,
		ProjectID:    intent.ProjectID,
		PRURL:        strings.TrimSpace(intent.PRURL),
		Type:         intent.Type,
		Status:       domain.NotificationUnread,
		CreatedAt:    intent.CreatedAt,
		Sensitive:    intent.Sensitive,
		ChangedPaths: append([]string(nil), intent.ChangedPaths...),
		HeadSHA:      strings.TrimSpace(intent.HeadSHA),
	}
	if !intent.Type.Valid() {
		return domain.NotificationRecord{}, domain.ErrInvalidNotificationType
	}
	if notificationRequiresPR(intent.Type) && rec.PRURL == "" {
		return domain.NotificationRecord{}, domain.ErrInvalidNotificationRecord
	}
	rec.Title = titleForIntent(intent)
	rec.Body = bodyForIntent(intent)
	if err := rec.Validate(); err != nil {
		return domain.NotificationRecord{}, err
	}
	return rec, nil
}

func notificationRequiresPR(t domain.NotificationType) bool {
	switch t {
	case domain.NotificationReadyToMerge, domain.NotificationPRMerged, domain.NotificationPRClosedUnmerged, domain.NotificationDuplicatePR:
		return true
	default:
		return false
	}
}

func titleForIntent(intent Intent) string {
	switch intent.Type {
	case domain.NotificationNeedsInput:
		return fmt.Sprintf("%s needs input", sessionLabel(intent))
	case domain.NotificationReadyToMerge:
		return fmt.Sprintf("%s is ready to merge", prLabel(intent))
	case domain.NotificationPRMerged:
		return fmt.Sprintf("%s was merged", prLabel(intent))
	case domain.NotificationPRClosedUnmerged:
		return fmt.Sprintf("%s was closed without merging", prLabel(intent))
	case domain.NotificationOrchestratorReplaced:
		return fmt.Sprintf("%s was replaced", sessionLabel(intent))
	case domain.NotificationOrchestratorReplacementCapped:
		return fmt.Sprintf("%s replacement paused", sessionLabel(intent))
	case domain.NotificationDuplicatePR:
		return fmt.Sprintf("Duplicate %s for the same issue", prLabel(intent))
	case domain.NotificationWorkerDiedUnfinished:
		return fmt.Sprintf("worker died with unfinished work: issue %s", issueLabel(intent))
	case domain.NotificationWorkerRetryExhausted:
		return fmt.Sprintf("worker retry cap exhausted: issue %s", issueLabel(intent))
	case domain.NotificationModelUnreachable:
		return fmt.Sprintf("%s model unreachable", modelLabel(intent))
	case domain.NotificationModelRecovered:
		return fmt.Sprintf("%s model recovered", modelLabel(intent))
	case domain.NotificationMainCIRed:
		// Main-CI alerts reuse ChangedPaths to carry failed job names until the
		// notification record grows a dedicated failed_jobs field.
		return fmt.Sprintf("main is red at %s: %s", shortSHA(intent.HeadSHA), failedJobsLabel(intent.ChangedPaths))
	default:
		return "Notification"
	}
}

func bodyForIntent(intent Intent) string {
	switch intent.Type {
	case domain.NotificationNeedsInput:
		return "The agent is waiting for your response."
	case domain.NotificationReadyToMerge:
		if s := sessionLabel(intent); s != "session" {
			return fmt.Sprintf("%s has no known blocking CI or review feedback.", s)
		}
		return "The pull request has no known blocking CI or review feedback."
	case domain.NotificationPRMerged:
		if title := strings.TrimSpace(intent.PRTitle); title != "" {
			return fmt.Sprintf("%s was merged.", title)
		}
		return "The pull request was merged."
	case domain.NotificationPRClosedUnmerged:
		if title := strings.TrimSpace(intent.PRTitle); title != "" {
			return fmt.Sprintf("%s was closed without merging.", title)
		}
		return "The pull request was closed without merging."
	case domain.NotificationOrchestratorReplaced:
		if intent.SessionKind == domain.KindPrime {
			return "AO replaced an unresponsive prime orchestrator."
		}
		return "AO replaced an unresponsive project orchestrator."
	case domain.NotificationOrchestratorReplacementCapped:
		if intent.SessionKind == domain.KindPrime {
			return "AO stopped replacing the prime orchestrator after repeated failures. Inspect the harness, auth, and hook pipeline."
		}
		return "AO stopped replacing this project orchestrator after repeated failures. Inspect the harness, auth, and hook pipeline."
	case domain.NotificationDuplicatePR:
		return duplicatePRBody(intent)
	case domain.NotificationWorkerDiedUnfinished:
		if intent.RespawnSuppressed {
			return fmt.Sprintf("%s terminated before issue %s landed, but an open PR already exists; ao will not start a duplicate replacement.", sessionLabel(intent), issueLabel(intent))
		}
		return fmt.Sprintf("%s terminated before issue %s landed; ao will dispatch a clean replacement if retry capacity remains.", sessionLabel(intent), issueLabel(intent))
	case domain.NotificationWorkerRetryExhausted:
		return fmt.Sprintf("%s terminated after %d attempts for issue %s; retry cap is %d, so ao is leaving it for a human.", sessionLabel(intent), intent.RetryCount, issueLabel(intent), intent.RetryLimit)
	case domain.NotificationModelUnreachable:
		return fmt.Sprintf("Configured pin %s is unreachable%s.", modelDetail(intent), reasonSuffix(intent.Reason))
	case domain.NotificationModelRecovered:
		return fmt.Sprintf("Configured pin %s is reachable again.", modelDetail(intent))
	case domain.NotificationMainCIRed:
		repo := strings.TrimSpace(intent.Repo)
		if repo == "" {
			repo = "the repository"
		}
		return fmt.Sprintf("Main-branch CI failed for %s at %s. Merge is frozen until main is green; only fix PRs should merge.", repo, shortSHA(intent.HeadSHA))
	default:
		return ""
	}
}

// duplicatePRBody explains which two PRs collided on one issue. The existing PR
// is always named; the issue reference is included when known so the operator
// can see the collision without opening either PR.
func duplicatePRBody(intent Intent) string {
	existing := strings.TrimSpace(intent.DuplicateOfPRURL)
	if existing == "" {
		existing = "another open PR"
	}
	issue := strings.TrimSpace(intent.IssueRef)
	if issue != "" {
		return fmt.Sprintf("This PR duplicates %s for issue %s. Close or adopt one of them.", existing, issue)
	}
	return fmt.Sprintf("This PR duplicates %s for the same issue. Close or adopt one of them.", existing)
}

func modelLabel(intent Intent) string {
	if intent.Model != "" {
		return intent.Model
	}
	return "Configured"
}

func modelDetail(intent Intent) string {
	parts := []string{}
	if intent.ModelScope != "" {
		parts = append(parts, intent.ModelScope)
	}
	if intent.ModelHarness != "" {
		parts = append(parts, string(intent.ModelHarness))
	}
	if intent.Model != "" {
		parts = append(parts, intent.Model)
	}
	if len(parts) == 0 {
		return "model"
	}
	return strings.Join(parts, " / ")
}

func reasonSuffix(reason string) string {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return ""
	}
	return ": " + reason
}

func sessionLabel(intent Intent) string {
	if v := strings.TrimSpace(intent.SessionDisplayName); v != "" {
		return v
	}
	if intent.SessionID != "" {
		return string(intent.SessionID)
	}
	return "session"
}

func prLabel(intent Intent) string {
	if intent.PRNumber > 0 {
		return fmt.Sprintf("PR #%d", intent.PRNumber)
	}
	if title := strings.TrimSpace(intent.PRTitle); title != "" {
		return "PR " + title
	}
	return "PR"
}

func issueLabel(intent Intent) string {
	raw := strings.TrimSpace(string(intent.IssueID))
	if raw == "" {
		return "unknown"
	}
	if i := strings.LastIndexByte(raw, '#'); i >= 0 && i+1 < len(raw) {
		return "#" + raw[i+1:]
	}
	if strings.HasPrefix(raw, "#") {
		return raw
	}
	return "#" + raw
}

func shortSHA(sha string) string {
	sha = strings.TrimSpace(sha)
	if len(sha) > 8 {
		return sha[:8]
	}
	if sha == "" {
		return "unknown"
	}
	return sha
}

func failedJobsLabel(jobs []string) string {
	out := make([]string, 0, len(jobs))
	for _, job := range jobs {
		if trimmed := strings.TrimSpace(job); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	if len(out) == 0 {
		return "unknown jobs"
	}
	return strings.Join(out, ", ")
}
