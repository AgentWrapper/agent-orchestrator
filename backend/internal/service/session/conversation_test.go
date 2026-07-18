package session

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestConversationReadsClaudeMessagesWithoutTerminalData(t *testing.T) {
	home := t.TempDir()
	nativeID := "11111111-2222-3333-4444-555555555555"
	dir := filepath.Join(home, ".claude", "projects", "workspace")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	log := `{"type":"user","uuid":"u1","timestamp":"2026-07-16T10:00:00Z","message":{"role":"user","content":"Check the build"}}` + "\n" +
		`{"type":"assistant","uuid":"a1","timestamp":"2026-07-16T10:00:01Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"private reasoning"},{"type":"tool_use","name":"PowerShell","input":{}},{"type":"text","text":"The build is green."}]}}` + "\n" +
		`{"type":"user","uuid":"tool","message":{"role":"user","content":[{"type":"tool_result","content":"raw terminal bytes"}]}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, nativeID+".jsonl"), []byte(log), 0o600); err != nil {
		t.Fatal(err)
	}
	store := newFakeStore()
	store.sessions["ao-1"] = domain.SessionRecord{ID: "ao-1", Harness: domain.HarnessClaudeCode, Metadata: domain.SessionMetadata{AgentSessionID: nativeID}}

	snapshot, err := NewWithDeps(Deps{Store: store, HomeDir: home}).Conversation(context.Background(), "ao-1")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Source != conversationSourceClaude || len(snapshot.Entries) != 3 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	if snapshot.Entries[0].Role != "user" || snapshot.Entries[0].Text != "Check the build" {
		t.Fatalf("user entry = %+v", snapshot.Entries[0])
	}
	if snapshot.Entries[1].Kind != "update" || snapshot.Entries[1].Text != "Running a command." {
		t.Fatalf("update entry = %+v", snapshot.Entries[1])
	}
	if snapshot.Entries[2].Role != "assistant" || snapshot.Entries[2].Text != "The build is green." {
		t.Fatalf("assistant entry = %+v", snapshot.Entries[2])
	}
}

func TestConversationReadsCodexPublicEvents(t *testing.T) {
	dataDir := t.TempDir()
	nativeID := "019f6b84-04f2-7cb3-9cfa-c9f2ea8f609b"
	dir := filepath.Join(dataDir, "codex-home", "sessions", "2026", "07", "16")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	log := `{"timestamp":"2026-07-16T10:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"Fix output","turn_id":"t1"}}` + "\n" +
		`{"timestamp":"2026-07-16T10:00:01Z","type":"event_msg","payload":{"type":"agent_message","message":"I am checking the clean log.","phase":"commentary","turn_id":"t1"}}` + "\n" +
		`{"timestamp":"2026-07-16T10:00:02Z","type":"response_item","payload":{"type":"function_call","name":"apply_patch","call_id":"c1"}}` + "\n" +
		`{"timestamp":"2026-07-16T10:00:03Z","type":"event_msg","payload":{"type":"agent_message","message":"Output is clean now.","phase":"final_answer","turn_id":"t1"}}` + "\n"
	name := "rollout-2026-07-16T10-00-00-" + nativeID + ".jsonl"
	if err := os.WriteFile(filepath.Join(dir, name), []byte(log), 0o600); err != nil {
		t.Fatal(err)
	}
	store := newFakeStore()
	store.sessions["ao-2"] = domain.SessionRecord{ID: "ao-2", Harness: domain.HarnessCodex, Metadata: domain.SessionMetadata{AgentSessionID: nativeID}, UpdatedAt: time.Now()}

	snapshot, err := NewWithDeps(Deps{Store: store, DataDir: dataDir}).Conversation(context.Background(), "ao-2")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Source != conversationSourceCodex || len(snapshot.Entries) != 4 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	if snapshot.Entries[1].Kind != "update" || snapshot.Entries[2].Text != "Updating project files." {
		t.Fatalf("updates = %+v", snapshot.Entries[1:3])
	}
	if snapshot.Entries[3].Kind != "message" || snapshot.Entries[3].Text != "Output is clean now." {
		t.Fatalf("final entry = %+v", snapshot.Entries[3])
	}
}

func TestConversationReturnsUnavailableWithoutStructuredLog(t *testing.T) {
	store := newFakeStore()
	store.sessions["ao-3"] = domain.SessionRecord{ID: "ao-3", Harness: domain.HarnessClaudeCode}
	snapshot, err := NewWithDeps(Deps{Store: store, HomeDir: t.TempDir()}).Conversation(context.Background(), "ao-3")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Source != conversationSourceUnavailable || len(snapshot.Entries) != 0 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
}

func TestConversationFindsLegacyClaudeLogFromWorkspace(t *testing.T) {
	home := t.TempDir()
	workspace := `C:\Users\Test User\.ao\data\worktrees\project\orchestrator`
	projectDir := filepath.Join(home, ".claude", "projects", claudeProjectDirectoryName(workspace))
	if err := os.MkdirAll(projectDir, 0o700); err != nil {
		t.Fatal(err)
	}
	log := `{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"Recovered cleanly."}]}}` + "\n"
	if err := os.WriteFile(filepath.Join(projectDir, "legacy-session.jsonl"), []byte(log), 0o600); err != nil {
		t.Fatal(err)
	}
	store := newFakeStore()
	store.sessions["ao-legacy"] = domain.SessionRecord{
		ID: "ao-legacy", Harness: domain.HarnessClaudeCode,
		Metadata: domain.SessionMetadata{WorkspacePath: workspace},
	}

	snapshot, err := NewWithDeps(Deps{Store: store, HomeDir: home}).Conversation(context.Background(), "ao-legacy")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Source != conversationSourceClaude || len(snapshot.Entries) != 1 || snapshot.Entries[0].Text != "Recovered cleanly." {
		t.Fatalf("snapshot = %+v", snapshot)
	}
}

func TestConversationFindsLegacyCodexLogFromWorkspace(t *testing.T) {
	dataDir := t.TempDir()
	workspace := filepath.Join(t.TempDir(), "worktree")
	dir := filepath.Join(dataDir, "codex-home", "sessions", "2026", "07", "16")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	meta, err := json.Marshal(map[string]any{
		"timestamp": "2026-07-16T10:00:00Z",
		"type":      "session_meta",
		"payload":   map[string]string{"cwd": workspace},
	})
	if err != nil {
		t.Fatal(err)
	}
	log := string(meta) + "\n" +
		`{"timestamp":"2026-07-16T10:00:01Z","type":"event_msg","payload":{"type":"agent_message","message":"Recovered durable response.","phase":"final_answer","turn_id":"t1"}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "rollout-legacy.jsonl"), []byte(log), 0o600); err != nil {
		t.Fatal(err)
	}

	store := newFakeStore()
	store.sessions["ao-legacy-codex"] = domain.SessionRecord{
		ID: "ao-legacy-codex", Harness: domain.HarnessCodex,
		Metadata: domain.SessionMetadata{WorkspacePath: workspace},
	}
	snapshot, err := NewWithDeps(Deps{Store: store, DataDir: dataDir}).Conversation(context.Background(), "ao-legacy-codex")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Source != conversationSourceCodex || len(snapshot.Entries) != 1 || snapshot.Entries[0].Text != "Recovered durable response." {
		t.Fatalf("snapshot = %+v", snapshot)
	}
}

func TestConversationFindsCurrentCodexLogInProviderHome(t *testing.T) {
	home := t.TempDir()
	workspace := filepath.Join(t.TempDir(), "worktree")
	dir := filepath.Join(home, ".codex", "sessions", "2026", "07", "18")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	meta, err := json.Marshal(map[string]any{
		"timestamp": "2026-07-18T22:19:38Z",
		"type":      "session_meta",
		"payload":   map[string]string{"cwd": workspace},
	})
	if err != nil {
		t.Fatal(err)
	}
	log := string(meta) + "\n" +
		`{"timestamp":"2026-07-18T22:19:44Z","type":"event_msg","payload":{"type":"agent_message","message":"AO_REVIEW_BOARD_done_END","phase":"final_answer","turn_id":"t1"}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "rollout-current.jsonl"), []byte(log), 0o600); err != nil {
		t.Fatal(err)
	}

	store := newFakeStore()
	store.sessions["ao-current-codex"] = domain.SessionRecord{
		ID: "ao-current-codex", Harness: domain.HarnessCodex,
		Metadata: domain.SessionMetadata{WorkspacePath: workspace},
	}
	snapshot, err := NewWithDeps(Deps{Store: store, DataDir: t.TempDir(), HomeDir: home}).Conversation(context.Background(), "ao-current-codex")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Source != conversationSourceCodex || len(snapshot.Entries) != 1 || snapshot.Entries[0].Text != "AO_REVIEW_BOARD_done_END" {
		t.Fatalf("snapshot = %+v", snapshot)
	}
}
