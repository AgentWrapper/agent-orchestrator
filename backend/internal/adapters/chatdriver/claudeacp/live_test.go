package claudeacp

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/claudecode"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Run explicitly with AO_LIVE_CLAUDE_ACP=1. It spends one very small real turn
// against the user's existing Claude Code login and proves the complete boundary:
// packaged Node -> claude-agent-acp -> user-installed Claude -> normalized AO
// events. CI never depends on credentials or the network.
func TestLiveClaudeACP(t *testing.T) {
	if os.Getenv("AO_LIVE_CLAUDE_ACP") != "1" {
		t.Skip("set AO_LIVE_CLAUDE_ACP=1 to run against the local Claude Code account")
	}

	driver := New(claudecode.New(), nil)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if _, err := driver.Probe(ctx); err != nil {
		t.Fatalf("Probe: %v", err)
	}
	conversation, err := driver.Start(ctx, ports.ChatStartConfig{
		SessionID: domain.SessionID("live-claude-acp"), WorkspacePath: t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer conversation.Close()

	ref, err := conversation.SendTurn(ctx, ports.ChatUserMessage{
		Text: "Reply with exactly: AO ACP works", ClientMessageID: "live-1", Origin: domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("SendTurn: %v", err)
	}
	if err := conversation.(ports.ChatDeferredTurnStarter).StartDeferredTurn(ref.ProviderTurnID); err != nil {
		t.Fatalf("StartDeferredTurn: %v", err)
	}

	var answer strings.Builder
	for {
		select {
		case event, ok := <-conversation.Events():
			if !ok {
				t.Fatalf("controller closed before completion; answer=%q", answer.String())
			}
			if event.Kind == ports.ChatEventMessageDelta {
				answer.WriteString(event.Delta)
			}
			if event.Kind == ports.ChatEventTurnCompleted {
				if event.TurnState != domain.TurnStateCompleted {
					t.Fatalf("turn state = %q; answer=%q", event.TurnState, answer.String())
				}
				if !strings.Contains(answer.String(), "AO ACP works") {
					t.Fatalf("answer = %q", answer.String())
				}
				return
			}
		case <-ctx.Done():
			t.Fatalf("live turn timed out: %v; answer=%q", ctx.Err(), answer.String())
		}
	}
}
