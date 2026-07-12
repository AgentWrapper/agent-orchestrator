package controllers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	notificationsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/notification"
)

// NotificationService is the controller-facing notification service contract.
type NotificationService interface {
	ListUnread(ctx context.Context, filter notificationsvc.ListFilter) ([]notificationsvc.Notification, error)
	MarkRead(ctx context.Context, id string) (notificationsvc.Notification, bool, error)
	MarkAllRead(ctx context.Context) ([]notificationsvc.Notification, error)
}

// NotificationStream is the live notification stream used by SSE clients.
type NotificationStream interface {
	Subscribe(projectID domain.ProjectID) (<-chan domain.NotificationRecord, func())
}

// NotificationsController owns the /notifications routes.
type NotificationsController struct {
	Svc    NotificationService
	Stream NotificationStream
}

// Register mounts bounded notification REST routes on the supplied router.
func (c *NotificationsController) Register(r chi.Router) {
	r.Get("/notifications", c.list)
	r.Post("/notifications/read-all", c.markAllRead)
	r.Patch("/notifications/{id}", c.markRead)
}

// RegisterStream mounts long-lived notification stream routes on the supplied router.
func (c *NotificationsController) RegisterStream(r chi.Router) {
	r.Get("/notifications/stream", c.stream)
}

func (c *NotificationsController) list(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/notifications")
		return
	}
	filter, err := parseNotificationListFilter(r)
	if err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_QUERY", err.Error(), nil)
		return
	}
	notifications, err := c.Svc.ListUnread(r.Context(), filter)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, ListNotificationsResponse{Notifications: notificationResponses(notifications)})
}

func (c *NotificationsController) markRead(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "PATCH", "/api/v1/notifications/{id}")
		return
	}
	var req MarkNotificationReadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if req.Status != string(domain.NotificationRead) {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_NOTIFICATION_STATUS", "Notification status must be read", nil)
		return
	}
	notification, _, err := c.Svc.MarkRead(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, NotificationEnvelope{Notification: notificationResponse(notification)})
}

func (c *NotificationsController) markAllRead(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/notifications/read-all")
		return
	}
	notifications, err := c.Svc.MarkAllRead(r.Context())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, MarkAllNotificationsReadResponse{Notifications: notificationResponses(notifications)})
}

func (c *NotificationsController) stream(w http.ResponseWriter, r *http.Request) {
	if c.Stream == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/notifications/stream")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "SSE_UNSUPPORTED", "Streaming is not supported by this server", nil)
		return
	}
	ch, unsubscribe := c.Stream.Subscribe(domain.ProjectID(r.URL.Query().Get("projectId")))
	defer unsubscribe()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	for {
		select {
		case <-r.Context().Done():
			return
		case rec, ok := <-ch:
			if !ok {
				return
			}
			if err := writeNotificationSSE(w, flusher, rec); err != nil {
				return
			}
		}
	}
}

func writeNotificationSSE(w http.ResponseWriter, flusher http.Flusher, rec domain.NotificationRecord) error {
	data, err := json.Marshal(notificationResponseFromRecord(rec))
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "event: notification_created\ndata: %s\n\n", data); err != nil {
		return err
	}
	flusher.Flush()
	return nil
}

func parseNotificationListFilter(r *http.Request) (notificationsvc.ListFilter, error) {
	q := r.URL.Query()
	status := q.Get("status")
	if status == "" {
		status = "unread"
	}
	if status != "unread" {
		return notificationsvc.ListFilter{}, errNotificationStatusUnsupported
	}
	limit := notificationsvc.DefaultListLimit
	if raw := q.Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			return notificationsvc.ListFilter{}, errNotificationLimitInvalid
		}
		limit = parsed
	}
	if limit > notificationsvc.MaxListLimit {
		limit = notificationsvc.MaxListLimit
	}
	return notificationsvc.ListFilter{Limit: limit}, nil
}

var (
	errNotificationStatusUnsupported = notificationQueryError("status must be unread")
	errNotificationLimitInvalid      = notificationQueryError("limit must be a positive integer")
)

type notificationQueryError string

func (e notificationQueryError) Error() string { return string(e) }

func notificationResponses(in []notificationsvc.Notification) []NotificationResponse {
	out := make([]NotificationResponse, 0, len(in))
	for _, n := range in {
		out = append(out, notificationResponse(n))
	}
	return out
}

func notificationResponse(n notificationsvc.Notification) NotificationResponse {
	rec := n.NotificationRecord.WithInferredSubject()
	subject := n.Subject
	if subject.Kind == "" || subject.ID == "" {
		subject = notificationsvc.Subject{Kind: rec.SubjectKind, ID: rec.SubjectID}
	}
	return NotificationResponse{
		ID:        rec.ID,
		SessionID: string(rec.SessionID),
		ProjectID: string(rec.ProjectID),
		PRURL:     rec.PRURL,
		Type:      string(rec.Type),
		Subject: NotificationSubject{
			Kind: string(subject.Kind),
			ID:   subject.ID,
		},
		Title:        rec.Title,
		Body:         rec.Body,
		Sensitive:    rec.Sensitive,
		ChangedPaths: append([]string(nil), rec.ChangedPaths...),
		HeadSHA:      rec.HeadSHA,
		Status:       string(rec.Status),
		CreatedAt:    rec.CreatedAt,
		Target: NotificationTarget{
			Kind:      string(n.Target.Kind),
			SessionID: string(n.Target.SessionID),
			PRURL:     n.Target.PRURL,
		},
	}
}

func notificationResponseFromRecord(rec domain.NotificationRecord) NotificationResponse {
	rec = rec.WithInferredSubject()
	return NotificationResponse{
		ID:        rec.ID,
		SessionID: string(rec.SessionID),
		ProjectID: string(rec.ProjectID),
		PRURL:     rec.PRURL,
		Type:      string(rec.Type),
		Subject: NotificationSubject{
			Kind: string(rec.SubjectKind),
			ID:   rec.SubjectID,
		},
		Title:        rec.Title,
		Body:         rec.Body,
		Sensitive:    rec.Sensitive,
		ChangedPaths: append([]string(nil), rec.ChangedPaths...),
		HeadSHA:      rec.HeadSHA,
		Status:       string(rec.Status),
		CreatedAt:    rec.CreatedAt,
		Target:       notificationTargetFromRecord(rec),
	}
}

func notificationTargetFromRecord(rec domain.NotificationRecord) NotificationTarget {
	rec = rec.WithInferredSubject()
	if rec.PRURL != "" {
		return NotificationTarget{Kind: "pr", SessionID: string(rec.SessionID), PRURL: rec.PRURL}
	}
	if rec.SubjectKind == domain.NotificationSubjectSession {
		return NotificationTarget{Kind: "session", SessionID: string(rec.SessionID)}
	}
	return NotificationTarget{Kind: "none"}
}
