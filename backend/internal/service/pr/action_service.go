package pr

import (
	"context"
	"strconv"
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
	MainCI MainCIGate
}

// ActionService implements ActionManager. Business logic is not yet implemented.
type ActionService struct {
	mainCI MainCIGate
}

var _ ActionManager = (*ActionService)(nil)

// NewActionService returns a stub ActionService.
func NewActionService() *ActionService {
	return NewActionServiceWithDeps(ActionDeps{})
}

// NewActionServiceWithDeps returns an ActionService with testable precondition gates.
func NewActionServiceWithDeps(d ActionDeps) *ActionService {
	return &ActionService{mainCI: d.MainCI}
}

// Merge squash-merges the PR identified by prID.
// TODO: implement — squash-merge the PR via the SCM provider.
func (s *ActionService) Merge(ctx context.Context, prID string) (MergeResult, error) {
	if s != nil && s.mainCI != nil {
		status, err := s.mainCI.Check(ctx, prID)
		if err != nil {
			return MergeResult{}, err
		}
		if status.State == MainCIFailing && !status.FixPR {
			return MergeResult{}, ErrMainCIRed
		}
	}
	n, _ := strconv.Atoi(prID)
	return MergeResult{PRNumber: n, Method: "squash"}, nil
}

// ResolveComments resolves review threads on the PR identified by prID.
// TODO: implement — resolve review threads via the SCM provider.
func (s *ActionService) ResolveComments(_ context.Context, _ string, _ []string) (ResolveResult, error) {
	return ResolveResult{Resolved: 0}, nil
}
