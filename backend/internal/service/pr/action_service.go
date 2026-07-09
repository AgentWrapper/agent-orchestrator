package pr

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// ActionManager is the controller-facing contract for /prs/{id} action routes.
type ActionManager interface {
	Merge(ctx context.Context, prID string) (MergeResult, error)
	Close(ctx context.Context, prID string) (CloseResult, error)
	ResolveComments(ctx context.Context, prID string, commentIDs []string) (ResolveResult, error)
}

// Lookup resolves the API's PR-number path parameter to stored PR facts.
type Lookup interface {
	GetPRByNumber(ctx context.Context, number int) (domain.PullRequest, bool, error)
}

// ActionDeps holds ActionService dependencies.
type ActionDeps struct {
	Lookup Lookup
	SCM    ports.SCMPRActions
}

// MergeResult is the successful outcome of a PR merge.
type MergeResult struct {
	PRNumber int
	Method   string // always "squash"
}

// CloseResult is the successful outcome of closing a PR.
type CloseResult struct {
	PRNumber int
}

// ResolveResult is the successful outcome of a resolve-comments operation.
type ResolveResult struct {
	Resolved int
}

// ActionService implements ActionManager.
type ActionService struct {
	lookup Lookup
	scm    ports.SCMPRActions
}

var _ ActionManager = (*ActionService)(nil)

// NewActionService returns an ActionService over stored PR facts and SCM actions.
func NewActionService(deps ActionDeps) *ActionService {
	return &ActionService{lookup: deps.Lookup, scm: deps.SCM}
}

// Merge squash-merges the PR identified by prID.
func (s *ActionService) Merge(ctx context.Context, prID string) (MergeResult, error) {
	target, err := s.resolveActionTarget(ctx, prID)
	if err != nil {
		return MergeResult{}, err
	}
	const method = "squash"
	if err := s.scm.MergePR(ctx, target.owner, target.repo, target.number, method); err != nil {
		return MergeResult{}, err
	}
	return MergeResult{PRNumber: target.number, Method: method}, nil
}

// Close closes the PR identified by prID without merging it.
func (s *ActionService) Close(ctx context.Context, prID string) (CloseResult, error) {
	target, err := s.resolveActionTarget(ctx, prID)
	if err != nil {
		return CloseResult{}, err
	}
	if err := s.scm.ClosePR(ctx, target.owner, target.repo, target.number); err != nil {
		return CloseResult{}, err
	}
	return CloseResult{PRNumber: target.number}, nil
}

// ResolveComments resolves review threads on the PR identified by prID.
// TODO: implement — resolve review threads via the SCM provider.
func (s *ActionService) ResolveComments(_ context.Context, _ string, _ []string) (ResolveResult, error) {
	return ResolveResult{Resolved: 0}, nil
}

type actionTarget struct {
	owner  string
	repo   string
	number int
}

func (s *ActionService) resolveActionTarget(ctx context.Context, prID string) (actionTarget, error) {
	if s == nil || s.lookup == nil || s.scm == nil {
		return actionTarget{}, fmt.Errorf("pr: action service not configured")
	}
	n, err := parsePRID(prID)
	if err != nil {
		return actionTarget{}, err
	}
	pr, ok, err := s.lookup.GetPRByNumber(ctx, n)
	if err != nil {
		return actionTarget{}, fmt.Errorf("lookup pr %d: %w", n, err)
	}
	if !ok {
		return actionTarget{}, ErrPRNotFound
	}
	owner, repo, err := ownerRepoForAction(pr)
	if err != nil {
		return actionTarget{}, err
	}
	number := pr.Number
	if number <= 0 {
		number = n
	}
	return actionTarget{owner: owner, repo: repo, number: number}, nil
}

func parsePRID(prID string) (int, error) {
	n, err := strconv.Atoi(strings.TrimSpace(prID))
	if err != nil || n <= 0 {
		return 0, ErrPRNotFound
	}
	return n, nil
}

func ownerRepoForAction(pr domain.PullRequest) (string, string, error) {
	if owner, repo, ok := splitRepo(pr.Repo); ok {
		return owner, repo, nil
	}
	owner, repo, _, err := parseGitHubPRURL(pr.URL)
	if err != nil {
		return "", "", fmt.Errorf("%w: stored PR %q has no GitHub repo", ErrPRNotFound, pr.URL)
	}
	return owner, repo, nil
}

func splitRepo(full string) (string, string, bool) {
	parts := strings.Split(strings.Trim(strings.TrimSpace(full), "/"), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], strings.TrimSuffix(parts[1], ".git"), true
}

func parseGitHubPRURL(raw string) (string, string, int, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", "", 0, err
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) >= 4 && (parts[2] == "pull" || parts[2] == "pulls") {
		n, err := strconv.Atoi(parts[3])
		if err != nil || n <= 0 {
			return "", "", 0, ErrPRNotFound
		}
		return parts[0], strings.TrimSuffix(parts[1], ".git"), n, nil
	}
	if len(parts) >= 5 && parts[0] == "repos" && parts[3] == "pulls" {
		n, err := strconv.Atoi(parts[4])
		if err != nil || n <= 0 {
			return "", "", 0, ErrPRNotFound
		}
		return parts[1], strings.TrimSuffix(parts[2], ".git"), n, nil
	}
	return "", "", 0, ErrPRNotFound
}
