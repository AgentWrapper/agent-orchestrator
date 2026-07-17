package pr

import "errors"

// Sentinel errors returned by the PR action service.
var (
	ErrPRNotFound       = errors.New("pr: not found")
	ErrPRNotMergeable   = errors.New("pr: not mergeable")
	ErrPRPreconditions  = errors.New("pr: merge preconditions unmet")
	ErrPRForbidden      = errors.New("pr: action forbidden")
	ErrInvalidPRAction  = errors.New("pr: invalid action")
	ErrNothingToResolve = errors.New("pr: nothing to resolve")
)
