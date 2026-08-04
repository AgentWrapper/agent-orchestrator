package notify

import (
	"fmt"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func enrich(intent Intent) (domain.NotificationRecord, error) {
	rec := domain.NotificationRecord{
		SessionID: intent.SessionID,
		ProjectID: intent.ProjectID,
		PRURL:     strings.TrimSpace(intent.PRURL),
		Type:      intent.Type,
		Status:    domain.NotificationUnread,
		CreatedAt: intent.CreatedAt,
	}
	if !intent.Type.Valid() {
		return domain.NotificationRecord{}, domain.ErrInvalidNotificationType
	}
	if intent.Type != domain.NotificationNeedsInput && rec.PRURL == "" {
		return domain.NotificationRecord{}, domain.ErrInvalidNotificationRecord
	}
	rec.Title = titleForIntent(intent)
	rec.Body = bodyForIntent(intent)
	if err := rec.Validate(); err != nil {
		return domain.NotificationRecord{}, err
	}
	return rec, nil
}

func titleForIntent(intent Intent) string {
	switch intent.Type {
	case domain.NotificationNeedsInput:
		return fmt.Sprintf("%s needs your input", sessionLabel(intent))
	case domain.NotificationReadyToMerge:
		if s := sessionLabel(intent); s != "session" {
			return fmt.Sprintf("%s is ready to merge", s)
		}
		return fmt.Sprintf("%s is ready to merge", prLabel(intent))
	case domain.NotificationPRMerged:
		return fmt.Sprintf("%s merged", prLabel(intent))
	case domain.NotificationPRClosedUnmerged:
		return fmt.Sprintf("%s closed", prLabel(intent))
	default:
		return "Notification"
	}
}

func bodyForIntent(intent Intent) string {
	switch intent.Type {
	case domain.NotificationNeedsInput:
		return "Your agent is waiting on you to continue."
	case domain.NotificationReadyToMerge:
		return "CI passed with no blocking review feedback."
	case domain.NotificationPRMerged:
		title := strings.TrimSpace(intent.PRTitle)
		if target := strings.TrimSpace(intent.PRTargetBranch); title != "" && target != "" {
			return fmt.Sprintf("%s is now on %s.", title, target)
		}
		if title != "" {
			return fmt.Sprintf("%s was merged.", title)
		}
		return "The pull request was merged."
	case domain.NotificationPRClosedUnmerged:
		if title := strings.TrimSpace(intent.PRTitle); title != "" {
			return fmt.Sprintf("%s was closed without merging. Reopen it if this wasn't intended.", title)
		}
		return "Closed without merging. Reopen it if this wasn't intended."
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
