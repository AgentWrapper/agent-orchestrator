package controllers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	Models(ctx context.Context, session domain.SessionID) ([]ports.ChatModel, domain.ConversationSettings, error)
	SetTurnSettings(ctx context.Context, session domain.SessionID, settings domain.ConversationSettings) (domain.ConversationSettings, error)
	Compact(ctx context.Context, session domain.SessionID) (ports.ChatCompactionResult, error)
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
	r.Post("/sessions/{sessionId}/conversation/compact", c.compact)
	r.Get("/sessions/{sessionId}/conversation/models", c.models)
	r.Patch("/sessions/{sessionId}/conversation/settings", c.setSettings)
}

// compact asks the provider to summarize earlier history and reclaim context.
//
// 202 rather than 200: the provider accepts the request and does the work as its
// own turn afterwards, so this reports acceptance and the reclaim lands on the
// timeline. Claiming 200 would say the compaction is done.
func (c *ConversationsController) compact(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/sessions/{sessionId}/conversation/compact")
		return
	}
	result, err := c.Svc.Compact(r.Context(), domain.SessionID(chi.URLParam(r, "sessionId")))
	if err != nil {
		writeConversationError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusAccepted, CompactConversationResponse{
		TokensBefore: result.TokensBefore,
		TokensAfter:  result.TokensAfter,
	})
}

// models serves the provider's catalog for this session plus the current choice.
func (c *ConversationsController) models(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/sessions/{sessionId}/conversation/models")
		return
	}
	session := domain.SessionID(chi.URLParam(r, "sessionId"))
	models, selected, err := c.Svc.Models(r.Context(), session)
	if err != nil {
		if errors.Is(err, chatsvc.ErrModelsUnsupported) {
			// Not a failure: this agent simply offers no choice. An empty list with
			// the current selection lets the client hide the picker rather than
			// show an error the user cannot act on.
			envelope.WriteJSON(w, http.StatusOK, ConversationModelsResponse{
				Models:   []ConversationModelResponse{},
				Selected: turnSettingsPayload(selected),
			})
			return
		}
		writeConversationError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, conversationModelsResponse(models, selected))
}

// setSettings records the provider choices for the next turn.
func (c *ConversationsController) setSettings(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "PATCH", "/api/v1/sessions/{sessionId}/conversation/settings")
		return
	}
	var req ConversationTurnSettingsPayload
	if !decodeConversationBody(w, r, &req) {
		return
	}
	// An unknown approval mode is refused rather than normalized: silently
	// downgrading a permission choice is the one direction that must never happen
	// by accident.
	approval := domain.PermissionMode(req.ApprovalMode)
	if req.ApprovalMode != "" && !approval.Valid() {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "validation",
			"CHAT_APPROVAL_MODE_INVALID",
			fmt.Sprintf("unknown approval mode %q", req.ApprovalMode), nil)
		return
	}

	settings, err := c.Svc.SetTurnSettings(r.Context(),
		domain.SessionID(chi.URLParam(r, "sessionId")), domain.ConversationSettings{
			Model:           req.Model,
			ReasoningEffort: req.ReasoningEffort,
			ApprovalMode:    approval,
		})
	if err != nil {
		writeConversationError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, turnSettingsPayload(settings))
}

func conversationModelsResponse(
	models []ports.ChatModel,
	selected domain.ConversationSettings,
) ConversationModelsResponse {
	out := ConversationModelsResponse{
		Models:   make([]ConversationModelResponse, 0, len(models)),
		Selected: turnSettingsPayload(selected),
	}
	for _, model := range models {
		out.Models = append(out.Models, ConversationModelResponse{
			ID:            model.ID,
			DisplayName:   model.DisplayName,
			Description:   model.Description,
			Default:       model.Default,
			Efforts:       model.Efforts,
			DefaultEffort: model.DefaultEffort,
		})
	}
	return out
}

func turnSettingsPayload(settings domain.ConversationSettings) ConversationTurnSettingsPayload {
	return ConversationTurnSettingsPayload{
		Model:           settings.Model,
		ReasoningEffort: settings.ReasoningEffort,
		ApprovalMode:    string(settings.ApprovalMode),
	}
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

	case errors.Is(err, chatsvc.ErrCompactionUnsupported):
		// Permanent for this harness, and a 409 rather than a 500 because nothing
		// failed: the provider simply has no way to reclaim context. A client should
		// stop offering the control instead of retrying.
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict",
			"CHAT_COMPACTION_UNSUPPORTED",
			"this agent cannot compact its conversation history", nil)

	case errors.Is(err, chatsvc.ErrCompactionWhileBusy):
		// Retryable once the turn ends, and refused rather than forwarded: the
		// provider would silently interrupt the running turn to make room.
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict",
			"CHAT_COMPACTION_BUSY",
			"finish or stop the current turn before compacting", nil)

	case errors.Is(err, chatsvc.ErrNoActiveTurn):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict",
			"CHAT_NO_ACTIVE_TURN", "there is no turn in flight to interrupt", nil)

	case errors.Is(err, ports.ErrChatRequestNotPending):
		// Two clients can watch the same approval, so arriving second is ordinary.
		// The card is stale; the client should refresh rather than retry.
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict",
			"CHAT_REQUEST_NOT_PENDING",
			"this request has already been answered or is no longer waiting", nil)

	case errors.Is(err, ports.ErrChatDecisionNotOffered):
		// A client asking for an option the provider never offered is a bug in the
		// client, not a server failure — and the request is still pending, so the
		// user can still answer it.
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "validation",
			"CHAT_DECISION_NOT_OFFERED", err.Error(), nil)

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
		Settings:       turnSettingsPayload(s.Conversation.Settings),
		Usage:          usagePayload(s.Usage),
		RateLimits:     rateLimitsPayload(s.RateLimits),
		CompactedAt:    optionalTimestamp(s.Conversation.CompactedAt),
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
			Diff:           turnDiffPayload(turn.Diff),
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
			Detail:       activityDetailPayload(activity),
			RequestID:    activity.RequestID,
			CreatedAt:    activity.CreatedAt.UTC().Format(time.RFC3339),
		})
	}
	return out
}

// usagePayload maps the conversation's token position onto the wire shape. A nil
// snapshot value stays nil: the field being absent is how a client learns the
// provider has not reported yet, which is not the same as a conversation that has
// used nothing.
func usagePayload(usage *domain.ConversationUsage) *ConversationUsagePayload {
	if usage == nil {
		return nil
	}
	return &ConversationUsagePayload{
		ContextUsed:   usage.ContextUsed,
		ContextWindow: usage.ContextWindow,
		InputTokens:   usage.InputTokens,
		OutputTokens:  usage.OutputTokens,
		CachedTokens:  usage.CachedTokens,
		TotalTokens:   usage.TotalTokens,
	}
}

// rateLimitsPayload maps the account's quota position onto the wire shape.
func rateLimitsPayload(limits *domain.ConversationRateLimits) *ConversationRateLimitsPayload {
	if limits == nil {
		return nil
	}
	return &ConversationRateLimitsPayload{
		PrimaryUsedPercent:       limits.PrimaryUsedPercent,
		SecondaryUsedPercent:     limits.SecondaryUsedPercent,
		PrimaryResetsInSeconds:   limits.PrimaryResetsInSeconds,
		SecondaryResetsInSeconds: limits.SecondaryResetsInSeconds,
		PlanLabel:                limits.PlanLabel,
	}
}

// turnDiffPayload maps a turn's changed-file summary onto the wire shape.
func turnDiffPayload(diff *domain.ConversationTurnDiff) *ConversationTurnDiffResponse {
	if diff == nil {
		return nil
	}
	out := &ConversationTurnDiffResponse{
		Truncated: diff.Truncated,
		Files:     make([]ConversationDiffFileResponse, 0, len(diff.Files)),
	}
	for _, file := range diff.Files {
		out.Files = append(out.Files, ConversationDiffFileResponse{
			Path:      file.Path,
			Additions: file.Additions,
			Deletions: file.Deletions,
			Status:    file.Status,
			OldPath:   file.OldPath,
		})
	}
	return out
}

// activityDetailPayload folds accumulated command output into the typed payload.
//
// The two output sources are not equivalent and the client is told which it has.
// The streamed accumulation exists while the command runs and survives a command
// that never completes; the provider's own aggregate only appears on completion.
// Neither is complete -- measured on codex-cli 0.146.0, a command printing
// tick-1..tick-8 lost tick-1 from the delta stream and from the aggregate alike --
// so outputMayBePartial stays set either way. `outputSource` exists so the UI can
// explain WHY it is partial instead of hedging identically about both.
func activityDetailPayload(activity domain.ConversationActivity) map[string]any {
	detail := decodeDetail(activity.Detail)
	if activity.CommandOutput == "" {
		return detail
	}
	if detail == nil {
		detail = map[string]any{}
	}
	// The stream wins over the aggregate: it is the only one that exists mid-command,
	// and once both exist they carry the same text.
	detail["output"] = activity.CommandOutput
	detail["outputSource"] = "stream"
	detail["outputMayBePartial"] = true
	if activity.CommandOutputTruncated {
		detail["outputTruncated"] = true
	}
	return detail
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
