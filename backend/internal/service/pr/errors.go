package pr

import "errors"

// Sentinel errors returned by the PR action service.
var (
	ErrPRNotFound       = errors.New("pr: not found")
	ErrPRNotMergeable   = errors.New("pr: not mergeable")
	ErrPRPreconditions  = errors.New("pr: merge preconditions unmet")
	ErrNothingToResolve = errors.New("pr: nothing to resolve")
	ErrMainCIRed        = errors.New("pr: main ci is red")
)
