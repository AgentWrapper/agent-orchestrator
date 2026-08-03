package registry

import (
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// What the daemon ships, stated once.
//
// Registration is the whole capability gate — a harness with no driver here cannot
// run chat mode — so the shipped set is a release decision, not an implementation
// detail. This release is Codex only: chat mode ships one harness at a time so the
// first one has a single conversation surface to be judged on.
//
// A Claude Code driver exists on `feat/chat-session-mode-claude` and lands next.
// This test is what stops it arriving early by accident, and updating it is the
// deliberate act of deciding it is ready.
func TestShippedDriversAreCodexOnly(t *testing.T) {
	r := Build(nil)

	if !r.SupportsChat(domain.HarnessCodex) {
		t.Error("codex has no chat driver; chat mode ships nothing")
	}
	if _, err := r.Driver(domain.HarnessCodex); err != nil {
		t.Errorf("resolving the codex driver: %v", err)
	}

	// Held back deliberately. When Claude Code lands, change this test rather than
	// deleting it — the assertion is the record of what shipped when.
	if r.SupportsChat(domain.HarnessClaudeCode) {
		t.Error("claude-code has a chat driver on a release meant to be codex-only")
	}

	// Every other harness stays TUI-only, and asking for chat must be refused with a
	// typed answer rather than quietly producing a terminal session.
	for _, harness := range []domain.AgentHarness{
		domain.HarnessClaudeCode, domain.HarnessAider, "definitely-not-an-agent",
	} {
		if _, err := r.Driver(harness); err == nil {
			t.Errorf("%s resolved a chat driver", harness)
		} else if !errors.Is(err, ports.ErrChatUnsupported) {
			t.Errorf("%s refused with %v, want ErrChatUnsupported so callers can branch", harness, err)
		}
	}
}
