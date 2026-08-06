package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/activitydispatch"
	cloudcommandguard "github.com/aoagents/agent-orchestrator/backend/internal/cloud/commandguard"
)

// ForwardHook converts an agent hook payload into a cloud activity event.
func ForwardHook(
	ctx context.Context,
	client *Client,
	harness, event string,
	payload io.Reader,
) error {
	raw, err := io.ReadAll(io.LimitReader(payload, 1<<20))
	if err != nil {
		return fmt.Errorf("read agent hook payload: %w", err)
	}
	if cloudcommandguard.Enabled(os.Getenv("AO_DATA_DIR")) {
		if guardedInput := cloudcommandguard.HookInput(harness, event, raw); guardedInput != "" {
			if rule, blocked := cloudcommandguard.Match(guardedInput); blocked {
				_ = client.Event(ctx, "agent.command_guard_blocked", map[string]string{
					"harness": harness,
					"event":   event,
					"rule":    rule,
					"message": "Command guard blocked a destructive command.",
				})
				return fmt.Errorf("%w: %s", cloudcommandguard.ErrBlocked, rule)
			}
		}
	}
	state, hasActivity := activitydispatch.Derive(harness, event, raw)
	var nativePayload any
	if len(raw) > 0 && json.Valid(raw) {
		nativePayload = json.RawMessage(raw)
	}
	return client.Event(ctx, "agent.activity", map[string]any{
		"harness":     harness,
		"event":       event,
		"state":       state,
		"hasActivity": hasActivity,
		"native":      nativePayload,
	})
}
