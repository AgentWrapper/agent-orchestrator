// Package pipeline holds the domain vocabulary for the pipelines feature. The
// v1 semantics layer (predicates, loops, findings) has been stripped ahead of
// the v2 rebuild; what remains is the typed ids, the cycle detector, the
// embedded JSON schema, and the store envelope types.
package pipeline

// These ID types are distinct string types, mirroring the domain package's
// convention, so they can't be swapped at a call site by accident.
type (
	// ID identifies a pipeline definition.
	ID string
	// RunID identifies one execution of a pipeline.
	RunID string
)
