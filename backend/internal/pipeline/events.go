package pipeline

import "time"

// Event and Effect are the input/output of the pipeline reducer (a later
// task). They are never parsed from YAML/JSON config; they are constructed
// in-process by the engine driver. The reducer is pure: every Event carries
// a driver-stamped Now, and the reducer must not read the clock itself.
//
// Both are sealed interfaces (an unexported marker method) so the union of
// concrete types is closed to this package; callers switch over Type().
//
// Ported from the old TypeScript events.ts, excluding USER_FOLLOWUP and
// FOLLOWUP_REPLY (conversational follow-up), which are phase 2.

// EventType names a concrete Event's kind for switch dispatch.
type EventType string

// Known event types.
const (
	EventTriggerFired          EventType = "TRIGGER_FIRED"
	EventStageStarted          EventType = "STAGE_STARTED"
	EventStageCompleted        EventType = "STAGE_COMPLETED"
	EventStageFailed           EventType = "STAGE_FAILED"
	EventNewSHADetected        EventType = "NEW_SHA_DETECTED"
	EventRunCancelled          EventType = "RUN_CANCELLED"
	EventRunResumed            EventType = "RUN_RESUMED"
	EventConfigChanged         EventType = "CONFIG_CHANGED"
	EventArtifactStatusChanged EventType = "ARTIFACT_STATUS_CHANGED"
	EventTick                  EventType = "TICK"
)

// Event is any driver-constructed input to the reducer.
type Event interface {
	// Type reports the event's concrete kind.
	Type() EventType
	// isPipelineEvent seals the interface to this package.
	isPipelineEvent()
}

// TriggerFired starts a new pipeline run: a trigger event fired for a
// session at a given head SHA. The driver allocates RunID and one
// StageRunID per stage up front so the reducer never needs to generate IDs.
type TriggerFired struct {
	Now time.Time

	Trigger   StageTriggerEvent
	SessionID string
	Pipeline  Pipeline
	HeadSHA   string

	// Context carries PR identity, issue id, and session facts for the run.
	// PR fields are empty for manual triggers with no PR.
	Context RunContext

	RunID       RunID
	StageRunIDs map[string]StageRunID
}

// Type implements Event.
func (TriggerFired) Type() EventType  { return EventTriggerFired }
func (TriggerFired) isPipelineEvent() {}

// StageStarted reports that a stage's executor has begun running.
type StageStarted struct {
	Now time.Time

	RunID     RunID
	StageName string
}

// Type implements Event.
func (StageStarted) Type() EventType  { return EventStageStarted }
func (StageStarted) isPipelineEvent() {}

// StageCompleted reports that a stage's executor finished, carrying its
// verdict (zero value means no verdict reported) and any artifacts it
// produced.
type StageCompleted struct {
	Now time.Time

	RunID     RunID
	StageName string
	Verdict   Verdict
	Artifacts []ArtifactInput
	// StatusChanges are {kind:"status"} records the stage emitted to flip existing
	// findings' status by fingerprint. The reducer applies them (to run.Findings
	// and the store) after materializing this stage's own artifacts and before the
	// exit decision, so a last-stage resolve/reopen changes whether the run is done.
	StatusChanges []FindingStatusChange
	// Output is a capped tail of the stage's combined stdout+stderr, persisted
	// onto the stage state for the run detail.
	Output string
	// SessionID is the AO session the stage ran in (agent stages only), persisted
	// onto the stage state so the run detail can link to it.
	SessionID string
	// Notes are human-relevant one-line annotations (fork skip, findings
	// truncated, exit-mode fallback) the driver collected from the outcome's
	// observations, persisted onto the stage state.
	Notes []string
}

// Type implements Event.
func (StageCompleted) Type() EventType  { return EventStageCompleted }
func (StageCompleted) isPipelineEvent() {}

// StageFailed reports that a stage's executor errored out.
type StageFailed struct {
	Now time.Time

	RunID        RunID
	StageName    string
	ErrorMessage string
	// Output is a capped tail of the stage's combined stdout+stderr, persisted
	// onto the stage state for the run detail.
	Output string
	// SessionID is the AO session the stage ran in (agent stages only), persisted
	// onto the stage state so the run detail can link to it even on failure.
	SessionID string
	// Notes are human-relevant one-line annotations the driver collected from the
	// outcome's observations, persisted onto the stage state.
	Notes []string
}

// Type implements Event.
func (StageFailed) Type() EventType  { return EventStageFailed }
func (StageFailed) isPipelineEvent() {}

// NewSHADetected reports that the driver observed a new head SHA for a
// session's pipeline loop, which (re)triggers the loop.
type NewSHADetected struct {
	Now time.Time

	SessionID    string
	PipelineName string
	SHA          string
	// PRURL scopes the SHA change to a single PR's run so a sibling PR's run on
	// the same session+pipeline is never terminated as outdated. Empty for a
	// non-PR loop (degrades to the session+pipeline key).
	PRURL string
}

// Type implements Event.
func (NewSHADetected) Type() EventType  { return EventNewSHADetected }
func (NewSHADetected) isPipelineEvent() {}

// RunCancelled cancels an in-flight run for the given reason.
type RunCancelled struct {
	Now time.Time

	RunID  RunID
	Reason RunTerminationReason
}

// Type implements Event.
func (RunCancelled) Type() EventType  { return EventRunCancelled }
func (RunCancelled) isPipelineEvent() {}

// RunResumed re-arms a run's failed stages with freshly driver-allocated
// StageRunIDs so the new attempt has non-colliding identity.
type RunResumed struct {
	Now time.Time

	RunID       RunID
	StageRunIDs map[string]StageRunID
}

// Type implements Event.
func (RunResumed) Type() EventType  { return EventRunResumed }
func (RunResumed) isPipelineEvent() {}

// ConfigChanged reports that a session's pipeline definition changed while
// a run was in flight; the reducer terminates the affected run.
type ConfigChanged struct {
	Now time.Time

	SessionID    string
	PipelineName string
}

// Type implements Event.
func (ConfigChanged) Type() EventType  { return EventConfigChanged }
func (ConfigChanged) isPipelineEvent() {}

// ArtifactStatusChanged reports a user/agent action changing one artifact's
// status (e.g. dismissing a finding).
type ArtifactStatusChanged struct {
	Now time.Time

	RunID      RunID
	StageRunID StageRunID
	ArtifactID ArtifactID
	Status     ArtifactStatus
	// Actor is an optional human label (e.g. reviewer id) for audit
	// observation.
	Actor string
}

// Type implements Event.
func (ArtifactStatusChanged) Type() EventType  { return EventArtifactStatusChanged }
func (ArtifactStatusChanged) isPipelineEvent() {}

// Tick is a driver heartbeat with no payload beyond the stamped clock,
// letting the reducer re-evaluate time-based conditions (timeouts, stall
// windows) without a state-changing input.
type Tick struct {
	Now time.Time
}

// Type implements Event.
func (Tick) Type() EventType  { return EventTick }
func (Tick) isPipelineEvent() {}

// EffectType names a concrete Effect's kind for switch dispatch.
type EffectType string

// Known effect types.
const (
	EffectStartStage           EffectType = "START_STAGE"
	EffectCancelStage          EffectType = "CANCEL_STAGE"
	EffectPersistRun           EffectType = "PERSIST_RUN"
	EffectPersistLoopState     EffectType = "PERSIST_LOOP_STATE"
	EffectAppendArtifacts      EffectType = "APPEND_ARTIFACTS"
	EffectUpdateArtifactStatus EffectType = "UPDATE_ARTIFACT_STATUS"
	EffectEmitObservation      EffectType = "EMIT_OBSERVATION"
)

// Effect is any command the reducer emits for the engine driver to execute
// after a reduce() call. Ported from the old TypeScript events.ts, excluding
// APPEND_THREAD_MESSAGE and SEND_FOLLOWUP (conversational follow-up), which
// are phase 2.
type Effect interface {
	// Type reports the effect's concrete kind.
	Type() EffectType
	// isPipelineEffect seals the interface to this package.
	isPipelineEffect()
}

// StartStage instructs the driver to spawn stage's executor.
type StartStage struct {
	RunID      RunID
	StageRunID StageRunID
	Stage      Stage
}

// Type implements Effect.
func (StartStage) Type() EffectType  { return EffectStartStage }
func (StartStage) isPipelineEffect() {}

// CancelStage instructs the driver to tear down a running stage's executor.
type CancelStage struct {
	RunID      RunID
	StageRunID StageRunID
	StageName  string
}

// Type implements Effect.
func (CancelStage) Type() EffectType  { return EffectCancelStage }
func (CancelStage) isPipelineEffect() {}

// PersistRun instructs the driver to durably write the given RunState.
type PersistRun struct {
	RunState RunState
}

// Type implements Effect.
func (PersistRun) Type() EffectType  { return EffectPersistRun }
func (PersistRun) isPipelineEffect() {}

// PersistLoopState instructs the driver to durably write the given
// LoopState.
type PersistLoopState struct {
	RunID     RunID
	LoopState LoopState
}

// Type implements Effect.
func (PersistLoopState) Type() EffectType  { return EffectPersistLoopState }
func (PersistLoopState) isPipelineEffect() {}

// AppendArtifacts instructs the driver to durably append the given
// artifacts to the run/stage-run's artifact log.
type AppendArtifacts struct {
	RunID      RunID
	StageRunID StageRunID
	Artifacts  []Artifact
}

// Type implements Effect.
func (AppendArtifacts) Type() EffectType  { return EffectAppendArtifacts }
func (AppendArtifacts) isPipelineEffect() {}

// UpdateArtifactStatus instructs the driver to durably update one
// artifact's status.
type UpdateArtifactStatus struct {
	RunID      RunID
	StageRunID StageRunID
	ArtifactID ArtifactID
	Status     ArtifactStatus
}

// Type implements Effect.
func (UpdateArtifactStatus) Type() EffectType  { return EffectUpdateArtifactStatus }
func (UpdateArtifactStatus) isPipelineEffect() {}

// EmitObservation instructs the driver to emit a named observation/telemetry
// event with free-form data.
type EmitObservation struct {
	Name string
	Data map[string]any
}

// Type implements Effect.
func (EmitObservation) Type() EffectType  { return EffectEmitObservation }
func (EmitObservation) isPipelineEffect() {}
