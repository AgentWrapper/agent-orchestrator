package agent

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	agentregistry "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/registry"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

var (
	agentInstallProbeTimeout = 2 * time.Second
	agentAuthProbeTimeout    = 10 * time.Second
	agentModelProbeTimeout   = 45 * time.Second
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

// ModelStatus is the availability verdict for one model candidate.
type ModelStatus string

const (
	// ModelStatusReachable means the provider/account accepted the model probe.
	ModelStatusReachable ModelStatus = "reachable"
	// ModelStatusUnreachable means the provider/account rejected the model.
	ModelStatusUnreachable ModelStatus = "unreachable"
	// ModelStatusUnknown means AO could not obtain a provider verdict.
	ModelStatusUnknown ModelStatus = "unknown"
)

// ModelCatalogSource describes where a harness's candidate model list came from.
type ModelCatalogSource string

const (
	// ModelCatalogAdapter means the adapter reported its available model list.
	ModelCatalogAdapter ModelCatalogSource = "adapter"
	// ModelCatalogKnownSet means AO used its static known model list.
	ModelCatalogKnownSet ModelCatalogSource = "known-set"
	// ModelCatalogPins means only configured pins supplied model candidates.
	ModelCatalogPins ModelCatalogSource = "configured-pins"
)

// ModelPin is a configured model that must be included in availability output
// even when it is not in an adapter catalog or known set.
type ModelPin struct {
	Harness domain.AgentHarness `json:"harness"`
	Model   string              `json:"model"`
}

// ModelAvailabilityRequest carries configured pins the caller wants merged
// into the candidate set.
type ModelAvailabilityRequest struct {
	Pins []ModelPin `json:"pins,omitempty"`
	// Force bypasses the request-path cache. Scheduled revalidation uses this so
	// the daily hygiene pass always performs fresh probes.
	Force bool `json:"-"`
}

// ModelAvailability is one model candidate and its latest reachability verdict.
type ModelAvailability struct {
	Model  string      `json:"model"`
	Status ModelStatus `json:"status" enum:"reachable,unreachable,unknown"`
	Reason string      `json:"reason,omitempty"`
}

// HarnessModels is the availability list for one harness.
type HarnessModels struct {
	ID            string              `json:"id"`
	Label         string              `json:"label"`
	CatalogSource ModelCatalogSource  `json:"catalogSource" enum:"adapter,known-set,configured-pins"`
	Models        []ModelAvailability `json:"models"`
}

// ModelAvailabilityResponse is the /agents/models read model.
type ModelAvailabilityResponse struct {
	Harnesses []HarnessModels `json:"harnesses"`
	CheckedAt time.Time       `json:"checkedAt"`
}

// Service reports supported agent adapters and best-effort local readiness
// probes. Catalog readiness is advisory UI metadata, not a spawn precheck.
type Service struct {
	agents []agentregistry.HarnessAgent

	mu             sync.RWMutex
	inventory      Inventory
	lastRefresh    time.Time
	refreshMu      sync.Mutex
	modelMu        sync.Mutex
	modelRefreshMu sync.Mutex
	modelCache     modelAvailabilityCache
	// pinVerdicts holds the latest per-pin reachability verdict recorded by ANY
	// probe path — availability views, config-save validation, and the daily
	// model-health revalidation. The spawn gate consumes it via
	// ValidateSpawnModel WITHOUT network I/O; a missing or stale entry fails
	// open there. Guarded by modelMu.
	pinVerdicts map[string]pinVerdict
}

type modelAvailabilityCache struct {
	key       string
	checkedAt time.Time
	response  ModelAvailabilityResponse
}

// pinVerdict is one cached per-pin reachability verdict.
type pinVerdict struct {
	status    ModelStatus
	reason    string
	checkedAt time.Time
}

// spawnPinVerdictTTL bounds how old a cached pin verdict may be and still gate a
// spawn. The daily model-health revalidation (default 24h) refreshes verdicts;
// two missed cycles means AO no longer holds a current opinion and the spawn
// gate fails open rather than blocking on ancient state.
const spawnPinVerdictTTL = 48 * time.Hour

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

// HarnessProbe is a fresh install/auth probe for one harness, produced for the
// periodic agent-health monitor. Unlike Inventory it is keyed by the requested
// harness id and reports the raw install+auth facts for exactly that harness.
type HarnessProbe struct {
	ID         string                `json:"id"`
	Label      string                `json:"label"`
	Installed  bool                  `json:"installed"`
	AuthStatus ports.AgentAuthStatus `json:"authStatus,omitempty"`
}

// HarnessHealth runs fresh bounded binary/auth probes for the named harnesses,
// bypassing the catalog refresh rate limit, and returns one result per id in
// the requested order. Probes run concurrently and each carries the same
// bounded install/auth timeouts as Refresh, so a slow or hung harness CLI never
// stalls the caller past those bounds. An unknown id yields a not-installed
// probe so the monitor can flag a configured-but-unsupported harness rather than
// silently dropping it.
func (s *Service) HarnessHealth(ctx context.Context, ids []string) ([]HarnessProbe, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	byID := make(map[string]agentregistry.HarnessAgent, len(s.agents))
	for _, item := range s.agents {
		byID[string(item.Harness)] = item
	}
	out := make([]HarnessProbe, len(ids))
	var wg sync.WaitGroup
	for i, id := range ids {
		item, ok := byID[id]
		if !ok {
			out[i] = HarnessProbe{ID: id, Label: id}
			continue
		}
		wg.Add(1)
		go func(i int, id string, item agentregistry.HarnessAgent) {
			defer wg.Done()
			res := probeAgent(ctx, item)
			label := res.info.Label
			if label == "" {
				label = id
			}
			out[i] = HarnessProbe{
				ID:         id,
				Label:      label,
				Installed:  res.installed,
				AuthStatus: res.info.AuthStatus,
			}
		}(i, id, item)
	}
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return out, nil
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

// ValidateModel runs a fresh bounded provider/account probe for one explicit
// model pin. Unsupported harnesses fail clearly; adapters without a model-probe
// capability remain permissive because AO cannot safely infer their model API.
func (s *Service) ValidateModel(ctx context.Context, harness domain.AgentHarness, model string) error {
	// An unpinned bucket needs no probe, so resolve it before consulting the
	// context: a cancelled context must not turn a no-op into an error.
	model = strings.TrimSpace(model)
	if model == "" {
		return nil
	}
	if err := ctx.Err(); err != nil {
		// No probe ran, so this says nothing about the model. Classify it as
		// unavailable rather than letting callers read a cancelled context as
		// "model unreachable" (#182).
		return &ports.ProbeUnavailableError{Reason: "model probe context already done", Err: err}
	}
	for _, item := range s.agents {
		if item.Harness != harness {
			continue
		}
		validator, ok := item.Agent.(ports.AgentModelValidator)
		if !ok {
			return nil
		}
		probeCtx, cancel := context.WithTimeout(ctx, agentModelProbeTimeout)
		err := validator.ValidateModel(probeCtx, model)
		cancel()
		s.recordPinVerdict(harness, model, verdictFromProbeError(err))
		if err != nil {
			return err
		}
		return nil
	}
	return fmt.Errorf("unsupported agent %q", harness)
}

// verdictFromProbeError classifies a raw AgentModelValidator error the same way
// classifyModel does: nil is reachable, an unavailable/cancelled probe is
// unknown, anything else is a definitive provider rejection.
func verdictFromProbeError(err error) pinVerdict {
	switch {
	case err == nil:
		return pinVerdict{status: ModelStatusReachable}
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded), ports.ProbeUnavailable(err):
		return pinVerdict{status: ModelStatusUnknown, reason: err.Error()}
	default:
		return pinVerdict{status: ModelStatusUnreachable, reason: err.Error()}
	}
}

// maxPinVerdicts caps the per-pin verdict cache. Real deployments hold a
// handful of configured pins; the cap only matters under config churn (many
// distinct historical pins), where evicting the oldest entries merely degrades
// the spawn gate to fail-open for pins nobody probes anymore.
const maxPinVerdicts = 256

// recordPinVerdict stores the latest reachability verdict for one harness+model
// pin so the cache-only spawn gate can consume it. Writes prune expired entries
// and enforce maxPinVerdicts (oldest-first eviction), so config churn cannot
// grow the map for the daemon's lifetime.
func (s *Service) recordPinVerdict(harness domain.AgentHarness, model string, v pinVerdict) {
	model = strings.TrimSpace(model)
	if harness == "" || model == "" {
		return
	}
	if v.checkedAt.IsZero() {
		v.checkedAt = time.Now()
	}
	s.modelMu.Lock()
	defer s.modelMu.Unlock()
	if s.pinVerdicts == nil {
		s.pinVerdicts = map[string]pinVerdict{}
	}
	for key, existing := range s.pinVerdicts {
		if time.Since(existing.checkedAt) >= spawnPinVerdictTTL {
			delete(s.pinVerdicts, key)
		}
	}
	s.pinVerdicts[modelPinKey(harness, model)] = v
	for len(s.pinVerdicts) > maxPinVerdicts {
		s.evictOnePinVerdictLocked()
	}
}

// likelyUnconfiguredPinAge marks a verdict as belonging to a pin that is
// probably no longer configured: the daily model-health revalidation (default
// 24h) refreshes every ACTIVE pin, so an entry a full cycle old (plus slack)
// has fallen out of the configured set.
const likelyUnconfiguredPinAge = 25 * time.Hour

// evictOnePinVerdictLocked removes one entry, preferring the ones whose loss is
// cheapest: first a pin the revalidation cycle no longer refreshes (likely
// unconfigured), then a fresh non-blocking verdict, and only as a last resort a
// fresh definitive rejection — evicting one of those degrades the spawn gate to
// fail-open for a pin that is still actively blocking bad launches. Caller
// holds modelMu.
func (s *Service) evictOnePinVerdictLocked() {
	oldestMatching := func(pred func(pinVerdict) bool) (string, bool) {
		key := ""
		var at time.Time
		for candidate, existing := range s.pinVerdicts {
			if !pred(existing) {
				continue
			}
			if key == "" || existing.checkedAt.Before(at) {
				key, at = candidate, existing.checkedAt
			}
		}
		return key, key != ""
	}
	if key, ok := oldestMatching(func(v pinVerdict) bool { return time.Since(v.checkedAt) >= likelyUnconfiguredPinAge }); ok {
		delete(s.pinVerdicts, key)
		return
	}
	if key, ok := oldestMatching(func(v pinVerdict) bool { return v.status != ModelStatusUnreachable }); ok {
		delete(s.pinVerdicts, key)
		return
	}
	if key, ok := oldestMatching(func(pinVerdict) bool { return true }); ok {
		delete(s.pinVerdicts, key)
	}
}

// cachedPinVerdict returns the latest recorded verdict for a pin, if it exists
// and is fresh enough to gate a spawn.
func (s *Service) cachedPinVerdict(harness domain.AgentHarness, model string) (pinVerdict, bool) {
	s.modelMu.Lock()
	defer s.modelMu.Unlock()
	v, ok := s.pinVerdicts[modelPinKey(harness, model)]
	if !ok || time.Since(v.checkedAt) >= spawnPinVerdictTTL {
		return pinVerdict{}, false
	}
	return v, true
}

// ValidateSpawnModel renders a reachability verdict for a RESOLVED spawn
// harness+model by consuming ONLY the cached per-pin verdicts recorded by
// earlier probes (availability views, config-save validation, and the daily
// model-health revalidation). It performs NO network I/O and never waits — the
// session manager calls it while holding its spawn mutex, so a fresh provider
// probe here would serialize every spawn behind a slow provider.
//
// The three-way error contract matches the config-write validator: nil when the
// cached verdict is reachable (or the spawn is unpinned); a
// *ports.ProbeUnavailableError when AO holds no fresh verdict (missing or stale
// cache entry, or an unknown probe result) so the caller can fail open; and a
// definitive error ONLY when the last real probe saw the provider/account
// reject the model. A spawn must block solely on the definitive case.
func (s *Service) ValidateSpawnModel(_ context.Context, harness domain.AgentHarness, model string) error {
	model = strings.TrimSpace(model)
	if model == "" {
		return nil
	}
	v, ok := s.cachedPinVerdict(harness, model)
	if !ok {
		return &ports.ProbeUnavailableError{Reason: fmt.Sprintf("no fresh cached reachability verdict for model %q on agent %q", model, harness)}
	}
	switch v.status {
	case ModelStatusReachable:
		return nil
	case ModelStatusUnreachable:
		reason := v.reason
		if reason == "" {
			reason = "provider rejected the model"
		}
		return fmt.Errorf("model %q is not reachable for agent %q: %s", model, harness, reason)
	default:
		return &ports.ProbeUnavailableError{Reason: fmt.Sprintf("model %q reachability unknown for agent %q", model, harness)}
	}
}

// ModelAvailability returns candidate model lists per harness and classifies
// reachability with the typed model validator when the adapter exposes one.
// Probe infrastructure failures become unknown rows; only provider/account
// rejections are reported as unreachable.
func (s *Service) ModelAvailability(ctx context.Context, req ModelAvailabilityRequest) (ModelAvailabilityResponse, error) {
	if err := ctx.Err(); err != nil {
		return ModelAvailabilityResponse{}, err
	}
	if !req.Force {
		key := modelAvailabilityCacheKey(req.Pins)
		if cached, ok := s.cachedModelAvailability(key); ok {
			return cached, nil
		}
		s.modelRefreshMu.Lock()
		defer s.modelRefreshMu.Unlock()
		if cached, ok := s.cachedModelAvailability(key); ok {
			return cached, nil
		}
		res := s.freshModelAvailability(ctx, req)
		if ctx.Err() == nil {
			s.storeModelAvailability(key, res)
		}
		return res, nil
	}
	return s.freshModelAvailability(ctx, req), nil
}

type modelProbeTarget struct {
	harnessIndex int
	modelIndex   int
	item         agentregistry.HarnessAgent
	model        string
}

func (s *Service) freshModelAvailability(ctx context.Context, req ModelAvailabilityRequest) ModelAvailabilityResponse {
	pins := pinsByHarness(req.Pins)
	pinned := modelPinSet(req.Pins)
	out := make([]HarnessModels, 0, len(s.agents))
	var probes []modelProbeTarget
	for _, item := range s.agents {
		harnessIndex := len(out)
		info := Info{ID: string(item.Harness), Label: item.Manifest.Name}
		if info.Label == "" {
			info.Label = info.ID
		}
		candidates, source := s.modelCandidates(ctx, item, pins[item.Harness])
		models := make([]ModelAvailability, 0, len(candidates))
		for _, model := range candidates {
			_, isPinned := pinned[modelPinKey(item.Harness, model)]
			if isPinned {
				models = append(models, ModelAvailability{Model: strings.TrimSpace(model), Status: ModelStatusUnknown})
				probes = append(probes, modelProbeTarget{harnessIndex: harnessIndex, modelIndex: len(models) - 1, item: item, model: model})
				continue
			}
			models = append(models, modelAvailabilityRow(model))
		}
		out = append(out, HarnessModels{ID: info.ID, Label: info.Label, CatalogSource: source, Models: models})
	}
	s.classifyPinnedModels(ctx, out, probes)
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return ModelAvailabilityResponse{Harnesses: out, CheckedAt: time.Now()}
}

func (s *Service) classifyPinnedModels(ctx context.Context, out []HarnessModels, probes []modelProbeTarget) {
	if len(probes) == 0 {
		return
	}
	const maxConcurrentModelProbes = 4
	sem := make(chan struct{}, maxConcurrentModelProbes)
	var wg sync.WaitGroup
	for _, target := range probes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				out[target.harnessIndex].Models[target.modelIndex] = s.classifyModel(ctx, target.item, target.model)
				return
			}
			out[target.harnessIndex].Models[target.modelIndex] = s.classifyModel(ctx, target.item, target.model)
		}()
	}
	wg.Wait()
}

func (s *Service) cachedModelAvailability(key string) (ModelAvailabilityResponse, bool) {
	s.modelMu.Lock()
	defer s.modelMu.Unlock()
	if s.modelCache.key != key || s.modelCache.checkedAt.IsZero() || time.Since(s.modelCache.checkedAt) >= 5*time.Minute {
		return ModelAvailabilityResponse{}, false
	}
	return cloneModelAvailabilityResponse(s.modelCache.response), true
}

func (s *Service) storeModelAvailability(key string, res ModelAvailabilityResponse) {
	s.modelMu.Lock()
	defer s.modelMu.Unlock()
	s.modelCache = modelAvailabilityCache{key: key, checkedAt: time.Now(), response: cloneModelAvailabilityResponse(res)}
}

func modelPinSet(pins []ModelPin) map[string]struct{} {
	out := map[string]struct{}{}
	for _, pin := range pins {
		model := strings.TrimSpace(pin.Model)
		if pin.Harness == "" || model == "" {
			continue
		}
		out[modelPinKey(pin.Harness, model)] = struct{}{}
	}
	return out
}

func modelPinKey(h domain.AgentHarness, model string) string {
	return string(h) + "\x00" + strings.TrimSpace(model)
}

func modelAvailabilityCacheKey(pins []ModelPin) string {
	keys := make([]string, 0, len(pins))
	for _, pin := range pins {
		model := strings.TrimSpace(pin.Model)
		if pin.Harness == "" || model == "" {
			continue
		}
		keys = append(keys, modelPinKey(pin.Harness, model))
	}
	sort.Strings(keys)
	return strings.Join(keys, "\x01")
}

func pinsByHarness(pins []ModelPin) map[domain.AgentHarness][]string {
	out := map[domain.AgentHarness][]string{}
	for _, pin := range pins {
		model := strings.TrimSpace(pin.Model)
		if pin.Harness == "" || model == "" {
			continue
		}
		out[pin.Harness] = append(out[pin.Harness], model)
	}
	return out
}

func (s *Service) modelCandidates(ctx context.Context, item agentregistry.HarnessAgent, pins []string) ([]string, ModelCatalogSource) {
	var candidates []string
	source := ModelCatalogKnownSet
	if catalog, ok := item.Agent.(ports.AgentModelCatalog); ok {
		if models, err := catalog.AvailableModels(ctx); err == nil && len(models) > 0 {
			candidates = append(candidates, models...)
			source = ModelCatalogAdapter
		}
	}
	if len(candidates) == 0 {
		candidates = append(candidates, knownModelsForHarness(item.Harness)...)
	}
	if len(candidates) == 0 && len(pins) > 0 {
		source = ModelCatalogPins
	}
	candidates = append(candidates, pins...)
	return dedupeStrings(candidates), source
}

func (s *Service) classifyModel(ctx context.Context, item agentregistry.HarnessAgent, model string) ModelAvailability {
	model = strings.TrimSpace(model)
	row := ModelAvailability{Model: model, Status: ModelStatusUnknown}
	if model == "" {
		return row
	}
	validator, ok := item.Agent.(ports.AgentModelValidator)
	if !ok {
		row.Reason = "harness has no model reachability probe"
		s.recordPinVerdict(item.Harness, model, pinVerdict{status: row.Status, reason: row.Reason})
		return row
	}
	if err := ctx.Err(); err != nil {
		// A dead request context is not a provider verdict; do not record it over
		// a previously recorded real verdict.
		row.Reason = "model probe context already done: " + err.Error()
		return row
	}
	probeCtx, cancel := context.WithTimeout(ctx, agentModelProbeTimeout)
	err := validator.ValidateModel(probeCtx, model)
	cancel()
	if err == nil {
		row.Status = ModelStatusReachable
		s.recordPinVerdict(item.Harness, model, pinVerdict{status: row.Status})
		return row
	}
	row.Reason = err.Error()
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		row.Status = ModelStatusUnknown
	} else if ports.ProbeUnavailable(err) {
		row.Status = ModelStatusUnknown
	} else {
		row.Status = ModelStatusUnreachable
	}
	s.recordPinVerdict(item.Harness, model, pinVerdict{status: row.Status, reason: row.Reason})
	return row
}

func modelAvailabilityRow(model string) ModelAvailability {
	row := ModelAvailability{Model: strings.TrimSpace(model), Status: ModelStatusUnknown}
	if row.Model == "" {
		return row
	}
	row.Reason = "not probed; only configured pins are live-validated"
	return row
}

func cloneModelAvailabilityResponse(in ModelAvailabilityResponse) ModelAvailabilityResponse {
	out := ModelAvailabilityResponse{CheckedAt: in.CheckedAt}
	out.Harnesses = make([]HarnessModels, len(in.Harnesses))
	for i, h := range in.Harnesses {
		out.Harnesses[i] = h
		out.Harnesses[i].Models = append([]ModelAvailability(nil), h.Models...)
	}
	return out
}

func knownModelsForHarness(h domain.AgentHarness) []string {
	switch h {
	case domain.HarnessClaudeCode:
		return []string{domain.DefaultClaudeCodeModel, "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-fable-5"}
	case domain.HarnessCodex:
		return []string{"gpt-5.5-codex", "gpt-5-codex", "gpt-5.4-codex"}
	case domain.HarnessCodexFugu:
		return []string{"fugu-ultra"}
	default:
		return nil
	}
}

func dedupeStrings(in []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(in))
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	sort.Strings(out)
	return out
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
