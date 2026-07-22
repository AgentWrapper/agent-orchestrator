package executors

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// ArtifactStore fetches persisted upstream artifacts for a run. Injected so the
// builtin executor never reads SQLite directly (that seam is the store task's
// concern); the engine's adapter maps it onto the real store.
type ArtifactStore interface {
	// UpstreamArtifacts returns the artifacts each named upstream stage produced
	// in the run, keyed by stage name. Stages with no artifacts may be omitted.
	UpstreamArtifacts(ctx context.Context, runID pipeline.RunID, stageNames []string) (map[string][]pipeline.Artifact, error)
}

// SessionMessenger is the router's delivery seam: probe a session before
// delivering, then send it a message. Mirrors SessionManager.Send/liveness but
// stays a narrow, mockable interface.
type SessionMessenger interface {
	Alive(ctx context.Context, sessionID string) (bool, error)
	Send(ctx context.Context, sessionID, message string) error
}

// builtinHandle is the running-stage token for a builtin stage. Builtins run
// synchronously in-process, so the outcome is computed in Start and latched
// here; Poll returns it immediately.
type builtinHandle struct {
	stageIdentity
	final Outcome
}

// BuiltinExecutor runs the engine-internal builtins (router, compose). It
// fetches upstream artifacts through the injected store, dispatches to the
// named builtin, and returns the resulting artifacts. It never spawns a session
// or shells out.
type BuiltinExecutor struct {
	store     ArtifactStore
	messenger SessionMessenger
}

// NewBuiltinExecutor builds a builtin executor over the store + messenger seams.
func NewBuiltinExecutor(store ArtifactStore, messenger SessionMessenger) *BuiltinExecutor {
	return &BuiltinExecutor{store: store, messenger: messenger}
}

var _ StageExecutor = (*BuiltinExecutor)(nil)

// Start fetches the stage's upstream artifacts and dispatches the builtin. The
// work is synchronous; Poll returns the latched outcome.
func (e *BuiltinExecutor) Start(ctx context.Context, in StartInput) (Handle, error) {
	if in.Stage.Executor.Kind != pipeline.ExecutorBuiltin {
		return nil, fmt.Errorf("builtin executor cannot start stage %q with executor.kind=%s", in.Stage.Name, in.Stage.Executor.Kind)
	}
	id := stageIdentity{runID: in.RunID, stageRunID: in.StageRunID, stageName: in.Stage.Name}

	// Fork-PR gate via the shared helper: the router delivers findings into a
	// live worker session, so a builtin stage is fork-sensitive like a command
	// stage. Resolved from the run context's tri-state (a manual/no-PR run
	// resolves to ForkNo and flows normally).
	fork, prNumber := forkFromContext(in.Context)
	if skip, gated := forkGateDecision(fork, prNumber, in.Stage.Name, in.AllowForkPRs); gated {
		return &builtinHandle{stageIdentity: id, final: skip}, nil
	}

	inputs, err := e.store.UpstreamArtifacts(ctx, in.RunID, in.Stage.DependsOn)
	if err != nil {
		return &builtinHandle{stageIdentity: id, final: Outcome{
			Status:       OutcomeFailed,
			ErrorMessage: fmt.Sprintf("builtin stage %q: fetch upstream artifacts: %v", in.Stage.Name, err),
		}}, nil
	}

	out := e.dispatch(ctx, in, inputs)
	return &builtinHandle{stageIdentity: id, final: out}, nil
}

// Poll returns the builtin's latched outcome.
func (e *BuiltinExecutor) Poll(_ context.Context, h Handle) (Outcome, error) {
	handle, ok := h.(*builtinHandle)
	if !ok {
		return Outcome{}, fmt.Errorf("builtin executor: unexpected handle type %T", h)
	}
	return handle.final, nil
}

// Cancel is a no-op: builtins finish synchronously in Start with nothing to
// tear down.
func (e *BuiltinExecutor) Cancel(_ context.Context, h Handle) error {
	if _, ok := h.(*builtinHandle); !ok {
		return fmt.Errorf("builtin executor: unexpected handle type %T", h)
	}
	return nil
}

// dispatch routes to the named builtin. An unknown name is a config bug that
// validation should have caught; surface it as a failed outcome rather than a
// panic.
func (e *BuiltinExecutor) dispatch(ctx context.Context, in StartInput, inputs map[string][]pipeline.Artifact) Outcome {
	switch in.Stage.Executor.Name {
	case pipeline.BuiltinRouter:
		return e.runRouter(ctx, in, inputs)
	case pipeline.BuiltinCompose:
		return runCompose(inputs)
	default:
		return Outcome{
			Status:       OutcomeFailed,
			ErrorMessage: fmt.Sprintf("unknown builtin executor name %q", in.Stage.Executor.Name),
		}
	}
}

// runRouter delivers each upstream stage's artifacts to the linked worker
// session as one message per stage. A single pre-send liveness probe gates all
// deliveries: a dead worker yields a skipped_worker_dead observation + a
// delivery_failed json artifact per stage, leaving the findings for the next
// tick. Per-send errors are captured the same way without aborting the rest.
func (e *BuiltinExecutor) runRouter(ctx context.Context, in StartInput, inputs map[string][]pipeline.Artifact) Outcome {
	target := in.RoutingTargetSessionID
	if target == "" {
		target = in.LinkedSessionID
	}

	artifacts := make([]pipeline.ArtifactInput, 0, len(inputs))
	var observations []Observation

	// Single liveness probe — every input stage shares the same target, so one
	// probe avoids hammering the runtime when there are many findings.
	alive, err := e.messenger.Alive(ctx, target)
	if err != nil {
		// Treat a probe error as "not alive": we cannot confirm the worker can
		// receive, so skip delivery and leave findings open for the next tick.
		alive = false
	}

	for _, fromStage := range sortedStageNames(inputs) {
		stageArtifacts := inputs[fromStage]
		if len(stageArtifacts) == 0 {
			continue
		}

		if !alive {
			observations = append(observations, Observation{
				Name: "pipeline.send.skipped_worker_dead",
				Data: routerObsData(in, fromStage, target, len(stageArtifacts)),
			})
			artifacts = append(artifacts, pipeline.ArtifactInput{
				Kind: pipeline.ArtifactKindJSON,
				Data: map[string]any{
					"result":          "delivery_failed",
					"reason":          "worker_dead",
					"fromStage":       fromStage,
					"targetSessionId": target,
					"artifactCount":   len(stageArtifacts),
				},
			})
			continue
		}

		message := composeRouterMessage(fromStage, stageArtifacts)
		if err := e.messenger.Send(ctx, target, message); err != nil {
			observations = append(observations, Observation{
				Name: "pipeline.send.failed",
				Data: mergeMap(routerObsData(in, fromStage, target, len(stageArtifacts)), map[string]any{"error": err.Error()}),
			})
			artifacts = append(artifacts, pipeline.ArtifactInput{
				Kind: pipeline.ArtifactKindJSON,
				Data: map[string]any{
					"result":          "delivery_failed",
					"reason":          "send_error",
					"fromStage":       fromStage,
					"targetSessionId": target,
					"error":           err.Error(),
				},
			})
			continue
		}

		artifacts = append(artifacts, pipeline.ArtifactInput{
			Kind: pipeline.ArtifactKindJSON,
			Data: map[string]any{
				"result":          "delivered",
				"fromStage":       fromStage,
				"targetSessionId": target,
				"artifactCount":   len(stageArtifacts),
			},
		})
	}

	return Outcome{Status: OutcomeCompleted, Verdict: pipeline.VerdictNeutral, Artifacts: artifacts, Observations: observations}
}

// runCompose merges upstream artifacts into a single JSON artifact so a
// downstream stage can consume one structured input instead of N per-stage
// blobs.
func runCompose(inputs map[string][]pipeline.Artifact) Outcome {
	stages := map[string]any{}
	totalArtifacts := 0
	composedFrom := sortedStageNames(inputs)
	for _, name := range composedFrom {
		arts := inputs[name]
		stages[name] = arts
		totalArtifacts += len(arts)
	}

	artifact := pipeline.ArtifactInput{
		Kind: pipeline.ArtifactKindJSON,
		Data: map[string]any{
			"composedFrom":   composedFrom,
			"totalArtifacts": totalArtifacts,
			"stages":         stages,
		},
	}
	return Outcome{Status: OutcomeCompleted, Verdict: pipeline.VerdictNeutral, Artifacts: []pipeline.ArtifactInput{artifact}}
}

// composeRouterMessage renders one upstream stage's artifacts as a human/agent
// readable delivery message.
func composeRouterMessage(stageName string, artifacts []pipeline.Artifact) string {
	lines := make([]string, 0, len(artifacts)*2+2)
	lines = append(lines, fmt.Sprintf("Findings from upstream pipeline stage %q:", stageName), "")
	for _, a := range artifacts {
		if a.Kind == pipeline.ArtifactKindFinding {
			lines = append(lines,
				fmt.Sprintf("- [%s] %s:%d-%d - %s", a.Severity, a.FilePath, a.StartLine, a.EndLine, a.Title),
				"  "+a.Description)
		} else {
			lines = append(lines, "- "+marshalCompact(a.Data))
		}
	}
	return strings.Join(lines, "\n")
}

// sortedStageNames returns the input stage names in a stable order so router
// deliveries and compose output are deterministic (map iteration is random).
func sortedStageNames(inputs map[string][]pipeline.Artifact) []string {
	names := make([]string, 0, len(inputs))
	for name := range inputs {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func routerObsData(in StartInput, fromStage, target string, count int) map[string]any {
	return map[string]any{
		"runId":           string(in.RunID),
		"stageRunId":      string(in.StageRunID),
		"stageName":       in.Stage.Name,
		"fromStage":       fromStage,
		"targetSessionId": target,
		"artifactCount":   count,
	}
}

func mergeMap(base, extra map[string]any) map[string]any {
	for k, v := range extra {
		base[k] = v
	}
	return base
}

// marshalCompact renders a JSON artifact's data on one line for the router
// message. A marshal failure (free-form data) degrades to an empty object
// rather than aborting delivery.
func marshalCompact(data map[string]any) string {
	b, err := json.Marshal(data)
	if err != nil {
		return "{}"
	}
	return string(b)
}
