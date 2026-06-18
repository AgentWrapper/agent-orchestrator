package agent

import (
	"context"
	"errors"
	"sort"

	agentregistry "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/registry"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Info is the user-facing identity for an agent adapter.
type Info struct {
	ID         string                `json:"id"`
	Label      string                `json:"label"`
	AuthStatus ports.AgentAuthStatus `json:"authStatus,omitempty" enum:"authorized,unauthorized,unknown"`
}

// Inventory describes all daemon-supported agents and which are runnable here.
type Inventory struct {
	Supported  []Info `json:"supported"`
	Installed  []Info `json:"installed"`
	Authorized []Info `json:"authorized"`
}

// Service reports supported and locally runnable agent adapters.
type Service struct {
	agents []agentregistry.HarnessAgent
}

// New returns an agent inventory service backed by the daemon's shipped
// adapter registry.
func New() *Service {
	return &Service{agents: agentregistry.Harnessed()}
}

// NewWithAgents returns an inventory service over a caller-provided adapter
// slice. It is used by focused tests.
func NewWithAgents(agents []agentregistry.HarnessAgent) *Service {
	return &Service{agents: agents}
}

// List returns every supported agent plus the subset whose binary can be
// resolved on this machine. Detector errors are intentionally isolated to the
// affected agent; one broken adapter should not hide the rest of the catalog.
func (s *Service) List(ctx context.Context) (Inventory, error) {
	supported := make([]Info, 0, len(s.agents))
	installed := make([]Info, 0, len(s.agents))
	authorized := make([]Info, 0, len(s.agents))
	for _, item := range s.agents {
		if err := ctx.Err(); err != nil {
			return Inventory{}, err
		}
		info := Info{ID: string(item.Harness), Label: item.Manifest.Name}
		if info.Label == "" {
			info.Label = info.ID
		}
		supported = append(supported, info)
		if _, err := item.Agent.GetLaunchCommand(ctx, ports.LaunchConfig{}); err == nil {
			info.AuthStatus = authStatus(ctx, item.Agent)
			installed = append(installed, info)
			if info.AuthStatus == ports.AgentAuthStatusAuthorized {
				authorized = append(authorized, info)
			}
		} else if errors.Is(err, ports.ErrAgentBinaryNotFound) {
			continue
		} else {
			continue
		}
	}

	sortInfos(supported)
	sortInfos(installed)
	sortInfos(authorized)
	return Inventory{
		Supported:  supported,
		Installed:  installed,
		Authorized: authorized,
	}, nil
}

func authStatus(ctx context.Context, a ports.Agent) ports.AgentAuthStatus {
	checker, ok := a.(ports.AgentAuthChecker)
	if !ok {
		return ports.AgentAuthStatusUnknown
	}
	status, err := checker.AuthStatus(ctx)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return ports.AgentAuthStatusUnknown
		}
		return ports.AgentAuthStatusUnknown
	}
	switch status {
	case ports.AgentAuthStatusAuthorized, ports.AgentAuthStatusUnauthorized:
		return status
	default:
		return ports.AgentAuthStatusUnknown
	}
}

func sortInfos(infos []Info) {
	sort.Slice(infos, func(i, j int) bool {
		return infos[i].ID < infos[j].ID
	})
}
