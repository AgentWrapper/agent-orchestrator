package pr

import (
	"context"
)

// ActionManager is the controller-facing contract for /prs/{id} action routes.
type ActionManager interface {
	Merge(ctx context.Context, prID string) (MergeResult, error)
	ResolveComments(ctx context.Context, prID string, commentIDs []string) (ResolveResult, error)
}

// MergeResult is the successful outcome of a PR merge.
type MergeResult struct {
	PRNumber int
	Method   string // always "squash"
}

// ResolveResult is the successful outcome of a resolve-comments operation.
type ResolveResult struct {
	Resolved int
}

// MergeExecutor performs the provider mutation after ActionService preconditions pass.
type MergeExecutor interface {
	MergePR(ctx context.Context, prID string) (MergeResult, error)
}

// ResolveExecutor performs review-thread resolution mutations.
type ResolveExecutor interface {
	ResolveComments(ctx context.Context, prID string, commentIDs []string) (ResolveResult, error)
}

// MainCI states describe the default branch CI state used by the merge-freeze gate.
const (
	MainCISuccess = "success"
	MainCIPending = "pending"
	MainCIFailing = "failing"
	MainCIUnknown = "unknown"
)

// MainCIStatus is the merge-freeze input for the repository default branch.
type MainCIStatus struct {
	State      string
	SHA        string
	FailedJobs []string
	// FixPR means the PR is explicitly labeled/authorized as the red-main fix.
	FixPR bool
}

// MainCIGate reports whether the target PR is exempt from a red-main freeze.
type MainCIGate interface {
	Check(ctx context.Context, prID string) (MainCIStatus, error)
}

// ActionDeps configures ActionService.
type ActionDeps struct {
	MainCI  MainCIGate
	Merge   MergeExecutor
	Resolve ResolveExecutor
}

// ActionService implements ActionManager. Missing mutation executors fail closed.
type ActionService struct {
	mainCI  MainCIGate
	merge   MergeExecutor
	resolve ResolveExecutor
}

var _ ActionManager = (*ActionService)(nil)

// NewActionService returns a stub ActionService.
func NewActionService() *ActionService {
	return NewActionServiceWithDeps(ActionDeps{})
}

// NewActionServiceWithDeps returns an ActionService with testable precondition gates.
//
// Supplying a merge executor without a main-CI gate is an invalid configuration:
// the live merge path must fail closed rather than silently skipping the
// default-branch freeze precondition. Tests for non-merge actions and the
// intentionally inert stub constructor may still omit MainCI.
func NewActionServiceWithDeps(d ActionDeps) *ActionService {
	if d.Merge != nil && d.MainCI == nil {
		panic("pr ActionService merge executor requires MainCI gate")
	}
	return &ActionService{mainCI: d.MainCI, merge: d.Merge, resolve: d.Resolve}
}

// Merge squash-merges the PR identified by prID after enforcing preconditions.
func (s *ActionService) Merge(ctx context.Context, prID string) (MergeResult, error) {
	if s == nil {
		return MergeResult{}, ErrActionUnavailable
	}
	if s.mainCI != nil {
		status, err := s.mainCI.Check(ctx, prID)
		if err != nil {
			return MergeResult{}, err
		}
		if status.State == MainCIFailing && !status.FixPR {
			return MergeResult{}, ErrMainCIRed
		}
		if status.State != MainCISuccess && status.State != MainCIFailing {
			return MergeResult{}, ErrPRPreconditions
		}
	} else if s.merge != nil {
		return MergeResult{}, ErrPRPreconditions
	}
	if s.merge == nil {
		return MergeResult{}, ErrActionUnavailable
	}
	return s.merge.MergePR(ctx, prID)
}

// ResolveComments resolves review threads on the PR identified by prID.
func (s *ActionService) ResolveComments(ctx context.Context, prID string, commentIDs []string) (ResolveResult, error) {
	if s == nil || s.resolve == nil {
		return ResolveResult{}, ErrActionUnavailable
	}
	return s.resolve.ResolveComments(ctx, prID, commentIDs)
}
