package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/activitydispatch"
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
