// Package agentbase supplies the defaults an agent adapter would otherwise
// hand-copy. Most adapters implement several ports.Agent methods identically:
// no config keys, prompt delivered in the launch command, and (for the simpler
// harnesses) no hooks, no resume, no session metadata. Embedding Base gives an
// adapter those defaults so it only writes the methods it actually customizes.
package agentbase

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Base provides no-op defaults for the optional ports.Agent methods. Embed it in
// a Plugin struct (`agentbase.Base`) and override only what the harness needs.
// Every method honors ctx cancellation and otherwise does nothing, matching what
// the adapters previously wrote by hand.
type Base struct{}

// GetConfigSpec reports no agent-specific config keys.
func (Base) GetConfigSpec(ctx context.Context) (ports.ConfigSpec, error) {
	return ports.ConfigSpec{}, ctx.Err()
}

// GetPromptDeliveryStrategy reports that the agent receives its prompt in the
// launch command itself, which is true for every shipped adapter.
func (Base) GetPromptDeliveryStrategy(ctx context.Context, _ ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return ports.PromptDeliveryInCommand, nil
}

// GetAgentHooks is a no-op for harnesses without a native hook surface.
func (Base) GetAgentHooks(ctx context.Context, _ ports.WorkspaceHookConfig) error {
	return ctx.Err()
}

// GetRestoreCommand reports that no existing native session can be continued.
func (Base) GetRestoreCommand(ctx context.Context, _ ports.RestoreConfig) (cmd []string, ok bool, err error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	return nil, false, nil
}

// SessionInfo reports no agent-owned session metadata.
func (Base) SessionInfo(ctx context.Context, _ ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	return ports.SessionInfo{}, false, nil
}

// StandardSessionInfo returns the normalized session metadata (native session
// id, title, summary) an adapter's hooks persisted under the shared
// ports.MetadataKey* keys. ok is false when none of the three is present. An
// adapter whose SessionInfo just reads those keys delegates here.
func StandardSessionInfo(session ports.SessionRef) (ports.SessionInfo, bool) {
	info := ports.SessionInfo{
		AgentSessionID: session.Metadata[ports.MetadataKeyAgentSessionID],
		Title:          session.Metadata[ports.MetadataKeyTitle],
		Summary:        session.Metadata[ports.MetadataKeySummary],
	}
	if info.AgentSessionID == "" && info.Title == "" && info.Summary == "" {
		return ports.SessionInfo{}, false
	}
	return info, true
}
