package controllers_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
)

// fakeConversationService answers only what the skills route needs; every other
// method is present to satisfy the interface and is never reached by these tests.
type fakeConversationService struct {
	skills   []ports.ChatSkill
	skillErr error
}

func (f fakeConversationService) Snapshot(context.Context, domain.SessionID) (chatsvc.Snapshot, error) {
	return chatsvc.Snapshot{}, nil
}

func (f fakeConversationService) Send(
	context.Context, domain.SessionID, ports.ChatUserMessage,
) (domain.ConversationTurn, error) {
	return domain.ConversationTurn{}, nil
}

func (f fakeConversationService) Resolve(
	context.Context, domain.SessionID, string, ports.ChatDecision,
) error {
	return nil
}

func (f fakeConversationService) Interrupt(context.Context, domain.SessionID) error { return nil }

func (f fakeConversationService) Models(
	context.Context, domain.SessionID,
) ([]ports.ChatModel, domain.ConversationSettings, error) {
	return nil, domain.ConversationSettings{}, nil
}

func (f fakeConversationService) SetTurnSettings(
	context.Context, domain.SessionID, domain.ConversationSettings,
) (domain.ConversationSettings, error) {
	return domain.ConversationSettings{}, nil
}

func (f fakeConversationService) Skills(
	context.Context, domain.SessionID,
) ([]ports.ChatSkill, error) {
	return f.skills, f.skillErr
}

func skillsRequest(t *testing.T, svc controllers.ConversationService) (int, []byte) {
	t.Helper()
	r := chi.NewRouter()
	(&controllers.ConversationsController{Svc: svc}).Register(r)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/sessions/p1-1/conversation/skills", nil))
	return rec.Code, rec.Body.Bytes()
}

func decodeSkills(t *testing.T, body []byte) controllers.ConversationSkillsResponse {
	t.Helper()
	var out controllers.ConversationSkillsResponse
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	return out
}

func TestSkillsRouteReturnsTheProvidersList(t *testing.T) {
	status, body := skillsRequest(t, fakeConversationService{
		skills: []ports.ChatSkill{
			{Name: "review", DisplayName: "Review", Description: "Look at the diff", Source: "repo"},
		},
	})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", status, body)
	}
	got := decodeSkills(t, body)
	if len(got.Skills) != 1 {
		t.Fatalf("skills = %+v, want 1", got.Skills)
	}
	if got.Skills[0] != (controllers.ConversationSkillResponse{
		Name: "review", DisplayName: "Review", Description: "Look at the diff", Source: "repo",
	}) {
		t.Errorf("skill = %+v", got.Skills[0])
	}
}

// A driver that cannot enumerate skills is not a failure. The composer keys `/` off
// an empty list, so an error here would leave the slash looking broken rather than
// simply unavailable.
func TestSkillsRouteAnswersEmptyWhenTheDriverCannotList(t *testing.T) {
	status, body := skillsRequest(t, fakeConversationService{skillErr: chatsvc.ErrSkillsUnsupported})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", status, body)
	}
	got := decodeSkills(t, body)
	if got.Skills == nil {
		t.Fatal("skills is null; an absent catalog must encode as [] so a client can iterate it")
	}
	if len(got.Skills) != 0 {
		t.Errorf("skills = %+v, want empty", got.Skills)
	}
}

// A session with no controller is a state to explain, not an empty menu to show.
func TestSkillsRouteReportsAMissingController(t *testing.T) {
	status, body := skillsRequest(t, fakeConversationService{skillErr: chatsvc.ErrNoController})
	if status != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (%s)", status, body)
	}
	var envelope struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(body, &envelope)
	if envelope.Code != "" && envelope.Code != "CHAT_CONTROLLER_NOT_READY" {
		t.Errorf("code = %q", envelope.Code)
	}
}

// A nil service keeps the route registered and answers from the spec, so the
// OpenAPI contract and the router never disagree about which paths exist.
func TestSkillsRouteIsNotImplementedWithoutAService(t *testing.T) {
	status, _ := skillsRequest(t, nil)
	if status != http.StatusNotImplemented {
		t.Errorf("status = %d, want 501", status)
	}
}
