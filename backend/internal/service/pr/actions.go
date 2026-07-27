package pr

import "context"

// ActionManager is the controller-facing contract for PR action routes.
// Production currently leaves this dependency nil, so the HTTP surface returns
// NOT_IMPLEMENTED instead of pretending to merge or resolve comments.
type ActionManager interface {
	Merge(ctx context.Context, prID string) (MergeResult, error)
	ResolveComments(ctx context.Context, prID string, commentIDs []string) (ResolveResult, error)
}

// MergeResult is the successful outcome of a PR merge.
type MergeResult struct {
	PRNumber int
	Method   string
}

// ResolveResult is the successful outcome of a resolve-comments operation.
type ResolveResult struct {
	Resolved int
}
