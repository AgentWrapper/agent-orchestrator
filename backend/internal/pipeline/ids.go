// Package pipeline holds the domain vocabulary for the pipelines feature: the
// stage/predicate/event/effect shapes, YAML config parsing and validation,
// and DAG cycle detection. It intentionally contains no reducer, scheduler,
// predicate evaluator, executors, store, engine, HTTP, or CLI code; those
// land in later tasks that build on this contract.
package pipeline

// These ID types are distinct string types, mirroring the domain package's
// convention, so they can't be swapped at a call site by accident.
type (
	// ID identifies a pipeline definition.
	ID string
	// RunID identifies one execution of a pipeline.
	RunID string
	// StageRunID identifies one execution attempt of a stage within a run.
	StageRunID string
	// ArtifactID identifies one artifact (finding or JSON blob) produced by a
	// stage run.
	ArtifactID string
)
