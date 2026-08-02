package controllers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
)

// maxConversationBody bounds a chat message. Large context belongs in files the
// agent reads from the worktree, not in a request body.
const maxConversationBody = 1 << 20

// ConversationService is the controller-facing Chat contract.
type ConversationService interface {
	Snapshot(ctx context.Context, session domain.SessionID) (chatsvc.Snapshot, error)
	Send(ctx context.Context, session domain.SessionID, msg ports.ChatUserMessage) (domain.ConversationTurn, error)
	Resolve(ctx context.Context, session domain.SessionID, requestID string, decision ports.ChatDecision) error
	Interrupt(ctx context.Context, session domain.SessionID) error
}

// ConversationsController owns the Chat routes for a session.
//
// Every route dispatches from the session's persisted mode inside the service, so
// a client cannot reach the Chat path for a session that was created in TUI mode
// even by calling these URLs directly. UI visibility is not the boundary.
type ConversationsController struct {
	Svc ConversationService
}

// Register mounts the conversation routes under a session.
func (c *ConversationsController) Register(r chi.Router) {
	r.Get("/sessions/{sessionId}/conversation", c.snapshot)
	r.Post("/sessions/{sessionId}/conversation/messages", c.send)
	r.Post("/sessions/{sessionId}/conversation/approvals/{requestId}/resolve", c.resolve)
	r.Post("/sessions/{sessionId}/conversation/interrupt", c.interrupt)
}

func (c *ConversationsController) snapshot(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/sessions/{sessionId}/conversation")
		return
	}
	session := domain.SessionID(chi.URLParam(r, "sessionId"))
	snapshot, err := c.Svc.Snapshot(r.Context(), session)
	if err != nil {
		writeConversationError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, conversationSnapshotResponse(snapshot))
}

func (c *ConversationsController) send(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/sessions/{sessionId}/conversation/messages")
		return
	}
	var req SendConversationMessageRequest
	if !decodeConversationBody(w, r, &req) {
		return
	}
	if req.Text == "" {
		// There is no keystroke concept in Chat mode: an empty body is a client
		// bug, not a way to nudge the agent.
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "validation",
			"CHAT_MESSAGE_EMPTY", "message text is required", nil)
		return
	}

	turn, err := c.Svc.Send(r.Context(), domain.SessionID(chi.URLParam(r, "sessionId")), ports.ChatUserMessage{
		Text:            req.Text,
		ClientMessageID: req.ClientMessageID,
		Origin:          domain.MessageOriginHuman,
	})
	if err != nil {
		writeConversationError(w, r, err)
		return
	}

	// An empty turn means the client message id was already delivered. Reporting
	// the duplicate explicitly lets a retrying client stop rather than assume a
	// new turn began.
	envelope.WriteJSON(w, http.StatusAccepted, SendConversationMessageResponse{
		TurnID:         turn.ID,
		ProviderTurnID: turn.ProviderTurnID,
		State:          turn.State,
		Duplicate:      turn.ID == "",
	})
}

func (c *ConversationsController) resolve(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST",
			"/api/v1/sessions/{sessionId}/conversation/approvals/{requestId}/resolve")
		return
	}
	var req ResolveConversationApprovalRequest
	if !decodeConversationBody(w, r, &req) {
		return
	}
	if req.DecisionID == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "validation",
			"CHAT_DECISION_REQUIRED", "decisionId is required", nil)
		return
	}

	err := c.Svc.Resolve(r.Context(), domain.SessionID(chi.URLParam(r, "sessionId")),
		chi.URLParam(r, "requestId"), ports.ChatDecision{ID: req.DecisionID})
	if err != nil {
		writeConversationError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (c *ConversationsController) interrupt(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/sessions/{sessionId}/conversation/interrupt")
		return
	}
	err := c.Svc.Interrupt(r.Context(), domain.SessionID(chi.URLParam(r, "sessionId")))
	if err != nil {
		writeConversationError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func decodeConversationBody(w http.ResponseWriter, r *http.Request, into any) bool {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxConversationBody))
	if err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "validation",
			"INVALID_BODY", "could not read request body", nil)
		return false
	}
	if err := json.Unmarshal(body, into); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "validation",
			"INVALID_BODY", "request body is not valid JSON", nil)
		return false
	}
	return true
}

// writeConversationError maps the Chat service's typed failures onto stable
// codes, so a client can tell a permanent answer from a retryable one.
func writeConversationError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ports.ErrSessionNotFound):
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found",
			"SESSION_NOT_FOUND", "session not found", nil)

	case errors.Is(err, chatsvc.ErrNotChatMode):
		// Permanent: the mode is immutable, so retrying will never succeed.
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict",
			"SESSION_MODE_MISMATCH",
			"this session was created in Terminal UI mode and has no chat conversation", nil)

	case errors.Is(err, chatsvc.ErrNoController):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict",
			"CHAT_CONTROLLER_NOT_READY",
			"the agent controller for this session is not running", nil)

	case errors.Is(err, chatsvc.ErrNoActiveTurn):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict",
			"CHAT_NO_ACTIVE_TURN", "there is no turn in flight to interrupt", nil)

	case errors.Is(err, ports.ErrChatUnsupported):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict",
			"SESSION_MODE_UNSUPPORTED", err.Error(), nil)

	case errors.Is(err, ports.ErrChatAuthRequired):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict",
			"CHAT_AUTH_REQUIRED", "the agent is installed but not authenticated", nil)

	case errors.Is(err, ports.ErrChatResumeFailed):
		// Deliberately not a silent recovery: the client must offer the user a
		// choice rather than have AO invent a fresh conversation.
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict",
			"CHAT_RESUME_FAILED",
			"the stored provider conversation could not be resumed", nil)

	default:
		envelope.WriteError(w, r, err)
	}
}

// conversationSnapshotResponse maps the service snapshot onto the wire shape.
// Items arrive already ordered by sequence, so nothing is re-sorted here.
func conversationSnapshotResponse(s chatsvc.Snapshot) ConversationSnapshotResponse {
	out := ConversationSnapshotResponse{
		ConversationID: s.Conversation.ID,
		SessionID:      string(s.SessionID),
		Harness:        string(s.Harness),
		Mode:           string(s.Mode),
		Controller:     string(s.Controller),
		LatestSequence: s.Conversation.LatestSequence,
		Turns:          make([]ConversationTurnResponse, 0, len(s.Turns)),
		Messages:       make([]ConversationMessageResponse, 0, len(s.Messages)),
		Activities:     make([]ConversationActivityResponse, 0, len(s.Activities)),
	}

	for _, turn := range s.Turns {
		out.Turns = append(out.Turns, ConversationTurnResponse{
			ID:             turn.ID,
			State:          string(turn.State),
			ProviderTurnID: turn.ProviderTurnID,
			ErrorMessage:   turn.ErrorMessage,
			RequestedAt:    turn.RequestedAt.UTC().Format(time.RFC3339),
			StartedAt:      optionalTimestamp(turn.StartedAt),
			CompletedAt:    optionalTimestamp(turn.CompletedAt),
		})
	}

	for _, msg := range s.Messages {
		out.Messages = append(out.Messages, ConversationMessageResponse{
			Kind:      "message",
			ID:        msg.ID,
			TurnID:    msg.TurnID,
			Sequence:  msg.Sequence,
			Revision:  msg.Revision,
			Role:      string(msg.Role),
			Origin:    string(msg.Origin),
			Text:      msg.Text,
			Streaming: msg.Streaming,
			CreatedAt: msg.CreatedAt.UTC().Format(time.RFC3339),
		})
	}

	for _, activity := range s.Activities {
		out.Activities = append(out.Activities, ConversationActivityResponse{
			Kind:         "activity",
			ID:           activity.ID,
			TurnID:       activity.TurnID,
			Sequence:     activity.Sequence,
			Revision:     activity.Revision,
			ActivityKind: string(activity.Kind),
			Status:       string(activity.Status),
			Summary:      activity.Summary,
			Detail:       decodeDetail(activity.Detail),
			RequestID:    activity.RequestID,
			CreatedAt:    activity.CreatedAt.UTC().Format(time.RFC3339),
		})
	}
	return out
}

// decodeDetail turns the stored payload into a JSON object. A payload this build
// cannot parse is dropped rather than emitted as a string the client would have
// to guess at.
func decodeDetail(raw []byte) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	var detail map[string]any
	if err := json.Unmarshal(raw, &detail); err != nil {
		return nil
	}
	return detail
}

func optionalTimestamp(t *time.Time) *string {
	if t == nil {
		return nil
	}
	formatted := t.UTC().Format(time.RFC3339)
	return &formatted
}
