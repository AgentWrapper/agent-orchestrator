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
		return fmt.Sprintf("%s is ready to merge", prLabel(intent))
	case domain.NotificationPRMerged:
		return fmt.Sprintf("%s was merged", prLabel(intent))
	case domain.NotificationPRClosedUnmerged:
		return fmt.Sprintf("%s was closed without merging", prLabel(intent))
	default:
		return "Notification"
	}
}

func bodyForIntent(intent Intent) string {
	switch intent.Type {
	case domain.NotificationNeedsInput:
		return "Your agent paused and needs a decision to continue. Open the session to respond."
	case domain.NotificationReadyToMerge:
		lead := "This PR"
		if s := sessionLabel(intent); s != "session" {
			lead = s
		}
		if target := strings.TrimSpace(intent.PRTargetBranch); target != "" {
			return fmt.Sprintf("%s passed CI with no blocking review feedback. Ready to merge into %s.", lead, target)
		}
		return fmt.Sprintf("%s passed CI with no blocking review feedback and is ready to merge.", lead)
	case domain.NotificationPRMerged:
		subject := "The pull request"
		if title := strings.TrimSpace(intent.PRTitle); title != "" {
			subject = title
		}
		if target := strings.TrimSpace(intent.PRTargetBranch); target != "" {
			return fmt.Sprintf("%s was merged into %s.", subject, target)
		}
		return fmt.Sprintf("%s was merged.", subject)
	case domain.NotificationPRClosedUnmerged:
		subject := "The pull request"
		if title := strings.TrimSpace(intent.PRTitle); title != "" {
			subject = title
		}
		return fmt.Sprintf("%s was closed without merging. Reopen it if that wasn't intended.", subject)
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
