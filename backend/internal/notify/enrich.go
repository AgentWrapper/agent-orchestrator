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
	case domain.NotificationNeedsInput, domain.NotificationOrchestratorReplaced, domain.NotificationOrchestratorReplacementCapped:
		return false
	default:
		return true
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
		return "AO replaced an unresponsive project orchestrator."
	case domain.NotificationOrchestratorReplacementCapped:
		return "AO stopped replacing this project orchestrator after repeated failures. Inspect the harness, auth, and hook pipeline."
	default:
		return ""
	}
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
