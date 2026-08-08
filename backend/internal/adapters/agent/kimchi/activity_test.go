package kimchi

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestDeriveActivityState(t *testing.T) {
	tests := []struct {
		name    string
		event   string
		payload string
		want    domain.ActivityState
		wantOK  bool
	}{
		{"user prompt -> active", "user-prompt-submit", `{}`, domain.ActivityActive, true},
		{"stop -> idle", "stop", `{}`, domain.ActivityIdle, true},
		{"notification idle_prompt -> idle", "notification", `{"notification_type":"idle_prompt"}`, domain.ActivityIdle, true},
		{"notification permission_prompt -> blocked", "notification", `{"notification_type":"permission_prompt"}`, domain.ActivityBlocked, true},
		{"notification agent_needs_input -> waiting_input", "notification", `{"notification_type":"agent_needs_input"}`, domain.ActivityWaitingInput, true},
		{"notification agent_completed -> idle", "notification", `{"notification_type":"agent_completed"}`, domain.ActivityIdle, true},
		{"notification auth_success -> no signal", "notification", `{"notification_type":"auth_success"}`, "", false},
		{"notification empty type -> no signal", "notification", `{}`, "", false},
		{"notification malformed payload -> no signal", "notification", `not json`, "", false},
		{"session-end logout -> exited", "session-end", `{"reason":"logout"}`, domain.ActivityExited, true},
		{"session-end prompt_input_exit -> exited", "session-end", `{"reason":"prompt_input_exit"}`, domain.ActivityExited, true},
		{"session-end other -> exited", "session-end", `{"reason":"other"}`, domain.ActivityExited, true},
		{"session-end absent reason -> exited", "session-end", `{}`, domain.ActivityExited, true},
		{"session-end quit -> exited", "session-end", `{"reason":"quit"}`, domain.ActivityExited, true},
		{"session-end reload -> no signal", "session-end", `{"reason":"reload"}`, "", false},
		{"session-end new -> no signal", "session-end", `{"reason":"new"}`, "", false},
		{"session-end resume -> no signal", "session-end", `{"reason":"resume"}`, "", false},
		{"session-end fork -> no signal", "session-end", `{"reason":"fork"}`, "", false},
		{"pre-tool-use -> active", "pre-tool-use", `{}`, domain.ActivityActive, true},
		{"post-tool-use -> active", "post-tool-use", `{}`, domain.ActivityActive, true},
		{"post-tool-use-fail -> active", "post-tool-use-fail", `{}`, domain.ActivityActive, true},
		{"session-start -> no signal", "session-start", `{}`, "", false},
		{"unknown event -> no signal", "frobnicate", `{}`, "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := DeriveActivityState(tt.event, []byte(tt.payload))
			if got != tt.want || ok != tt.wantOK {
				t.Fatalf("DeriveActivityState(%q, %q) = (%q, %v), want (%q, %v)",
					tt.event, tt.payload, got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

// kimchiLifecycleStore is a minimal in-memory session store for driving the
// real lifecycle.Manager. It mirrors the fake adapter's lifecycleStore.
type kimchiLifecycleStore struct {
	sessions map[domain.SessionID]domain.SessionRecord
}

func (s *kimchiLifecycleStore) GetSession(_ context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	r, ok := s.sessions[id]
	return r, ok, nil
}

func (s *kimchiLifecycleStore) UpdateSession(_ context.Context, rec domain.SessionRecord) error {
	s.sessions[rec.ID] = rec
	return nil
}

func (s *kimchiLifecycleStore) ListPRsBySession(_ context.Context, _ domain.SessionID) ([]domain.PullRequest, error) {
	return nil, nil
}

func (s *kimchiLifecycleStore) GetPRLastNudgeSignature(_ context.Context, _ string) (string, error) {
	return "", nil
}

func (s *kimchiLifecycleStore) UpdatePRLastNudgeSignature(_ context.Context, _, _ string) error {
	return nil
}

func (s *kimchiLifecycleStore) ListSessions(_ context.Context, _ domain.ProjectID) ([]domain.SessionRecord, error) {
	return nil, nil
}

// TestBlockedPermissionDialogClearedOnPostToolUse is the integration test for
// ports.BlockedActivitySignaler on the Kimchi adapter. It drives the real
// lifecycle.Manager through Kimchi's exact hook sequence:
//
//  1. pre-tool-use (tool_name="Bash", tool_use_id="toolu_1")
//  2. notification(permission_prompt) (tool_name="bash", tool_use_id="toolu_1")
//     — Kimchi's notification carries the lowercase internal tool name,
//     but the same tool_use_id as the pre-tool-use. The lifecycle correlator
//     matches on tool_use_id against the inflight map, bridging the casing
//     gap.
//  3. post-tool-use (tool_name="Bash", tool_use_id="toolu_1")
//
// After step 2 the session must be blocked; after step 3 it must clear to
// active — the approved tool's post is the earliest observable signal that
// the permission dialog was answered.
func TestBlockedPermissionDialogClearedOnPostToolUse(t *testing.T) {
	store := &kimchiLifecycleStore{sessions: map[domain.SessionID]domain.SessionRecord{
		"kimchi-1": {
			ID:            "kimchi-1",
			ProjectID:     "proj-1",
			Harness:       domain.AgentHarness("kimchi"),
			Activity:      domain.Activity{State: domain.ActivityActive, LastActivityAt: time.Now()},
			FirstSignalAt: time.Now(),
		},
	}}
	mgr := lifecycle.New(store, nil)
	ctx := context.Background()

	// 1. PreToolUse: tool enters flight.
	preState, ok := DeriveActivityState("pre-tool-use", []byte(`{"tool_name":"Bash","tool_use_id":"toolu_1"}`))
	if !ok || preState != domain.ActivityActive {
		t.Fatalf("pre-tool-use: DeriveActivityState = (%q, %v), want (active, true)", preState, ok)
	}
	if err := mgr.ApplyActivitySignal(ctx, "kimchi-1", ports.ActivitySignal{
		Valid: true, State: preState, Event: "pre-tool-use",
		ToolName: "Bash", ToolUseID: "toolu_1",
	}); err != nil {
		t.Fatalf("ApplyActivitySignal(pre-tool-use): %v", err)
	}

	// 2. Notification(permission_prompt): Kimchi carries tool_use_id in the
	//    notification payload, matching the inflight entry from step 1.
	blockedState, ok := DeriveActivityState("notification", []byte(`{"notification_type":"permission_prompt","tool_name":"bash","tool_use_id":"toolu_1"}`))
	if !ok || blockedState != domain.ActivityBlocked {
		t.Fatalf("notification(permission_prompt): DeriveActivityState = (%q, %v), want (blocked, true)", blockedState, ok)
	}
	if err := mgr.ApplyActivitySignal(ctx, "kimchi-1", ports.ActivitySignal{
		Valid: true, State: blockedState, Event: "notification",
		ToolName: "bash", ToolUseID: "toolu_1",
	}); err != nil {
		t.Fatalf("ApplyActivitySignal(notification): %v", err)
	}
	if got := store.sessions["kimchi-1"].Activity.State; got != domain.ActivityBlocked {
		t.Fatalf("after notification: state = %q, want blocked", got)
	}

	// 3. PostToolUse: the approved tool finishes — blocked must clear to active.
	postState, ok := DeriveActivityState("post-tool-use", []byte(`{"tool_name":"Bash","tool_use_id":"toolu_1"}`))
	if !ok || postState != domain.ActivityActive {
		t.Fatalf("post-tool-use: DeriveActivityState = (%q, %v), want (active, true)", postState, ok)
	}
	if err := mgr.ApplyActivitySignal(ctx, "kimchi-1", ports.ActivitySignal{
		Valid: true, State: postState, Event: "post-tool-use",
		ToolName: "Bash", ToolUseID: "toolu_1",
	}); err != nil {
		t.Fatalf("ApplyActivitySignal(post-tool-use): %v", err)
	}
	if got := store.sessions["kimchi-1"].Activity.State; got != domain.ActivityActive {
		t.Fatalf("after post-tool-use: state = %q, want active (blocked cleared)", got)
	}
}

// TestBlockedNotClearedBySiblingToolPost verifies that a different tool's
// PostToolUse does not clear the blocked state — only the approved tool's
// post clears it. This is the subagent-traffic safety property.
func TestBlockedNotClearedBySiblingToolPost(t *testing.T) {
	store := &kimchiLifecycleStore{sessions: map[domain.SessionID]domain.SessionRecord{
		"kimchi-2": {
			ID:            "kimchi-2",
			ProjectID:     "proj-1",
			Harness:       domain.AgentHarness("kimchi"),
			Activity:      domain.Activity{State: domain.ActivityActive, LastActivityAt: time.Now()},
			FirstSignalAt: time.Now(),
		},
	}}
	mgr := lifecycle.New(store, nil)
	ctx := context.Background()

	// Blocked tool: pre-tool-use + notification(permission_prompt).
	mustApplyKimchi(t, mgr, ctx, "kimchi-2", "pre-tool-use", `{"tool_name":"Bash","tool_use_id":"toolu_1"}`)
	mustApplyKimchi(t, mgr, ctx, "kimchi-2", "notification", `{"notification_type":"permission_prompt","tool_name":"bash","tool_use_id":"toolu_1"}`)
	if got := store.sessions["kimchi-2"].Activity.State; got != domain.ActivityBlocked {
		t.Fatalf("after notification: state = %q, want blocked", got)
	}

	// A sibling tool's post must NOT clear blocked.
	mustApplyKimchi(t, mgr, ctx, "kimchi-2", "post-tool-use", `{"tool_name":"Read","tool_use_id":"toolu_sibling"}`)
	if got := store.sessions["kimchi-2"].Activity.State; got != domain.ActivityBlocked {
		t.Fatalf("after sibling post: state = %q, want blocked (sibling must not clear)", got)
	}

	// The approved tool's post still clears afterwards.
	mustApplyKimchi(t, mgr, ctx, "kimchi-2", "post-tool-use", `{"tool_name":"Bash","tool_use_id":"toolu_1"}`)
	if got := store.sessions["kimchi-2"].Activity.State; got != domain.ActivityActive {
		t.Fatalf("after approved post: state = %q, want active", got)
	}
}

func mustApplyKimchi(t *testing.T, mgr *lifecycle.Manager, ctx context.Context, id domain.SessionID, event, payload string) {
	t.Helper()
	state, ok := DeriveActivityState(event, []byte(payload))
	if !ok {
		t.Fatalf("DeriveActivityState(%q) returned no signal", event)
	}
	var p struct {
		ToolName  string `json:"tool_name"`
		ToolUseID string `json:"tool_use_id"`
	}
	_ = json.Unmarshal([]byte(payload), &p)
	if err := mgr.ApplyActivitySignal(ctx, id, ports.ActivitySignal{
		Valid: true, State: state, Event: event,
		ToolName: p.ToolName, ToolUseID: p.ToolUseID,
	}); err != nil {
		t.Fatalf("ApplyActivitySignal(%q): %v", event, err)
	}
}
