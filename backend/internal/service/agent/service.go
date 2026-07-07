package agent

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	agentregistry "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/registry"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

var (
	agentInstallProbeTimeout = 2 * time.Second
	agentAuthProbeTimeout    = 10 * time.Second
	agentRefreshMinInterval  = 10 * time.Second
)

type probeResult struct {
	info       Info
	installed  bool
	authorized bool
}

// ProbeResult describes a fresh readiness probe for one supported agent.
type ProbeResult struct {
	Agent     Info `json:"agent"`
	Supported bool `json:"supported"`
	Installed bool `json:"installed"`
}

// Info is the user-facing identity for an agent adapter.
type Info struct {
	ID         string                `json:"id"`
	Label      string                `json:"label"`
	AuthStatus ports.AgentAuthStatus `json:"authStatus,omitempty" enum:"authorized,unauthorized,unknown" description:"Advisory local auth probe result. authorized means a recent local probe passed; spawn remains the authoritative validation point."`
}

// Inventory describes all daemon-supported agents and best-effort local probe
// results. Installed/authorized entries are advisory snapshots and can be stale;
// session spawn is the authoritative validation point for binary availability,
// runtime prerequisites, and model-call readiness.
type Inventory struct {
	Supported  []Info `json:"supported" description:"Agents supported by this daemon build."`
	Installed  []Info `json:"installed" description:"Agents whose binary resolved during the latest best-effort local catalog probe."`
	Authorized []Info `json:"authorized" description:"Compatibility list of installed agents whose local auth probe recently returned authorized. Advisory and stale-prone; spawn may still fail."`
}

// Service reports supported agent adapters and best-effort local readiness
// probes. Catalog readiness is advisory UI metadata, not a spawn precheck.
type Service struct {
	agents []agentregistry.HarnessAgent

	mu          sync.RWMutex
	inventory   Inventory
	lastRefresh time.Time
	refreshMu   sync.Mutex
}

// New returns an agent inventory service backed by the daemon's shipped
// adapter registry.
func New() *Service {
	return NewWithAgents(agentregistry.Harnessed())
}

// NewWithAgents returns an inventory service over a caller-provided adapter
// slice. It is used by focused tests.
func NewWithAgents(agents []agentregistry.HarnessAgent) *Service {
	return &Service{agents: agents, inventory: Inventory{
		Supported:  supportedInfos(agents),
		Installed:  []Info{},
		Authorized: []Info{},
	}}
}

// List returns the cached agent inventory without running probes. Installed and
// authorized entries come from the last explicit Refresh call and are advisory:
// they can be stale by the time a user starts a session, and session spawn
// performs the authoritative binary/runtime validation.
func (s *Service) List(ctx context.Context) (Inventory, error) {
	if err := ctx.Err(); err != nil {
		return Inventory{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneInventory(s.inventory), nil
}

// Refresh runs the bounded local binary/auth probes, updates the cached
// inventory, and returns the new snapshot. Refreshes are serialized and
// rate-limited so repeated frontend reloads cannot stampede agent CLIs.
func (s *Service) Refresh(ctx context.Context) (Inventory, error) {
	if err := ctx.Err(); err != nil {
		return Inventory{}, err
	}
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()

	s.mu.RLock()
	if !s.lastRefresh.IsZero() && time.Since(s.lastRefresh) < agentRefreshMinInterval {
		cached := cloneInventory(s.inventory)
		s.mu.RUnlock()
		return cached, nil
	}
	s.mu.RUnlock()

	results := make(chan probeResult, len(s.agents))
	var wg sync.WaitGroup
	for _, item := range s.agents {
		if err := ctx.Err(); err != nil {
			return Inventory{}, err
		}
		wg.Add(1)
		go func(item agentregistry.HarnessAgent) {
			defer wg.Done()
			results <- probeAgent(ctx, item)
		}(item)
	}
	wg.Wait()
	close(results)

	supported := make([]Info, 0, len(s.agents))
	installed := make([]Info, 0, len(s.agents))
	authorized := make([]Info, 0, len(s.agents))
	for res := range results {
		supported = append(supported, res.info)
		if res.installed {
			installed = append(installed, res.info)
		}
		if res.authorized {
			authorized = append(authorized, res.info)
		}
	}
	sortInfos(supported)
	sortInfos(installed)
	sortInfos(authorized)
	next := Inventory{
		Supported:  supported,
		Installed:  installed,
		Authorized: authorized,
	}
	s.mu.Lock()
	s.inventory = cloneInventory(next)
	s.lastRefresh = time.Now()
	s.mu.Unlock()
	return next, nil
}

// Probe runs a fresh bounded binary/auth probe for one agent, bypassing the
// catalog refresh rate limit. It is intended for user-initiated preflight paths
// where a cached negative catalog result may be stale.
func (s *Service) Probe(ctx context.Context, agentID string) (ProbeResult, error) {
	if err := ctx.Err(); err != nil {
		return ProbeResult{}, err
	}
	for _, item := range s.agents {
		info := Info{ID: string(item.Harness), Label: item.Manifest.Name}
		if info.Label == "" {
			info.Label = info.ID
		}
		if info.ID != agentID {
			continue
		}
		res := probeAgent(ctx, item)
		return ProbeResult{
			Agent:     res.info,
			Supported: true,
			Installed: res.installed,
		}, nil
	}
	return ProbeResult{Agent: Info{ID: agentID}, Supported: false, Installed: false}, nil
}

func supportedInfos(agents []agentregistry.HarnessAgent) []Info {
	supported := make([]Info, 0, len(agents))
	for _, item := range agents {
		info := Info{ID: string(item.Harness), Label: item.Manifest.Name}
		if info.Label == "" {
			info.Label = info.ID
		}
		supported = append(supported, info)
	}
	sortInfos(supported)
	return supported
}

func cloneInventory(in Inventory) Inventory {
	return Inventory{
		Supported:  cloneInfos(in.Supported),
		Installed:  cloneInfos(in.Installed),
		Authorized: cloneInfos(in.Authorized),
	}
}

func cloneInfos(in []Info) []Info {
	out := make([]Info, len(in))
	copy(out, in)
	return out
}

func probeAgent(ctx context.Context, item agentregistry.HarnessAgent) probeResult {
	info := Info{ID: string(item.Harness), Label: item.Manifest.Name}
	if info.Label == "" {
		info.Label = info.ID
	}
	probeCtx, cancel := context.WithTimeout(ctx, agentInstallProbeTimeout)
	defer cancel()
	resolver, ok := item.Agent.(ports.AgentBinaryResolver)
	if !ok {
		return probeResult{info: info}
	}
	if _, err := resolver.ResolveBinary(probeCtx); err != nil {
		return probeResult{info: info}
	}
	authCtx, authCancel := context.WithTimeout(ctx, agentAuthProbeTimeout)
	defer authCancel()
	info.AuthStatus = authStatus(authCtx, item.Agent)
	return probeResult{info: info, installed: true, authorized: info.AuthStatus == ports.AgentAuthStatusAuthorized}
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
