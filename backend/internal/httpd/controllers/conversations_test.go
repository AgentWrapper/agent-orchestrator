package controllers_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
)

// The wire shape for streamed command output and turn diffs.
//
// Asserted through the real route rather than against the mapping helpers, so the
// JSON a client actually parses is what is checked.

type fakeConversationService struct{ snapshot chatsvc.Snapshot }

func (f *fakeConversationService) Snapshot(context.Context, domain.SessionID) (chatsvc.Snapshot, error) {
	return f.snapshot, nil
}

func (f *fakeConversationService) Send(context.Context, domain.SessionID, ports.ChatUserMessage) (domain.ConversationTurn, error) {
	return domain.ConversationTurn{}, nil
}

func (f *fakeConversationService) Resolve(context.Context, domain.SessionID, string, ports.ChatDecision) error {
	return nil
}

func (f *fakeConversationService) Interrupt(context.Context, domain.SessionID) error { return nil }

func (f *fakeConversationService) Models(context.Context, domain.SessionID) ([]ports.ChatModel, domain.ConversationSettings, error) {
	return nil, domain.ConversationSettings{}, nil
}

func (f *fakeConversationService) SetTurnSettings(context.Context, domain.SessionID, domain.ConversationSettings) (domain.ConversationSettings, error) {
	return domain.ConversationSettings{}, nil
}

func (f *fakeConversationService) Compact(context.Context, domain.SessionID) (ports.ChatCompactionResult, error) {
	return ports.ChatCompactionResult{}, nil
}

// conversationSnapshotBody fetches the snapshot route and decodes it loosely, the
// way a client sees it.
func conversationSnapshotBody(t *testing.T, snapshot chatsvc.Snapshot) map[string]any {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Sessions:      newFakeSessionService(),
		Conversations: &fakeConversationService{snapshot: snapshot},
	}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/api/v1/sessions/p1-1/conversation")
	if err != nil {
		t.Fatalf("GET conversation: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, body = %s", resp.StatusCode, body)
	}

	var decoded map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return decoded
}

func TestSnapshotExposesTurnDiff(t *testing.T) {
	body := conversationSnapshotBody(t, chatsvc.Snapshot{
		SessionID: domain.SessionID("p1-1"),
		Mode:      domain.SessionModeChat,
		Turns: []domain.ConversationTurn{{
			ID:          "turn-1",
			State:       domain.TurnStateCompleted,
			RequestedAt: time.Now().UTC(),
			Diff: &domain.ConversationTurnDiff{
				Files: []domain.ConversationDiffFile{
					{Path: "new.txt", OldPath: "old.txt", Additions: 3, Deletions: 1, Status: "renamed"},
				},
			},
		}},
	})

	turns, ok := body["turns"].([]any)
	if !ok || len(turns) != 1 {
		t.Fatalf("turns = %#v", body["turns"])
	}
	diff, ok := turns[0].(map[string]any)["diff"].(map[string]any)
	if !ok {
		t.Fatalf("turn has no diff: %#v", turns[0])
	}
	files, ok := diff["files"].([]any)
	if !ok || len(files) != 1 {
		t.Fatalf("diff files = %#v", diff["files"])
	}

	file := files[0].(map[string]any)
	if file["path"] != "new.txt" || file["status"] != "renamed" {
		t.Errorf("file = %#v", file)
	}
	// A rename shown only as its new path reads as an addition, so both ends ship.
	if file["oldPath"] != "old.txt" {
		t.Errorf("oldPath = %#v", file["oldPath"])
	}
	if file["additions"] != float64(3) || file["deletions"] != float64(1) {
		t.Errorf("counts = %#v / %#v", file["additions"], file["deletions"])
	}
	// No patch text: this body is polled once a second while a turn runs.
	if _, present := file["patch"]; present {
		t.Error("diff file carried patch text onto the polled snapshot")
	}
}

// A turn the provider never reported a diff for must not claim an empty diff.
// "Changed nothing" and "this agent does not report diffs" are different answers.
func TestSnapshotOmitsAbsentTurnDiff(t *testing.T) {
	body := conversationSnapshotBody(t, chatsvc.Snapshot{
		SessionID: domain.SessionID("p1-1"),
		Mode:      domain.SessionModeChat,
		Turns: []domain.ConversationTurn{{
			ID: "turn-1", State: domain.TurnStateCompleted, RequestedAt: time.Now().UTC(),
		}},
	})

	turn := body["turns"].([]any)[0].(map[string]any)
	if _, present := turn["diff"]; present {
		t.Errorf("turn with no reported diff still shipped one: %#v", turn["diff"])
	}
}

// The accumulated stream replaces the provider's aggregate and says which source
// the client is looking at. Both are partial for different reasons, so the hedge
// stays either way.
func TestSnapshotPrefersStreamedOutputOverAggregate(t *testing.T) {
	aggregate, err := json.Marshal(map[string]any{
		"command":            "go test ./...",
		"output":             "ok  pkg/b\n",
		"outputMayBePartial": true,
		"outputSource":       "aggregate",
		"exitCode":           0,
	})
	if err != nil {
		t.Fatalf("encode detail: %v", err)
	}

	body := conversationSnapshotBody(t, chatsvc.Snapshot{
		SessionID: domain.SessionID("p1-1"),
		Mode:      domain.SessionModeChat,
		Activities: []domain.ConversationActivity{{
			ID:                     "act-1",
			Kind:                   domain.ActivityKindCommand,
			Status:                 domain.ActivityStatusCompleted,
			Summary:                "go test ./...",
			Detail:                 aggregate,
			CommandOutput:          "ok  pkg/a\nok  pkg/b\n",
			CommandOutputTruncated: true,
			CreatedAt:              time.Now().UTC(),
		}},
	})

	activities, ok := body["activities"].([]any)
	if !ok || len(activities) != 1 {
		t.Fatalf("activities = %#v", body["activities"])
	}
	detail, ok := activities[0].(map[string]any)["detail"].(map[string]any)
	if !ok {
		t.Fatalf("activity has no detail: %#v", activities[0])
	}

	if detail["output"] != "ok  pkg/a\nok  pkg/b\n" {
		t.Errorf("output = %#v, want the accumulated stream", detail["output"])
	}
	if detail["outputSource"] != "stream" {
		t.Errorf("outputSource = %#v, want stream", detail["outputSource"])
	}
	if detail["outputTruncated"] != true {
		t.Errorf("outputTruncated = %#v", detail["outputTruncated"])
	}
	// Still partial: the provider was measured dropping the first chunk from the
	// delta stream too, so the stream is not a complete record either.
	if detail["outputMayBePartial"] != true {
		t.Errorf("outputMayBePartial = %#v, want true", detail["outputMayBePartial"])
	}
	// Fields the aggregate carried are untouched.
	if detail["command"] != "go test ./..." {
		t.Errorf("command = %#v", detail["command"])
	}
}

// With no streamed output at all the aggregate stands, labelled as such.
func TestSnapshotKeepsAggregateWhenNoStreamArrived(t *testing.T) {
	aggregate, err := json.Marshal(map[string]any{
		"output":             "done\n",
		"outputMayBePartial": true,
		"outputSource":       "aggregate",
	})
	if err != nil {
		t.Fatalf("encode detail: %v", err)
	}

	body := conversationSnapshotBody(t, chatsvc.Snapshot{
		SessionID: domain.SessionID("p1-1"),
		Mode:      domain.SessionModeChat,
		Activities: []domain.ConversationActivity{{
			ID: "act-1", Kind: domain.ActivityKindCommand,
			Status: domain.ActivityStatusCompleted, Summary: "echo done",
			Detail: aggregate, CreatedAt: time.Now().UTC(),
		}},
	})

	detail := body["activities"].([]any)[0].(map[string]any)["detail"].(map[string]any)
	if detail["output"] != "done\n" {
		t.Errorf("output = %#v", detail["output"])
	}
	if detail["outputSource"] != "aggregate" {
		t.Errorf("outputSource = %#v, want aggregate", detail["outputSource"])
	}
	if _, present := detail["outputTruncated"]; present {
		t.Error("untruncated output still carried the truncation flag")
	}
}
