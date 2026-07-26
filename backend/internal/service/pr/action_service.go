package pr

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	scmgithub "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/github"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ActionManager is the controller-facing contract for /prs/{id} action routes.
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

// PRStore is the storage dependency ActionService needs to resolve a PR
// before acting on it.
type PRStore interface {
	GetPR(ctx context.Context, url string) (domain.PullRequest, bool, error)
}

// SCMMerger is the SCM-provider dependency that performs the real merge.
type SCMMerger interface {
	MergePR(ctx context.Context, owner, repo string, number int, method string) (string, error)
}

// ActionService implements ActionManager.
type ActionService struct {
	store PRStore
	scm   SCMMerger // may be nil if the daemon started without SCM credentials
}

var _ ActionManager = (*ActionService)(nil)

// NewActionService wires the real store/SCM dependencies. scm may be nil
// (e.g. no GitHub token at startup); Merge reports ErrSCMUnavailable in that
// case rather than panicking.
func NewActionService(store PRStore, scm SCMMerger) *ActionService {
	return &ActionService{store: store, scm: scm}
}

// Merge merges the PR identified by id, a base64url-encoded PR URL. Encoding
// is required because PR URLs contain slashes and cannot be used as a raw
// chi path segment.
func (s *ActionService) Merge(ctx context.Context, id string) (MergeResult, error) {
	if s.scm == nil {
		return MergeResult{}, fmt.Errorf("%w: SCM provider unavailable", ErrPRPreconditions)
	}
	url, err := decodePRID(id)
	if err != nil {
		return MergeResult{}, fmt.Errorf("%w: %v", ErrPRNotFound, err)
	}
	pr, ok, err := s.store.GetPR(ctx, url)
	if err != nil {
		return MergeResult{}, err
	}
	if !ok {
		return MergeResult{}, ErrPRNotFound
	}
	if pr.Merged || pr.Closed {
		return MergeResult{}, ErrPRPreconditions
	}
	if pr.Mergeability != domain.MergeMergeable {
		return MergeResult{}, ErrPRNotMergeable
	}
	owner, repo, ok := strings.Cut(pr.Repo, "/")
	if !ok {
		return MergeResult{}, fmt.Errorf("%w: malformed repo %q", ErrPRPreconditions, pr.Repo)
	}
	const method = "squash" // TODO(#3064 follow-up): accept caller-specified method once frontend exposes a picker
	if _, err := s.scm.MergePR(ctx, owner, repo, pr.Number, method); err != nil {
		switch {
		case errors.Is(err, scmgithub.ErrProviderPRNotMergeable):
			return MergeResult{}, ErrPRNotMergeable
		case errors.Is(err, scmgithub.ErrProviderPRPreconditions):
			return MergeResult{}, ErrPRPreconditions
		default:
			return MergeResult{}, err
		}
	}
	return MergeResult{PRNumber: pr.Number, Method: method}, nil
}

// ResolveComments resolves review threads on the PR identified by prID.
// TODO: implement — resolve review threads via the SCM provider.
func (s *ActionService) ResolveComments(_ context.Context, _ string, _ []string) (ResolveResult, error) {
	return ResolveResult{Resolved: 0}, nil
}

func decodePRID(id string) (string, error) {
	b, err := base64.RawURLEncoding.DecodeString(id)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
