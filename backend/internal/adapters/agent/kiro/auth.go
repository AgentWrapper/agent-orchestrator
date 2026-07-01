package kiro

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/authprobe"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

var _ ports.AgentAuthChecker = (*Plugin)(nil)

// AuthStatus returns the plugin's local authentication status.
func (p *Plugin) AuthStatus(ctx context.Context) (ports.AgentAuthStatus, error) {
	binary, err := p.kiroBinary(ctx)
	if err != nil {
		return ports.AgentAuthStatusUnknown, err
	}
	return kiroWhoamiAuthStatus(ctx, binary)
}

func kiroWhoamiAuthStatus(ctx context.Context, binary string) (ports.AgentAuthStatus, error) {
	if binary == "" {
		return ports.AgentAuthStatusUnknown, nil
	}
	out, err := authprobe.CmdRunner(ctx, binary, "whoami")
	if ctx.Err() != nil {
		return ports.AgentAuthStatusUnknown, ctx.Err()
	}
	if status := authprobe.StatusFromText(string(out)); status != ports.AgentAuthStatusUnknown {
		return status, nil
	}
	if err == nil {
		return ports.AgentAuthStatusAuthorized, nil
	}
	return ports.AgentAuthStatusUnknown, nil
}
