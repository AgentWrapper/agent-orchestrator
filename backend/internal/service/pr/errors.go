package pr

import "errors"

// Sentinel errors returned by the PR action service.
var (
	ErrInvalidPR        = errors.New("pr: invalid identity")
	ErrPRNotFound       = errors.New("pr: not found")
	ErrPRNotMergeable   = errors.New("pr: not mergeable")
	ErrPRHeadChanged    = errors.New("pr: head changed")
	ErrPRPreconditions  = errors.New("pr: merge preconditions unmet")
	ErrNothingToResolve = errors.New("pr: nothing to resolve")
)
