package domain

import (
	"fmt"
	"strings"
)

// WorkerMixEntry is one bucket in a project's weighted worker mix: an agent
// harness, an optional model for that harness, and a percentage weight. It reads
// "spawn this fraction of the project's workers on this agent/model." One row in
// the Settings mix table maps to exactly one entry.
type WorkerMixEntry struct {
	// Harness is the agent CLI the bucket's workers launch.
	Harness AgentHarness `json:"agent"`
	// Model pins the model for the bucket. Empty means the harness's own default
	// model (resolved through AgentConfig at spawn). A non-empty model must belong
	// to the harness's provider — a cross-provider model is rejected by Validate.
	Model string `json:"model,omitempty"`
	// Weight is the bucket's percentage share of worker spawns (1..100). Weights
	// across the mix must sum to 100.
	Weight int `json:"weight"`
}

// key identifies a bucket for running-count matching: harness + model, the two
// axes a worker spawn is distributed over. The model is trimmed so the bucket
// identity matches the model recorded on a spawned session (Spawn trims the
// per-session model before persisting it) — otherwise a whitespace-padded config
// model would count against a different key than it selects on, over-serving that
// bucket. Validate already rejects such padding; this trim is defense-in-depth
// for any path that reaches Select without going through Validate.
func (e WorkerMixEntry) key() BucketKey {
	return BucketKey{Harness: e.Harness, Model: strings.TrimSpace(e.Model)}
}

// BucketKey returns the normalized identity of this mix bucket for consumers
// outside the domain package that need to correlate selection with runtime
// health.
func (e WorkerMixEntry) BucketKey() BucketKey {
	return e.key()
}

// BucketKey identifies one agent/model bucket. It keys the running-session
// counts the deficit selector consumes.
type BucketKey struct {
	Harness AgentHarness
	Model   string
}

// WorkerMix is a project's weighted worker mix: worker spawns are distributed
// across the listed agent/model buckets by weight. When non-empty it drives
// worker spawns that pass no explicit --agent (deficit-based, see Select); empty
// means the single Worker.Harness behavior is used unchanged (back-compat).
type WorkerMix []WorkerMixEntry

var issueRoutingLabelHarnesses = map[string]AgentHarness{
	"agent:codex":      HarnessCodex,
	"agent:fugu":       HarnessCodexFugu,
	"agent:codex-fugu": HarnessCodexFugu,
	"agent:claude":     HarnessClaudeCode,
}

// Validate rejects a mix that could not be honored deterministically: an unknown
// harness, a cross-provider model, an out-of-range weight, a duplicate bucket, or
// weights that do not sum to 100. An empty mix is valid — the feature is off and
// spawns fall back to the single worker role harness.
//
// Fable is intentionally NOT rejected here. A user may explicitly weight fable
// into the mix; the no-default-fable rule (GH #61) constrains only what the
// system picks on its OWN. The mix never inserts a bucket the user did not
// configure, so an explicit fable weight is allowed while nothing auto-selects it.
func (mix WorkerMix) Validate() error {
	if len(mix) == 0 {
		return nil
	}
	seen := make(map[BucketKey]struct{}, len(mix))
	sum := 0
	for i, e := range mix {
		if !e.Harness.IsKnown() {
			return fmt.Errorf("workerMix[%d].agent: unknown harness %q", i, e.Harness)
		}
		if e.Weight < 1 || e.Weight > 100 {
			return fmt.Errorf("workerMix[%d].weight: %d out of range (want 1..100)", i, e.Weight)
		}
		if e.Model != strings.TrimSpace(e.Model) {
			return fmt.Errorf("workerMix[%d].model: must not have leading or trailing whitespace", i)
		}
		if e.Model != "" {
			if hp := e.Harness.ModelProvider(); !ClassifyModelProvider(e.Model).CompatibleWith(hp) {
				return fmt.Errorf("workerMix[%d].model: %q is not a %s model", i, e.Model, hp)
			}
		}
		k := e.key()
		if _, dup := seen[k]; dup {
			return fmt.Errorf("workerMix[%d]: duplicate bucket agent=%q model=%q", i, e.Harness, e.Model)
		}
		seen[k] = struct{}{}
		sum += e.Weight
	}
	if sum != 100 {
		return fmt.Errorf("workerMix weights sum to %d, want 100", sum)
	}
	return nil
}

// Select picks the bucket the next worker spawn should use to keep the running
// distribution closest to the configured weights. It is the highest-averages
// (D'Hondt) apportionment step: choose the bucket maximizing weight/(count+1),
// where count is the number of running workers already in that bucket. Because
// an under-served bucket has the smaller denominator, this is deficit-based —
// even a small fleet converges on the target ratio rather than drifting the way
// per-spawn random draws would. It is fully deterministic: the comparison is
// integer cross-multiplication (no float rounding) and ties break toward the
// earlier mix row. running is keyed by bucket; a bucket absent from the map
// counts as 0. Returns false only for an empty mix.
func (mix WorkerMix) Select(running map[BucketKey]int) (WorkerMixEntry, bool) {
	best := -1
	var bestWeight, bestDen int
	for i, e := range mix {
		den := running[e.key()] + 1
		// weight/den > bestWeight/bestDen, cross-multiplied to stay integer-exact.
		// Strict ">" keeps the earliest row on a tie, so selection is deterministic.
		if best == -1 || e.Weight*bestDen > bestWeight*den {
			best, bestWeight, bestDen = i, e.Weight, den
		}
	}
	if best == -1 {
		return WorkerMixEntry{}, false
	}
	return mix[best], true
}

// RoutingHarnessForIssueLabels maps ao's per-ticket routing labels onto the
// explicit harness intake must pass to Spawn. Unknown agent:* labels are ignored
// rather than treated as errors so future labels can exist before this daemon
// understands them. Whitespace-padded labels are ignored; tracker adapters
// should preserve provider label names exactly.
func RoutingHarnessForIssueLabels(labels []string) (AgentHarness, bool) {
	for _, label := range labels {
		if label != strings.TrimSpace(label) {
			continue
		}
		if h, ok := issueRoutingLabelHarnesses[strings.ToLower(label)]; ok {
			return h, true
		}
	}
	return "", false
}
