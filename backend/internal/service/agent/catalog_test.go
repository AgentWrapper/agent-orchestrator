package agent

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	agentregistry "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/registry"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeAgent struct {
	err   error
	delay time.Duration
}

type fakeAuthAgent struct {
	fakeAgent
	status    ports.AgentAuthStatus
	authErr   error
	authDelay time.Duration
}

type probeTrackingAgent struct {
	fakeAgent
	onProbe func()
}

func (f fakeAgent) GetConfigSpec(context.Context) (ports.ConfigSpec, error) {
	return ports.ConfigSpec{}, nil
}

func (f fakeAgent) GetLaunchCommand(ctx context.Context, _ ports.LaunchConfig) ([]string, error) {
	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if f.err != nil {
		return nil, f.err
	}
	return []string{"agent"}, nil
}

func (f fakeAgent) ResolveBinary(ctx context.Context) (string, error) {
	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	if f.err != nil {
		return "", f.err
	}
	return "agent", nil
}

func (f probeTrackingAgent) ResolveBinary(ctx context.Context) (string, error) {
	if f.onProbe != nil {
		f.onProbe()
	}
	return f.fakeAgent.ResolveBinary(ctx)
}

func (f fakeAgent) GetPromptDeliveryStrategy(context.Context, ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	return ports.PromptDeliveryInCommand, nil
}

func (f fakeAgent) GetAgentHooks(context.Context, ports.WorkspaceHookConfig) error {
	return nil
}

func (f fakeAgent) GetRestoreCommand(context.Context, ports.RestoreConfig) ([]string, bool, error) {
	return nil, false, nil
}

func (f fakeAgent) SessionInfo(context.Context, ports.SessionRef) (ports.SessionInfo, bool, error) {
	return ports.SessionInfo{}, false, nil
}

func (f fakeAuthAgent) AuthStatus(ctx context.Context) (ports.AgentAuthStatus, error) {
	if f.authDelay > 0 {
		select {
		case <-time.After(f.authDelay):
		case <-ctx.Done():
			return ports.AgentAuthStatusUnknown, ctx.Err()
		}
	}
	return f.status, f.authErr
}

func TestListReturnsInitialSupportedInventoryWithoutProbing(t *testing.T) {
	probed := false
	svc := NewWithAgents([]agentregistry.HarnessAgent{
		{
			Harness: domain.AgentHarness("codex"),
			Manifest: adapters.Manifest{
				ID:   "codex",
				Name: "Codex",
			},
			Agent: probeTrackingAgent{onProbe: func() { probed = true }},
		},
	})

	got, err := svc.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if probed {
		t.Fatal("List ran a live probe")
	}
	if len(got.Supported) != 1 || got.Supported[0].ID != "codex" {
		t.Fatalf("supported = %#v, want codex", got.Supported)
	}
	if len(got.Installed) != 0 || len(got.Authorized) != 0 {
		t.Fatalf("inventory = %#v, want only supported entries before refresh", got)
	}
	if got.Installed == nil {
		t.Fatal("Installed = nil, want empty slice")
	}
	if got.Authorized == nil {
		t.Fatal("Authorized = nil, want empty slice")
	}
}

func TestRefreshReportsInstalledAgentsAndIgnoresDetectorErrors(t *testing.T) {
	svc := NewWithAgents([]agentregistry.HarnessAgent{
		harnessAgent("codex", "Codex", nil),
		harnessAgent("missing", "Missing", ports.ErrAgentBinaryNotFound),
		harnessAgent("broken", "Broken", errors.New("unexpected detector failure")),
	})

	got, err := svc.Refresh(context.Background())
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if len(got.Supported) != 3 {
		t.Fatalf("supported = %#v, want 3 agents", got.Supported)
	}
	if len(got.Installed) != 1 || got.Installed[0].ID != "codex" {
		t.Fatalf("installed = %#v, want only codex", got.Installed)
	}
}

func TestRefreshReportsAuthorizedInstalledAgents(t *testing.T) {
	svc := NewWithAgents([]agentregistry.HarnessAgent{
		harnessAuthAgent("codex", "Codex", ports.AgentAuthStatusAuthorized, nil),
		harnessAuthAgent("claude-code", "Claude Code", ports.AgentAuthStatusUnauthorized, nil),
		harnessAgent("opencode", "OpenCode", nil),
		harnessAuthAgent("broken-auth", "Broken Auth", ports.AgentAuthStatusAuthorized, errors.New("probe failed")),
	})

	got, err := svc.Refresh(context.Background())
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if len(got.Supported) != 4 || len(got.Installed) != 4 {
		t.Fatalf("inventory = %#v, want supported=4 installed=4", got)
	}
	if len(got.Authorized) != 1 || got.Authorized[0].ID != "codex" {
		t.Fatalf("authorized = %#v, want only codex", got.Authorized)
	}

	byID := map[string]Info{}
	for _, info := range got.Installed {
		byID[info.ID] = info
	}
	if byID["codex"].AuthStatus != ports.AgentAuthStatusAuthorized {
		t.Fatalf("codex authStatus = %q", byID["codex"].AuthStatus)
	}
	if byID["claude-code"].AuthStatus != ports.AgentAuthStatusUnauthorized {
		t.Fatalf("claude-code authStatus = %q", byID["claude-code"].AuthStatus)
	}
	if byID["opencode"].AuthStatus != ports.AgentAuthStatusUnknown {
		t.Fatalf("opencode authStatus = %q", byID["opencode"].AuthStatus)
	}
	if byID["broken-auth"].AuthStatus != ports.AgentAuthStatusUnknown {
		t.Fatalf("broken-auth authStatus = %q", byID["broken-auth"].AuthStatus)
	}
}

func TestRefreshDoesNotWaitForSlowAgentProbe(t *testing.T) {
	previous := agentInstallProbeTimeout
	agentInstallProbeTimeout = 20 * time.Millisecond
	t.Cleanup(func() { agentInstallProbeTimeout = previous })

	svc := NewWithAgents([]agentregistry.HarnessAgent{
		harnessAgent("codex", "Codex", nil),
		{
			Harness: domain.AgentHarness("slow"),
			Manifest: adapters.Manifest{
				ID:   "slow",
				Name: "Slow",
			},
			Agent: fakeAgent{delay: time.Minute},
		},
	})

	start := time.Now()
	got, err := svc.Refresh(context.Background())
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("List took %s, want bounded by slow probe timeout", elapsed)
	}
	if len(got.Supported) != 2 {
		t.Fatalf("supported = %#v, want both agents", got.Supported)
	}
	if len(got.Installed) != 1 || got.Installed[0].ID != "codex" {
		t.Fatalf("installed = %#v, want only codex", got.Installed)
	}
}

func TestRefreshUsesSeparateTimeoutForAuthProbe(t *testing.T) {
	previousInstall := agentInstallProbeTimeout
	previousAuth := agentAuthProbeTimeout
	agentInstallProbeTimeout = 20 * time.Millisecond
	agentAuthProbeTimeout = 200 * time.Millisecond
	t.Cleanup(func() {
		agentInstallProbeTimeout = previousInstall
		agentAuthProbeTimeout = previousAuth
	})

	svc := NewWithAgents([]agentregistry.HarnessAgent{
		{
			Harness: domain.AgentHarness("claude-code"),
			Manifest: adapters.Manifest{
				ID:   "claude-code",
				Name: "Claude Code",
			},
			Agent: fakeAuthAgent{
				fakeAgent: fakeAgent{},
				status:    ports.AgentAuthStatusAuthorized,
				authDelay: 75 * time.Millisecond,
			},
		},
	})

	got, err := svc.Refresh(context.Background())
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if len(got.Authorized) != 1 || got.Authorized[0].ID != "claude-code" {
		t.Fatalf("authorized = %#v, want claude-code", got.Authorized)
	}
}

func TestRefreshIsRateLimited(t *testing.T) {
	previous := agentRefreshMinInterval
	agentRefreshMinInterval = time.Hour
	t.Cleanup(func() { agentRefreshMinInterval = previous })

	probes := 0
	svc := NewWithAgents([]agentregistry.HarnessAgent{
		{
			Harness: domain.AgentHarness("codex"),
			Manifest: adapters.Manifest{
				ID:   "codex",
				Name: "Codex",
			},
			Agent: probeTrackingAgent{onProbe: func() { probes++ }},
		},
	})

	if _, err := svc.Refresh(context.Background()); err != nil {
		t.Fatalf("first Refresh: %v", err)
	}
	if _, err := svc.Refresh(context.Background()); err != nil {
		t.Fatalf("second Refresh: %v", err)
	}
	if probes != 1 {
		t.Fatalf("probes = %d, want 1", probes)
	}
}

func harnessAgent(id, label string, err error) agentregistry.HarnessAgent {
	return agentregistry.HarnessAgent{
		Harness: domain.AgentHarness(id),
		Manifest: adapters.Manifest{
			ID:   id,
			Name: label,
		},
		Agent: fakeAgent{err: err},
	}
}

func harnessAuthAgent(id, label string, status ports.AgentAuthStatus, err error) agentregistry.HarnessAgent {
	return agentregistry.HarnessAgent{
		Harness: domain.AgentHarness(id),
		Manifest: adapters.Manifest{
			ID:   id,
			Name: label,
		},
		Agent: fakeAuthAgent{fakeAgent: fakeAgent{}, status: status, authErr: err},
	}
}
