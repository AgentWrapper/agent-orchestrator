package controllers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	reviewcore "github.com/aoagents/agent-orchestrator/backend/internal/review"
	notificationsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/notification"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
)

// AttentionSessionService is the read surface needed to derive the operator queue.
type AttentionSessionService interface {
	List(ctx context.Context, filter sessionsvc.ListFilter) ([]domain.Session, error)
	Decision(ctx context.Context, id domain.SessionID) (domain.PendingDecision, bool, error)
	ListPRSummaries(ctx context.Context, id domain.SessionID) ([]sessionsvc.PRSummary, error)
}

// AttentionController owns canonical attention routes.
type AttentionController struct {
	Svc           AttentionSessionService
	Notifications NotificationService
}

// Register mounts attention routes on the supplied router.
func (c *AttentionController) Register(r chi.Router) {
	r.Get("/attention/operator", c.listOperator)
}

func (c *AttentionController) listOperator(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/attention/operator")
		return
	}
	items, err := deriveOperatorAttention(r.Context(), c.Svc, c.Notifications)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, ListOperatorAttentionResponse{Items: items})
}

func deriveOperatorAttention(ctx context.Context, svc AttentionSessionService, notifications NotificationService) ([]OperatorAttentionItem, error) {
	sessions, err := svc.List(ctx, sessionsvc.ListFilter{})
	if err != nil {
		return nil, err
	}
	items := make([]OperatorAttentionItem, 0)
	seen := map[string]attentionItemIndex{}
	for _, sess := range sessions {
		if !sess.IsTerminated && sess.Status == domain.StatusNeedsInput {
			decision, ok, err := svc.Decision(ctx, sess.ID)
			if err != nil {
				if isAttentionNotFound(err) {
					continue
				}
				return nil, fmt.Errorf("decision %s: %w", sess.ID, err)
			}
			if ok {
				items = appendAttentionItem(items, seen, decisionAttentionItem(sess, decision), true)
			}
		}
		if !sess.IsTerminated && sess.Status == domain.StatusNoSignal {
			if item, ok := noSignalAttentionItem(sess); ok {
				items = appendAttentionItem(items, seen, item, true)
			}
		}
		if !sessionHasOpenPR(sess) {
			continue
		}
		prs, err := svc.ListPRSummaries(ctx, sess.ID)
		if err != nil {
			if isAttentionNotFound(err) {
				continue
			}
			return nil, fmt.Errorf("pr summaries %s: %w", sess.ID, err)
		}
		for _, pr := range prs {
			if item, ok := prAttentionItem(sess, pr); ok {
				items = appendAttentionItem(items, seen, item, !sess.IsTerminated)
			}
		}
	}
	if notifications != nil {
		unread, err := notifications.ListUnread(ctx, notificationsvc.ListFilter{Limit: notificationsvc.MaxListLimit})
		if err != nil {
			// Notifications add durable operator escalations, but the core waiting
			// surface must still render live session decisions and mergeable PRs if
			// notification storage is temporarily unavailable.
			slog.WarnContext(ctx, "attention: notification read failed; returning session-derived operator attention only", "err", err)
		} else {
			for _, notification := range unread {
				if item, ok := notificationAttentionItem(notification); ok {
					items = appendAttentionItem(items, seen, item, false)
				}
			}
		}
	}
	sort.SliceStable(items, func(i, j int) bool {
		if !items[i].UpdatedAt.Equal(items[j].UpdatedAt) {
			return items[i].UpdatedAt.After(items[j].UpdatedAt)
		}
		return items[i].ID < items[j].ID
	})
	return items, nil
}

func notificationAttentionItem(notification notificationsvc.Notification) (OperatorAttentionItem, bool) {
	if notification.Type != domain.NotificationWorkerRetryExhausted {
		return OperatorAttentionItem{}, false
	}
	return OperatorAttentionItem{
		ID:           notificationAttentionID(notification),
		Kind:         string(notification.Type),
		ProjectID:    notification.ProjectID,
		SessionID:    notification.SessionID,
		SessionTitle: firstNonEmptyString(notification.Title, notification.Body, string(notification.SessionID)),
		Reason:       firstNonEmptyString(notification.Body, notification.Title, "Worker retry cap exhausted for this issue."),
		Action:       "Diagnose the repeated failure, then resume or reassign the issue before respawning.",
		DeepLink:     notificationAttentionDeepLink(notification),
		UpdatedAt:    notification.CreatedAt,
		PRURL:        notification.PRURL,
	}, true
}

func notificationAttentionID(notification notificationsvc.Notification) string {
	if notification.ID != "" {
		return "notification:" + notification.ID + ":operator"
	}
	return fmt.Sprintf("notification:%s:%s:%s", notification.ProjectID, notification.SessionID, notification.Type)
}

func notificationAttentionDeepLink(notification notificationsvc.Notification) string {
	if notification.PRURL != "" {
		return notification.PRURL
	}
	if notification.ProjectID != "" && notification.SessionID != "" {
		return "/projects/" + string(notification.ProjectID) + "/sessions/" + string(notification.SessionID)
	}
	return "/waiting"
}

func isAttentionNotFound(err error) bool {
	var apiErr *apierr.Error
	return errors.As(err, &apiErr) && apiErr.Kind == apierr.KindNotFound
}

func sessionHasOpenPR(sess domain.Session) bool {
	for _, pr := range sess.PRs {
		if !pr.Merged && !pr.Closed {
			return true
		}
	}
	return false
}

type attentionItemIndex struct {
	index int
	live  bool
}

func appendAttentionItem(items []OperatorAttentionItem, seen map[string]attentionItemIndex, item OperatorAttentionItem, live bool) []OperatorAttentionItem {
	if existing, ok := seen[item.ID]; ok {
		if attentionItemSupersedes(item, live, items[existing.index], existing.live) {
			items[existing.index] = item
			seen[item.ID] = attentionItemIndex{index: existing.index, live: live}
		}
		return items
	}
	seen[item.ID] = attentionItemIndex{index: len(items), live: live}
	return append(items, item)
}

func attentionItemSupersedes(next OperatorAttentionItem, nextLive bool, current OperatorAttentionItem, currentLive bool) bool {
	if nextLive != currentLive {
		return nextLive
	}
	return next.UpdatedAt.After(current.UpdatedAt)
}

func noSignalAttentionItem(sess domain.Session) (OperatorAttentionItem, bool) {
	var kind, reason, action string
	switch sess.Kind {
	case domain.KindPrime:
		kind = "prime_dead"
		reason = "Prime orchestrator has no live process signal."
		action = "Inspect the prime supervisor and restart or replace it if needed."
	case domain.KindOrchestrator:
		kind = "orchestrator_dead"
		reason = "Project orchestrator has no live process signal."
		action = "Inspect the project orchestrator and restart or replace it if needed."
	default:
		return OperatorAttentionItem{}, false
	}
	return OperatorAttentionItem{
		ID:           "session:" + string(sess.ID) + ":no_signal",
		Kind:         kind,
		ProjectID:    sess.ProjectID,
		SessionID:    sess.ID,
		SessionTitle: sessionAttentionTitle(sess),
		Reason:       reason,
		Action:       action,
		DeepLink:     sessionDeepLink(sess),
		UpdatedAt:    sess.UpdatedAt,
	}, true
}

func decisionAttentionItem(sess domain.Session, decision domain.PendingDecision) OperatorAttentionItem {
	reason := "Session is waiting on an operator decision."
	action := "Answer the session question."
	if decision.Kind == domain.DecisionKindPermission {
		reason = "Session is paused on a permission dialog."
		action = "Approve or deny the permission in the session terminal."
	}
	return OperatorAttentionItem{
		ID:           "session:" + string(sess.ID) + ":decision",
		Kind:         "decision",
		ProjectID:    sess.ProjectID,
		SessionID:    sess.ID,
		SessionTitle: sessionAttentionTitle(sess),
		Reason:       reason,
		Action:       action,
		DeepLink:     sessionDeepLink(sess),
		UpdatedAt:    sess.UpdatedAt,
		DecisionKind: decision.Kind,
		Question:     decision.Question,
	}
}

// prAttentionItem includes PRs whose local facts are mergeable and ao-reviewed.
// Operators still verify the SHA-pinned final-review gate before merging.
func prAttentionItem(sess domain.Session, pr sessionsvc.PRSummary) (OperatorAttentionItem, bool) {
	if pr.State != domain.PRStateOpen || pr.CI.State != domain.CIPassing || pr.Mergeability.State != domain.MergeMergeable {
		return OperatorAttentionItem{}, false
	}
	if pr.Review.Decision == domain.ReviewChangesRequest || pr.Review.Decision == domain.ReviewRequired || pr.Review.HasUnresolvedHumanComments {
		return OperatorAttentionItem{}, false
	}
	if pr.FinalReview.Status != reviewcore.ReviewStateUpToDate {
		return OperatorAttentionItem{}, false
	}
	return OperatorAttentionItem{
		ID:           prAttentionID(sess, pr),
		Kind:         "pr",
		ProjectID:    sess.ProjectID,
		SessionID:    sess.ID,
		SessionTitle: sessionAttentionTitle(sess),
		Reason:       "PR is locally mergeable and waiting for operator merge authority.",
		Action:       "Review final-review status and merge the pull request when the gate is clean.",
		DeepLink:     prDeepLink(sess, pr),
		UpdatedAt:    pr.UpdatedAt,
		PRNumber:     pr.Number,
		PRURL:        firstNonEmptyString(pr.HTMLURL, pr.URL),
		PRTitle:      pr.Title,
	}, true
}

func prAttentionID(sess domain.Session, pr sessionsvc.PRSummary) string {
	if id := firstNonEmptyString(pr.HTMLURL, pr.URL); id != "" {
		return "pr:" + id + ":merge"
	}
	return fmt.Sprintf("pr:%s:%d:merge", sess.ProjectID, pr.Number)
}

func sessionAttentionTitle(sess domain.Session) string {
	if title := strings.TrimSpace(sess.DisplayName); title != "" {
		return title
	}
	if title := strings.TrimSpace(string(sess.IssueID)); title != "" {
		return title
	}
	return string(sess.ID)
}

func sessionDeepLink(sess domain.Session) string {
	return "/projects/" + string(sess.ProjectID) + "/sessions/" + string(sess.ID)
}

func prDeepLink(sess domain.Session, pr sessionsvc.PRSummary) string {
	if pr.HTMLURL != "" {
		return pr.HTMLURL
	}
	if pr.URL != "" {
		return pr.URL
	}
	return sessionDeepLink(sess)
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
