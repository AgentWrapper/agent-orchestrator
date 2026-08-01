package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
)

const workerInspectionPageSize = 500

type workerInspectionResponse struct {
	Session         clouddomain.Session       `json:"session"`
	Turn            *clouddomain.Turn         `json:"turn,omitempty"`
	SCM             *cloudpostgres.SessionSCM `json:"scm,omitempty"`
	Result          string                    `json:"result"`
	ResultAvailable bool                      `json:"resultAvailable"`
}

func (s *Server) workerInspectSession(w http.ResponseWriter, r *http.Request) {
	claims, parent, ok := s.workerOrchestrator(w, r)
	if !ok {
		return
	}
	targetID := clouddomain.SessionID(chi.URLParam(r, "sessionId"))
	target, err := s.store.GetSession(r.Context(), claims.AccountID, targetID)
	if errors.Is(err, cloudpostgres.ErrSessionNotFound) ||
		err == nil && (target.ProjectID != parent.ProjectID || target.Kind != "worker") {
		writeError(w, r, http.StatusNotFound, "SESSION_NOT_FOUND", "The project worker does not exist.")
		return
	}
	if err != nil {
		s.internalError(w, r, "authorize worker inspection", err)
		return
	}
	turn, err := s.store.GetLatestTurn(r.Context(), claims.AccountID, targetID)
	if err != nil {
		s.internalError(w, r, "load latest worker turn", err)
		return
	}
	result := ""
	if turn != nil {
		events, replayErr := s.replayTurnEvents(r, claims.AccountID, targetID, turn)
		if replayErr != nil {
			s.internalError(w, r, "replay worker result", replayErr)
			return
		}
		result = assistantResult(events, turn.ID)
	}
	scm, err := s.store.SessionSCM(r.Context(), claims.AccountID, targetID)
	if err != nil {
		s.internalError(w, r, "load worker SCM inspection", err)
		return
	}
	writeJSON(w, http.StatusOK, workerInspectionResponse{
		Session:         target,
		Turn:            turn,
		SCM:             scm,
		Result:          result,
		ResultAvailable: turn != nil && (turn.State == "completed" || turn.State == "failed"),
	})
}

func (s *Server) replayTurnEvents(
	r *http.Request,
	accountID clouddomain.AccountID,
	sessionID clouddomain.SessionID,
	turn *clouddomain.Turn,
) ([]clouddomain.Event, error) {
	after := turn.UserMessageSequence - 1
	events := make([]clouddomain.Event, 0, workerInspectionPageSize)
	for {
		page, err := s.events.ReplayResults(
			r.Context(),
			accountID,
			sessionID,
			after,
			workerInspectionPageSize,
		)
		if err != nil {
			return nil, err
		}
		events = append(events, page...)
		if len(page) < workerInspectionPageSize {
			return events, nil
		}
		after = page[len(page)-1].Sequence
	}
}

func assistantResult(events []clouddomain.Event, turnID string) string {
	segments := make([]string, 0)
	var current strings.Builder
	streaming := false
	flush := func() {
		if text := strings.TrimSpace(current.String()); text != "" {
			segments = append(segments, text)
		}
		current.Reset()
		streaming = false
	}

	for _, event := range events {
		var payload map[string]any
		if json.Unmarshal(event.Payload, &payload) != nil {
			continue
		}
		if eventTurnID, _ := payload["turnId"].(string); eventTurnID != "" && eventTurnID != turnID {
			continue
		}
		text, _ := payload["text"].(string)
		switch event.Type {
		case "chat.assistant_delta":
			if !streaming {
				flush()
				streaming = true
			}
			current.WriteString(text)
		case "chat.assistant_message":
			if strings.TrimSpace(current.String()) == "" {
				current.WriteString(text)
			}
			streaming = false
		case "agent.activity":
			if strings.TrimSpace(current.String()) == "" && len(segments) == 0 {
				current.WriteString(activityFinalAnswer(payload))
			}
			flush()
		case "chat.tool_started",
			"chat.approval_requested",
			"chat.user_input_requested",
			"chat.warning",
			"chat.error",
			"chat.turn_aborted",
			"chat.turn_interrupted",
			"chat.turn_completed":
			flush()
		}
	}
	flush()
	return strings.Join(segments, "\n\n")
}

func activityFinalAnswer(payload map[string]any) string {
	event, _ := payload["event"].(string)
	if event != "stop" && event != "after-agent" {
		return ""
	}
	native, _ := payload["native"].(map[string]any)
	for _, key := range []string{"last_assistant_message", "lastAssistantMessage"} {
		if answer, _ := native[key].(string); strings.TrimSpace(answer) != "" {
			return answer
		}
	}
	return ""
}
