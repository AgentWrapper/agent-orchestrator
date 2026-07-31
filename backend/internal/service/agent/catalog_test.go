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

type fakeModelCache struct {
	records map[string]ports.CachedAgentModelCatalog
	puts    int
}

type fakeProjectLookup struct {
	records map[string]domain.ProjectRecord
	gotID   string
	err     error
}

func (f *fakeProjectLookup) GetProject(_ context.Context, id string) (domain.ProjectRecord, bool, error) {
	f.gotID = id
	if f.err != nil {
		return domain.ProjectRecord{}, false, f.err
	}
	record, ok := f.records[id]
	return record, ok, nil
}

func (f *fakeModelCache) GetAgentModelCatalog(_ context.Context, agentID, projectID string) (ports.CachedAgentModelCatalog, bool, error) {
	record, ok := f.records[agentID+"\x00"+projectID]
	return record, ok, nil
}

func (f *fakeModelCache) UpsertAgentModelCatalog(_ context.Context, record ports.CachedAgentModelCatalog) error {
	if f.records == nil {
		f.records = map[string]ports.CachedAgentModelCatalog{}
	}
	f.records[record.AgentID+"\x00"+record.ProjectID] = record
	f.puts++
	return nil
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

func TestProbeBypassesRefreshRateLimitForOneAgent(t *testing.T) {
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
			Agent: probeTrackingAgent{fakeAgent: fakeAgent{}, onProbe: func() { probes++ }},
		},
		harnessAgent("missing", "Missing", ports.ErrAgentBinaryNotFound),
	})

	if _, err := svc.Refresh(context.Background()); err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	got, err := svc.Probe(context.Background(), "codex")
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if !got.Supported || !got.Installed || got.Agent.ID != "codex" {
		t.Fatalf("Probe = %#v, want supported installed codex", got)
	}
	if probes != 2 {
		t.Fatalf("probes = %d, want refresh plus fresh probe", probes)
	}
}

func TestProbeReportsUnsupportedAndMissingAgent(t *testing.T) {
	svc := NewWithAgents([]agentregistry.HarnessAgent{
		harnessAgent("missing", "Missing", ports.ErrAgentBinaryNotFound),
	})

	missing, err := svc.Probe(context.Background(), "missing")
	if err != nil {
		t.Fatalf("Probe missing: %v", err)
	}
	if !missing.Supported || missing.Installed {
		t.Fatalf("Probe missing = %#v, want supported but not installed", missing)
	}

	unsupported, err := svc.Probe(context.Background(), "unknown")
	if err != nil {
		t.Fatalf("Probe unknown: %v", err)
	}
	if unsupported.Supported || unsupported.Installed || unsupported.Agent.ID != "unknown" {
		t.Fatalf("Probe unknown = %#v, want unsupported unknown", unsupported)
	}
}

func TestModelsCachesStaticCatalogByProject(t *testing.T) {
	cache := &fakeModelCache{}
	svc := newService([]agentregistry.HarnessAgent{
		harnessAgent("codex", "Codex", nil),
	}, cache, nil)

	first, err := svc.Models(context.Background(), "codex", "proj-1", false)
	if err != nil {
		t.Fatal(err)
	}
	if first.SelectionMode != ports.ModelSelectionCatalog || len(first.Models) == 0 || !first.AllowCustom {
		t.Fatalf("first catalog = %#v", first)
	}
	if cache.puts != 1 {
		t.Fatalf("cache puts = %d, want 1", cache.puts)
	}

	second, err := svc.Models(context.Background(), "codex", "proj-1", false)
	if err != nil {
		t.Fatal(err)
	}
	if cache.puts != 1 {
		t.Fatalf("cache puts after hit = %d, want 1", cache.puts)
	}
	if second.Source != first.Source || len(second.Models) != len(first.Models) {
		t.Fatalf("cached catalog = %#v, want %#v", second, first)
	}
}

func TestModelsResolvesProjectWorkingDirectory(t *testing.T) {
	projects := &fakeProjectLookup{records: map[string]domain.ProjectRecord{
		"proj-1": {ID: "proj-1", Path: "/work/project"},
	}}
	svc := newService([]agentregistry.HarnessAgent{
		harnessAgent("codex", "Codex", nil),
	}, nil, projects)

	if _, err := svc.Models(context.Background(), "codex", "proj-1", false); err != nil {
		t.Fatal(err)
	}
	if projects.gotID != "proj-1" {
		t.Fatalf("project lookup id = %q, want proj-1", projects.gotID)
	}
}

func TestModelsRejectsUnknownProjectScope(t *testing.T) {
	svc := newService([]agentregistry.HarnessAgent{
		harnessAgent("codex", "Codex", nil),
	}, nil, &fakeProjectLookup{records: map[string]domain.ProjectRecord{}})

	if _, err := svc.Models(context.Background(), "codex", "missing", false); err == nil {
		t.Fatal("Models: want unknown-project error")
	}
}

func TestModelsUsesTextFallbackWhenDiscoveryCannotRun(t *testing.T) {
	svc := NewWithAgents([]agentregistry.HarnessAgent{
		harnessAgent("qwen", "Qwen", ports.ErrAgentBinaryNotFound),
	})
	got, err := svc.Models(context.Background(), "qwen", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if got.SelectionMode != ports.ModelSelectionText || !got.AllowCustom {
		t.Fatalf("catalog = %#v, want custom text input", got)
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
