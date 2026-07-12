// Package agentconfig resolves project agent settings for launches and model
// health projections.
package agentconfig

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// ErrModelHarnessMismatch means an explicit per-spawn model belongs to a
// different provider than the resolved harness.
var ErrModelHarnessMismatch = errors.New("session: model not valid for harness")

// ModelPin is one exact harness/model candidate implied by project config.
type ModelPin struct {
	Scope   string
	Harness domain.AgentHarness
	Model   string
}

// Effective resolves the agent config for a spawn of the given harness.
func Effective(kind domain.SessionKind, cfg domain.ProjectConfig, spawnModel string, harness domain.AgentHarness) (ports.AgentConfig, error) {
	base := cfg.AgentConfig
	override := RoleOverride(kind, cfg).AgentConfig
	hp := harness.ModelProvider()

	resolved := ports.AgentConfig{Permissions: base.Permissions}
	if override.Permissions != "" {
		resolved.Permissions = override.Permissions
	}

	var model string
	var effort domain.Effort

	if m := strings.TrimSpace(base.Model); m != "" && domain.ClassifyModelProvider(m).CompatibleWith(hp) {
		model = m
	}
	if base.Effort != "" {
		effort = base.Effort
	}
	if m := strings.TrimSpace(override.Model); m != "" && domain.ClassifyModelProvider(m).CompatibleWith(hp) {
		model = m
	}
	if override.Effort != "" {
		effort = override.Effort
	}

	applyHarnessModel := func(hm domain.HarnessModel) {
		if m := strings.TrimSpace(hm.Model); m != "" && domain.ClassifyModelProvider(m).CompatibleWith(hp) {
			model = m
		}
		if hm.Effort != "" {
			effort = hm.Effort
		}
	}
	if hm, ok := base.ModelByHarness[harness]; ok {
		applyHarnessModel(hm)
	}
	if hm, ok := override.ModelByHarness[harness]; ok {
		applyHarnessModel(hm)
	}

	if sm := strings.TrimSpace(spawnModel); sm != "" {
		if !domain.ClassifyModelProvider(sm).CompatibleWith(hp) {
			return ports.AgentConfig{}, fmt.Errorf("%w: %q is not a %s model (harness %q)", ErrModelHarnessMismatch, sm, hp, harness)
		}
		model = sm
	}

	if model == "" {
		model = domain.DefaultModelForHarness(harness)
	}

	resolved.Model = model
	resolved.Effort = effort
	return resolved, nil
}

// EffectiveHarness applies role-level harness defaults after explicit selection.
func EffectiveHarness(explicit domain.AgentHarness, kind domain.SessionKind, cfg domain.ProjectConfig) domain.AgentHarness {
	if explicit != "" {
		return explicit
	}
	return RoleOverride(kind, cfg).Harness
}

// RoleOverride returns the project override for a session role.
func RoleOverride(kind domain.SessionKind, cfg domain.ProjectConfig) domain.RoleOverride {
	switch kind {
	case domain.KindOrchestrator:
		return cfg.Orchestrator
	case domain.KindPrime:
		return cfg.Prime
	default:
		return cfg.Worker
	}
}

// ConfiguredModelPins returns exact harness/model candidates implied by the same
// precedence Effective uses for launch.
func ConfiguredModelPins(cfg domain.ProjectConfig) []ModelPin {
	var pins []ModelPin
	addResolved := func(scope string, kind domain.SessionKind, harness domain.AgentHarness, spawnModel string) {
		harness = EffectiveHarness(harness, kind, cfg)
		if harness == "" {
			return
		}
		resolved, err := Effective(kind, cfg, spawnModel, harness)
		if err != nil {
			return
		}
		model := strings.TrimSpace(resolved.Model)
		if model == "" {
			return
		}
		pins = append(pins, ModelPin{Scope: scope, Harness: harness, Model: model})
	}

	addResolved("worker", domain.KindWorker, "", "")
	addResolved("orchestrator", domain.KindOrchestrator, "", "")
	addResolved("prime", domain.KindPrime, "", "")
	for h := range cfg.AgentConfig.ModelByHarness {
		addResolved("agentConfig.modelByHarness["+string(h)+"]", domain.KindWorker, h, "")
	}
	for h := range cfg.Worker.AgentConfig.ModelByHarness {
		addResolved("worker.agentConfig.modelByHarness["+string(h)+"]", domain.KindWorker, h, "")
	}
	for h := range cfg.Orchestrator.AgentConfig.ModelByHarness {
		addResolved("orchestrator.agentConfig.modelByHarness["+string(h)+"]", domain.KindOrchestrator, h, "")
	}
	for h := range cfg.Prime.AgentConfig.ModelByHarness {
		addResolved("prime.agentConfig.modelByHarness["+string(h)+"]", domain.KindPrime, h, "")
	}
	for i, bucket := range cfg.WorkerMix {
		addResolved("workerMix["+strconv.Itoa(i)+"]", domain.KindWorker, bucket.Harness, bucket.Model)
	}
	return dedupeModelPins(pins)
}

func dedupeModelPins(in []ModelPin) []ModelPin {
	seen := map[string]struct{}{}
	out := make([]ModelPin, 0, len(in))
	for _, pin := range in {
		key := string(pin.Harness) + "\x00" + strings.TrimSpace(pin.Model)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, pin)
	}
	return out
}
