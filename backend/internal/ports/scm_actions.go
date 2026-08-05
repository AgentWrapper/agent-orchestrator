package ports

import (
	"context"
	"errors"
)

// ErrSCMHeadChanged indicates that the pull request advanced beyond the head
// SHA supplied with the mutation.
var ErrSCMHeadChanged = errors.New("scm: pull request head changed")

// ErrSCMNotMergeable indicates that the provider rejected the pull request's
// current mergeability state.
var ErrSCMNotMergeable = errors.New("scm: pull request not mergeable")

// SCMMergeMethod identifies the provider merge strategy.
type SCMMergeMethod string

// SCMMergeSquash requests a squash merge from the provider.
const SCMMergeSquash SCMMergeMethod = "squash"

// SCMMergeRequest uses ExpectedHeadSHA as a compare-and-swap guard. Provider
// implementations must reject the mutation if the live head has advanced.
type SCMMergeRequest struct {
	PR              SCMPRRef
	ExpectedHeadSHA string
	Method          SCMMergeMethod
}

// SCMMergeResult reports the provider's resulting merge commit.
type SCMMergeResult struct {
	MergeCommitSHA string
}

// SCMMerger mutates pull requests through an SCM provider.
type SCMMerger interface {
	MergePullRequest(ctx context.Context, request SCMMergeRequest) (SCMMergeResult, error)
}
