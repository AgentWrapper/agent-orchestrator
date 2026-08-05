package ports

import (
	"context"
	"errors"
)

var (
	ErrSCMHeadChanged  = errors.New("scm: pull request head changed")
	ErrSCMNotMergeable = errors.New("scm: pull request not mergeable")
)

type SCMMergeMethod string

const SCMMergeSquash SCMMergeMethod = "squash"

// SCMMergeRequest uses ExpectedHeadSHA as a compare-and-swap guard. Provider
// implementations must reject the mutation if the live head has advanced.
type SCMMergeRequest struct {
	PR              SCMPRRef
	ExpectedHeadSHA string
	Method          SCMMergeMethod
}

type SCMMergeResult struct {
	MergeCommitSHA string
}

type SCMMerger interface {
	MergePullRequest(ctx context.Context, request SCMMergeRequest) (SCMMergeResult, error)
}
