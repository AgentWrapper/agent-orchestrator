package agent

import (
	"context"
	"errors"
	"strings"
	"sync"
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

type modelProbeAgent struct {
	fakeAgent
	mu     sync.Mutex
	err    error
	models []string
}

type modelCatalogAgent struct {
	fakeAgent
	modelProbeAgent
	catalog []string
}

type blockingModelProbeAgent struct {
	fakeAgent
	started chan string
	release <-chan struct{}
}

type cancelOnceModelProbeAgent struct {
	fakeAgent
	mu      sync.Mutex
	calls   int
	started chan struct{}
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

func (f *modelProbeAgent) ValidateModel(ctx context.Context, model string) error {
	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.models = append(f.models, model)
	return f.err
}

func (f *modelCatalogAgent) AvailableModels(context.Context) ([]string, error) {
	return append([]string(nil), f.catalog...), nil
}

func (f *blockingModelProbeAgent) ValidateModel(ctx context.Context, model string) error {
	select {
	case f.started <- model:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-f.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (f *cancelOnceModelProbeAgent) ValidateModel(ctx context.Context, model string) error {
	f.mu.Lock()
	f.calls++
	call := f.calls
	f.mu.Unlock()
	if call == 1 {
		select {
		case f.started <- struct{}{}:
		default:
		}
		<-ctx.Done()
		return ctx.Err()
	}
	return nil
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

func TestValidateModelForwardsToMatchingHarness(t *testing.T) {
	codex := &modelProbeAgent{}
	claude := &modelProbeAgent{}
	svc := NewWithAgents([]agentregistry.HarnessAgent{
		{
			Harness:  domain.HarnessCodex,
			Manifest: adapters.Manifest{ID: string(domain.HarnessCodex), Name: "Codex"},
			Agent:    codex,
		},
		{
			Harness:  domain.HarnessClaudeCode,
			Manifest: adapters.Manifest{ID: string(domain.HarnessClaudeCode), Name: "Claude Code"},
			Agent:    claude,
		},
	})

	if err := svc.ValidateModel(context.Background(), domain.HarnessCodex, " gpt-5.5-codex "); err != nil {
		t.Fatalf("ValidateModel: %v", err)
	}
	if len(codex.models) != 1 || codex.models[0] != "gpt-5.5-codex" {
		t.Fatalf("codex models = %#v, want trimmed model", codex.models)
	}
	if len(claude.models) != 0 {
		t.Fatalf("claude models = %#v, want no probe", claude.models)
	}
}

func TestValidateModelReportsUnsupportedHarness(t *testing.T) {
	svc := NewWithAgents(nil)
	err := svc.ValidateModel(context.Background(), domain.AgentHarness("missing"), "model")
	if err == nil {
		t.Fatal("ValidateModel err = nil, want unsupported harness")
	}
	if !strings.Contains(err.Error(), "unsupported agent") {
		t.Fatalf("ValidateModel err = %v, want unsupported agent", err)
	}
}

func TestModelAvailabilityClassifiesProbeResults(t *testing.T) {
	rejected := &modelProbeAgent{err: errors.New("400 model not available")}
	unavailable := &modelProbeAgent{err: &ports.ProbeUnavailableError{Reason: "codex exec usage error"}}
	svc := NewWithAgents([]agentregistry.HarnessAgent{
		{
			Harness:  domain.HarnessCodex,
			Manifest: adapters.Manifest{ID: string(domain.HarnessCodex), Name: "Codex"},
			Agent:    rejected,
		},
		{
			Harness:  domain.HarnessCodexFugu,
			Manifest: adapters.Manifest{ID: string(domain.HarnessCodexFugu), Name: "Codex Fugu"},
			Agent:    unavailable,
		},
	})

	got, err := svc.ModelAvailability(context.Background(), ModelAvailabilityRequest{
		Pins: []ModelPin{
			{Harness: domain.HarnessCodex, Model: "gpt-5.5-codex"},
			{Harness: domain.HarnessCodexFugu, Model: "fugu-ultra"},
		},
	})
	if err != nil {
		t.Fatalf("ModelAvailability: %v", err)
	}
	byHarness := map[string]HarnessModels{}
	for _, h := range got.Harnesses {
		byHarness[h.ID] = h
	}
	codex, ok := findModel(byHarness[string(domain.HarnessCodex)].Models, "gpt-5.5-codex")
	if !ok {
		t.Fatalf("codex models = %#v, want configured pin", byHarness[string(domain.HarnessCodex)].Models)
	}
	if codex.Status != ModelStatusUnreachable || !strings.Contains(codex.Reason, "400 model not available") {
		t.Fatalf("codex model = %#v, want unreachable with provider reason", codex)
	}
	fugu := byHarness[string(domain.HarnessCodexFugu)].Models[0]
	if fugu.Status != ModelStatusUnknown || !strings.Contains(fugu.Reason, "codex exec usage error") {
		t.Fatalf("fugu model = %#v, want unknown with probe-unavailable reason", fugu)
	}
}

func TestModelAvailabilityProbesConfiguredPinsConcurrently(t *testing.T) {
	started := make(chan string, 2)
	release := make(chan struct{})
	svc := NewWithAgents([]agentregistry.HarnessAgent{
		{
			Harness:  domain.HarnessCodex,
			Manifest: adapters.Manifest{ID: string(domain.HarnessCodex), Name: "Codex"},
			Agent:    &blockingModelProbeAgent{started: started, release: release},
		},
		{
			Harness:  domain.HarnessClaudeCode,
			Manifest: adapters.Manifest{ID: string(domain.HarnessClaudeCode), Name: "Claude Code"},
			Agent:    &blockingModelProbeAgent{started: started, release: release},
		},
	})
	done := make(chan error, 1)
	go func() {
		_, err := svc.ModelAvailability(context.Background(), ModelAvailabilityRequest{
			Pins: []ModelPin{
				{Harness: domain.HarnessCodex, Model: "gpt-5-codex"},
				{Harness: domain.HarnessClaudeCode, Model: "opus"},
			},
		})
		done <- err
	}()
	for i := 0; i < 2; i++ {
		select {
		case <-started:
		case <-time.After(500 * time.Millisecond):
			t.Fatal("timed out waiting for both configured model probes to start concurrently")
		}
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("ModelAvailability: %v", err)
	}
}

func TestModelAvailabilityUsesCatalogAndFallsBackToKnownSet(t *testing.T) {
	catalog := &modelCatalogAgent{catalog: []string{"gpt-5-codex", "gpt-5-codex"}}
	svc := NewWithAgents([]agentregistry.HarnessAgent{
		{
			Harness:  domain.HarnessCodex,
			Manifest: adapters.Manifest{ID: string(domain.HarnessCodex), Name: "Codex"},
			Agent:    catalog,
		},
		harnessAgent(string(domain.HarnessClaudeCode), "Claude Code", nil),
	})

	got, err := svc.ModelAvailability(context.Background(), ModelAvailabilityRequest{
		Pins: []ModelPin{{Harness: domain.HarnessClaudeCode, Model: "claude-custom"}},
	})
	if err != nil {
		t.Fatalf("ModelAvailability: %v", err)
	}
	byHarness := map[string]HarnessModels{}
	for _, h := range got.Harnesses {
		byHarness[h.ID] = h
	}
	if byHarness[string(domain.HarnessCodex)].CatalogSource != ModelCatalogAdapter {
		t.Fatalf("codex catalog source = %q, want adapter", byHarness[string(domain.HarnessCodex)].CatalogSource)
	}
	if len(byHarness[string(domain.HarnessCodex)].Models) != 1 || byHarness[string(domain.HarnessCodex)].Models[0].Model != "gpt-5-codex" {
		t.Fatalf("codex models = %#v, want deduped adapter catalog", byHarness[string(domain.HarnessCodex)].Models)
	}
	if byHarness[string(domain.HarnessCodex)].Models[0].Status != ModelStatusUnknown {
		t.Fatalf("codex model = %#v, want unprobed adapter row marked unknown", byHarness[string(domain.HarnessCodex)].Models[0])
	}
	claude := byHarness[string(domain.HarnessClaudeCode)]
	if claude.CatalogSource != ModelCatalogKnownSet {
		t.Fatalf("claude catalog source = %q, want known-set", claude.CatalogSource)
	}
	if !hasModel(claude.Models, "claude-custom") {
		t.Fatalf("claude models = %#v, want configured pin included", claude.Models)
	}
}

func TestModelAvailabilityDoesNotProbeUnconfiguredKnownSet(t *testing.T) {
	probe := &modelProbeAgent{err: errors.New("should not probe")}
	svc := NewWithAgents([]agentregistry.HarnessAgent{{
		Harness:  domain.HarnessCodex,
		Manifest: adapters.Manifest{ID: string(domain.HarnessCodex), Name: "Codex"},
		Agent:    probe,
	}})

	got, err := svc.ModelAvailability(context.Background(), ModelAvailabilityRequest{})
	if err != nil {
		t.Fatalf("ModelAvailability: %v", err)
	}
	if len(probe.models) != 0 {
		t.Fatalf("probed models = %#v, want no live probes for unconfigured known-set rows", probe.models)
	}
	if len(got.Harnesses) != 1 || got.Harnesses[0].CatalogSource != ModelCatalogKnownSet {
		t.Fatalf("harnesses = %#v, want known-set harness", got.Harnesses)
	}
	if len(got.Harnesses[0].Models) == 0 || got.Harnesses[0].Models[0].Status != ModelStatusUnknown {
		t.Fatalf("models = %#v, want listed rows marked unknown", got.Harnesses[0].Models)
	}
}

func TestModelAvailabilityClassifiesRawContextProbeErrorAsUnknown(t *testing.T) {
	svc := NewWithAgents([]agentregistry.HarnessAgent{{
		Harness:  domain.HarnessCodex,
		Manifest: adapters.Manifest{ID: string(domain.HarnessCodex), Name: "Codex"},
		Agent:    &modelProbeAgent{err: context.DeadlineExceeded},
	}})

	got, err := svc.ModelAvailability(context.Background(), ModelAvailabilityRequest{
		Pins: []ModelPin{{Harness: domain.HarnessCodex, Model: "gpt-5-codex"}},
	})
	if err != nil {
		t.Fatalf("ModelAvailability: %v", err)
	}
	model, ok := findModel(got.Harnesses[0].Models, "gpt-5-codex")
	if !ok {
		t.Fatalf("models = %#v, want configured pin", got.Harnesses[0].Models)
	}
	if model.Status != ModelStatusUnknown {
		t.Fatalf("model = %#v, want raw context probe error classified unknown", model)
	}
}

func TestModelAvailabilityCachesRequestPathAndForceBypasses(t *testing.T) {
	probe := &modelProbeAgent{}
	svc := NewWithAgents([]agentregistry.HarnessAgent{{
		Harness:  domain.HarnessCodex,
		Manifest: adapters.Manifest{ID: string(domain.HarnessCodex), Name: "Codex"},
		Agent:    probe,
	}})
	req := ModelAvailabilityRequest{Pins: []ModelPin{{Harness: domain.HarnessCodex, Model: "gpt-5-codex"}}}

	if _, err := svc.ModelAvailability(context.Background(), req); err != nil {
		t.Fatalf("ModelAvailability 1: %v", err)
	}
	if _, err := svc.ModelAvailability(context.Background(), req); err != nil {
		t.Fatalf("ModelAvailability 2: %v", err)
	}
	if len(probe.models) != 1 {
		t.Fatalf("probed models after cached calls = %#v, want one probe", probe.models)
	}
	req.Force = true
	if _, err := svc.ModelAvailability(context.Background(), req); err != nil {
		t.Fatalf("ModelAvailability force: %v", err)
	}
	if len(probe.models) != 2 {
		t.Fatalf("probed models after force = %#v, want force to bypass cache", probe.models)
	}
}

func TestModelAvailabilityDoesNotCacheCancelledProbeResponse(t *testing.T) {
	probe := &cancelOnceModelProbeAgent{started: make(chan struct{}, 1)}
	svc := NewWithAgents([]agentregistry.HarnessAgent{{
		Harness:  domain.HarnessCodex,
		Manifest: adapters.Manifest{ID: string(domain.HarnessCodex), Name: "Codex"},
		Agent:    probe,
	}})
	req := ModelAvailabilityRequest{Pins: []ModelPin{{Harness: domain.HarnessCodex, Model: "gpt-5-codex"}}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan ModelAvailabilityResponse, 1)
	errc := make(chan error, 1)
	go func() {
		got, err := svc.ModelAvailability(ctx, req)
		if err != nil {
			errc <- err
			return
		}
		done <- got
	}()
	<-probe.started
	cancel()
	var first ModelAvailabilityResponse
	select {
	case err := <-errc:
		t.Fatalf("ModelAvailability cancelled response: %v", err)
	case first = <-done:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for cancelled model availability response")
	}
	model, ok := findModel(first.Harnesses[0].Models, "gpt-5-codex")
	if !ok || model.Status != ModelStatusUnknown {
		t.Fatalf("first model = %#v, want unknown cancelled response", model)
	}

	second, err := svc.ModelAvailability(context.Background(), req)
	if err != nil {
		t.Fatalf("ModelAvailability retry: %v", err)
	}
	model, ok = findModel(second.Harnesses[0].Models, "gpt-5-codex")
	if !ok || model.Status != ModelStatusReachable {
		t.Fatalf("second model = %#v, want fresh reachable response", model)
	}
	probe.mu.Lock()
	calls := probe.calls
	probe.mu.Unlock()
	if calls != 2 {
		t.Fatalf("ValidateModel calls = %d, want cancelled response not cached", calls)
	}
}

func hasModel(models []ModelAvailability, want string) bool {
	_, ok := findModel(models, want)
	return ok
}

func findModel(models []ModelAvailability, want string) (ModelAvailability, bool) {
	for _, model := range models {
		if model.Model == want {
			return model, true
		}
	}
	return ModelAvailability{}, false
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
