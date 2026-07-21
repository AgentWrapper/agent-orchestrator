package session

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAnalyzeSemanticTraceFlagsRepeatedVerificationWithHighBurn(t *testing.T) {
	trace := semanticTrace{
		actions: []semanticAction{
			{fingerprint: "test", kind: semanticActionVerification},
			{fingerprint: "read-a"},
			{fingerprint: "test", kind: semanticActionVerification},
			{fingerprint: "read-b"},
			{fingerprint: "test", kind: semanticActionVerification},
			{fingerprint: "read-c"},
			{fingerprint: "test", kind: semanticActionVerification},
			{fingerprint: "read-d"},
		},
		observedTokens: highSemanticTokens,
	}

	got, ok := analyzeSemanticTrace(trace)
	if !ok {
		t.Fatal("expected a semantic-liveness warning")
	}
	if got.State != "thrashing" || got.SuggestedAction != "fresh_context_restart" {
		t.Fatalf("warning = %+v", got)
	}
	if got.ObservedActions != len(trace.actions) || got.ObservedTokens != highSemanticTokens {
		t.Fatalf("evidence counts = %+v", got)
	}
	if strings.Contains(got.Summary, "test") || strings.Contains(got.Summary, "read-a") {
		t.Fatalf("summary leaked action detail: %q", got.Summary)
	}
	second, secondOK := analyzeSemanticTrace(trace)
	if secondOK != ok || second != got {
		t.Fatalf("counterfactual replay changed: first=%+v second=%+v", got, second)
	}
}

func TestAnalyzeSemanticTraceTreatsEditsAsProgress(t *testing.T) {
	trace := semanticTrace{actions: []semanticAction{
		{fingerprint: "test", kind: semanticActionVerification},
		{fingerprint: "edit-a", kind: semanticActionMutation},
		{fingerprint: "test", kind: semanticActionVerification},
		{fingerprint: "edit-b", kind: semanticActionMutation},
		{fingerprint: "test", kind: semanticActionVerification},
		{fingerprint: "edit-c", kind: semanticActionMutation},
		{fingerprint: "test", kind: semanticActionVerification},
		{fingerprint: "read"},
	}}
	if got, ok := analyzeSemanticTrace(trace); ok {
		t.Fatalf("ordinary edit/verify iteration was flagged: %+v", got)
	}
}

func TestAnalyzeSemanticTraceFlagsAlternatingMutationLoop(t *testing.T) {
	trace := semanticTrace{actions: []semanticAction{
		{fingerprint: "file-a", kind: semanticActionMutation},
		{fingerprint: "file-b", kind: semanticActionMutation},
		{fingerprint: "file-a", kind: semanticActionMutation},
		{fingerprint: "file-b", kind: semanticActionMutation},
		{fingerprint: "file-a", kind: semanticActionMutation},
		{fingerprint: "file-b", kind: semanticActionMutation},
		{fingerprint: "read-a"},
		{fingerprint: "read-b"},
	}}
	got, ok := analyzeSemanticTrace(trace)
	if !ok || got.State != "thrashing" || !strings.Contains(got.Summary, "alternating") {
		t.Fatalf("warning = %+v, ok=%v", got, ok)
	}
}

func TestNewSemanticActionNormalizesCodexAndClaudeInputs(t *testing.T) {
	codexRaw, err := json.Marshal(`{"cmd":"go test ./..."}`)
	if err != nil {
		t.Fatal(err)
	}
	verification, ok := newSemanticAction("exec", codexRaw)
	if !ok || verification.kind != semanticActionVerification {
		t.Fatalf("codex action = %+v, ok=%v", verification, ok)
	}

	mutation, ok := newSemanticAction("apply_patch", json.RawMessage(`{"patch":"*** Begin Patch\n*** Update File: src/app.go\n*** End Patch"}`))
	if !ok || mutation.kind != semanticActionMutation {
		t.Fatalf("claude action = %+v, ok=%v", mutation, ok)
	}
	second, _ := newSemanticAction("apply_patch", json.RawMessage(`{"patch":"*** Begin Patch\n*** Update File: src/app.go\n+different content\n*** End Patch"}`))
	if second.fingerprint != mutation.fingerprint {
		t.Fatal("edits to the same target should share a loop identity")
	}
}
