package ports

import (
	"context"
	"errors"
)

// ErrSCMNotMergeable reports the provider refused a merge because the PR is
// not currently mergeable (conflicts, method disabled, already merged, etc.).
var ErrSCMNotMergeable = errors.New("scm: pr not mergeable")

// ErrSCMUnprocessable reports the provider rejected a PR action for a
// precondition that is not a simple "not mergeable" state (e.g. required
// checks pending, SHA mismatch, invalid thread id).
var ErrSCMUnprocessable = errors.New("scm: pr action unprocessable")

// ErrSCMAuthFailed reports the provider rejected credentials or permissions.
var ErrSCMAuthFailed = errors.New("scm: authentication failed")

// PRMergeResult is the provider outcome of a successful squash (or other) merge.
type PRMergeResult struct {
	// Merged is true when the provider reports the PR is merged.
	Merged bool
	// SHA is the merge commit SHA when the provider returns one.
	SHA string
	// Method is the merge method that was applied (e.g. "squash").
	Method string
}

// PRActioner performs mutating SCM operations on pull requests. It is
// intentionally separate from observation ports so the action service can
// depend only on write-capable providers without dragging in the poller surface.
type PRActioner interface {
	// MergePR squash-merges (or merges with the given method) the pull request
	// identified by ref. method is typically "squash".
	MergePR(ctx context.Context, ref SCMPRRef, method string) (PRMergeResult, error)
	// ListUnresolvedThreadIDs returns GraphQL node IDs of unresolved review
	// threads on the PR. An empty slice means nothing to resolve.
	ListUnresolvedThreadIDs(ctx context.Context, ref SCMPRRef) ([]string, error)
	// ResolveThread marks one review thread resolved on the provider.
	ResolveThread(ctx context.Context, threadID string) error
}