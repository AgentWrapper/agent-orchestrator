package pr

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// MergeInput identifies the persisted PR and the exact head the user authorized.
type MergeInput struct {
	SessionID       domain.SessionID
	PRURL           string
	ExpectedHeadSHA string
}

// ResolveCommentsInput identifies the persisted PR and optional thread IDs.
type ResolveCommentsInput struct {
	SessionID  domain.SessionID
	PRURL      string
	CommentIDs []string
	Replies    []ReviewThreadReply
}

// ReviewThreadReply is a reply that must be posted before its thread is resolved.
type ReviewThreadReply struct {
	ThreadID string
	Body     string
}

// ActionManager is the controller-facing contract for /prs/{id} action routes.
type ActionManager interface {
	Merge(ctx context.Context, prID string, input MergeInput) (MergeResult, error)
	ResolveComments(ctx context.Context, prID string, input ResolveCommentsInput) (ResolveResult, error)
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

// ActionStore is the persisted identity boundary for explicit SCM mutations.
type ActionStore interface {
	GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error)
	GetProject(ctx context.Context, id string) (domain.ProjectRecord, bool, error)
	GetPR(ctx context.Context, url string) (domain.PullRequest, bool, error)
	ListPRReviewThreads(ctx context.Context, prURL string) ([]domain.PullRequestReviewThread, error)
}

// ProjectActionResolver resolves the writer selected by one persisted project.
type ProjectActionResolver interface {
	ResolveProjectActions(ctx context.Context, project domain.ProjectRecord) (ResolvedProjectActions, error)
}

// ResolvedProjectActions binds a writer to the repository selected by the current project config.
type ResolvedProjectActions struct {
	Writer     ports.SCMActionWriter
	Repository ports.SCMRepo
}

// ActionDeps supplies the durable store and project-scoped provider resolver.
type ActionDeps struct {
	Store    ActionStore
	Resolver ProjectActionResolver
}

// ActionService routes explicit mutations through the persisted PR's project connection.
type ActionService struct {
	store    ActionStore
	resolver ProjectActionResolver
}

var _ ActionManager = (*ActionService)(nil)

// NewActionService constructs the production PR action service.
func NewActionService(deps ActionDeps) *ActionService {
	return &ActionService{store: deps.Store, resolver: deps.Resolver}
}

// Merge squash-merges the exact persisted head authorized by the caller.
func (s *ActionService) Merge(ctx context.Context, prID string, input MergeInput) (MergeResult, error) {
	pr, project, err := s.load(ctx, prID, input.SessionID, input.PRURL)
	if err != nil {
		return MergeResult{}, err
	}
	if strings.TrimSpace(input.ExpectedHeadSHA) == "" || input.ExpectedHeadSHA != pr.HeadSHA {
		return MergeResult{}, ErrPRPreconditions
	}
	if pr.Merged || pr.Closed || pr.Mergeability == domain.MergeConflicting {
		return MergeResult{}, ErrPRNotMergeable
	}
	if pr.Draft || pr.Mergeability != domain.MergeMergeable {
		return MergeResult{}, ErrPRPreconditions
	}
	if pr.CI != domain.CIPassing || (pr.Review != domain.ReviewNone && pr.Review != domain.ReviewApproved) {
		return MergeResult{}, ErrPRPreconditions
	}
	threads, err := s.store.ListPRReviewThreads(ctx, pr.URL)
	if err != nil {
		return MergeResult{}, err
	}
	if hasUnresolvedHumanThread(threads) {
		return MergeResult{}, ErrPRPreconditions
	}
	actions, err := s.actionsForProject(ctx, project)
	if err != nil {
		return MergeResult{}, err
	}
	ref := actionRef(pr)
	if !sameActionRepository(ref.Repo, actions.Repository) {
		return MergeResult{}, ErrPRNotFound
	}
	if err := actions.Writer.SquashMerge(ctx, ref, input.ExpectedHeadSHA); err != nil {
		return MergeResult{}, mapActionError(err)
	}
	return MergeResult{PRNumber: pr.Number, Method: "squash"}, nil
}

// ResolveComments resolves selected threads, or every unresolved human thread when none are supplied.
func (s *ActionService) ResolveComments(ctx context.Context, prID string, input ResolveCommentsInput) (ResolveResult, error) {
	pr, project, err := s.load(ctx, prID, input.SessionID, input.PRURL)
	if err != nil {
		return ResolveResult{}, err
	}
	threads, err := s.store.ListPRReviewThreads(ctx, pr.URL)
	if err != nil {
		return ResolveResult{}, err
	}
	eligible := make(map[string]struct{}, len(threads))
	ordered := make([]string, 0, len(threads))
	for _, thread := range threads {
		id := strings.TrimSpace(thread.ThreadID)
		if id == "" || thread.Resolved || thread.IsBot {
			continue
		}
		if _, seen := eligible[id]; seen {
			continue
		}
		eligible[id] = struct{}{}
		ordered = append(ordered, id)
	}
	selected := ordered
	replies := make(map[string]string, len(input.Replies))
	if len(input.CommentIDs) > 0 || len(input.Replies) > 0 {
		selected = make([]string, 0, len(input.CommentIDs)+len(input.Replies))
		seen := map[string]bool{}
		addSelected := func(id string) error {
			if _, ok := eligible[id]; !ok {
				return ErrPRNotFound
			}
			if !seen[id] {
				selected = append(selected, id)
				seen[id] = true
			}
			return nil
		}
		for _, raw := range input.CommentIDs {
			id := strings.TrimSpace(raw)
			if err := addSelected(id); err != nil {
				return ResolveResult{}, err
			}
		}
		for _, reply := range input.Replies {
			id := strings.TrimSpace(reply.ThreadID)
			body := strings.TrimSpace(reply.Body)
			if id == "" || body == "" {
				return ResolveResult{}, ErrInvalidPRAction
			}
			if _, duplicate := replies[id]; duplicate {
				return ResolveResult{}, ErrInvalidPRAction
			}
			if err := addSelected(id); err != nil {
				return ResolveResult{}, err
			}
			replies[id] = body
		}
	}
	if len(selected) == 0 {
		return ResolveResult{}, ErrNothingToResolve
	}
	actions, err := s.actionsForProject(ctx, project)
	if err != nil {
		return ResolveResult{}, err
	}
	resolved := 0
	ref := actionRef(pr)
	if !sameActionRepository(ref.Repo, actions.Repository) {
		return ResolveResult{}, ErrPRNotFound
	}
	for _, threadID := range selected {
		if body, ok := replies[threadID]; ok {
			if err := actions.Writer.ReplyReviewThread(ctx, ref, threadID, body); err != nil {
				return ResolveResult{Resolved: resolved}, mapActionError(err)
			}
		}
		if err := actions.Writer.ResolveReviewThread(ctx, ref, threadID); err != nil {
			return ResolveResult{Resolved: resolved}, mapActionError(err)
		}
		resolved++
	}
	return ResolveResult{Resolved: resolved}, nil
}

func (s *ActionService) actionsForProject(ctx context.Context, project domain.ProjectRecord) (ResolvedProjectActions, error) {
	if s.resolver == nil {
		return ResolvedProjectActions{}, errors.New("pr: action resolver unavailable")
	}
	actions, err := s.resolver.ResolveProjectActions(ctx, project)
	if err != nil {
		return ResolvedProjectActions{}, fmt.Errorf("resolve project SCM actions: %w", err)
	}
	if actions.Writer == nil || strings.TrimSpace(actions.Repository.Provider) == "" ||
		strings.TrimSpace(actions.Repository.Host) == "" || strings.TrimSpace(actions.Repository.Repo) == "" {
		return ResolvedProjectActions{}, errors.New("pr: action writer unavailable")
	}
	return actions, nil
}

func (s *ActionService) load(ctx context.Context, prID string, sessionID domain.SessionID, prURL string) (domain.PullRequest, domain.ProjectRecord, error) {
	number, err := strconv.Atoi(strings.TrimSpace(prID))
	if err != nil || number <= 0 || sessionID == "" || strings.TrimSpace(prURL) == "" || s.store == nil {
		return domain.PullRequest{}, domain.ProjectRecord{}, ErrPRNotFound
	}
	session, ok, err := s.store.GetSession(ctx, sessionID)
	if err != nil {
		return domain.PullRequest{}, domain.ProjectRecord{}, err
	}
	if !ok {
		return domain.PullRequest{}, domain.ProjectRecord{}, ErrPRNotFound
	}
	pr, ok, err := s.store.GetPR(ctx, prURL)
	if err != nil {
		return domain.PullRequest{}, domain.ProjectRecord{}, err
	}
	if !ok || pr.SessionID != session.ID || pr.Number != number || pr.URL != prURL {
		return domain.PullRequest{}, domain.ProjectRecord{}, ErrPRNotFound
	}
	project, ok, err := s.store.GetProject(ctx, string(session.ProjectID))
	if err != nil {
		return domain.PullRequest{}, domain.ProjectRecord{}, err
	}
	if !ok {
		return domain.PullRequest{}, domain.ProjectRecord{}, ErrPRNotFound
	}
	return pr, project, nil
}

func actionRef(pr domain.PullRequest) ports.SCMPRRef {
	repo := strings.Trim(strings.TrimSuffix(strings.TrimSpace(pr.Repo), ".git"), "/")
	parts := strings.Split(repo, "/")
	name := ""
	owner := ""
	if len(parts) > 0 {
		name = parts[len(parts)-1]
		owner = strings.Join(parts[:len(parts)-1], "/")
	}
	return ports.SCMPRRef{
		Repo:   ports.SCMRepo{Provider: pr.Provider, Host: pr.Host, Owner: owner, Name: name, Repo: repo},
		Number: pr.Number,
		URL:    pr.URL,
	}
}

func hasUnresolvedHumanThread(threads []domain.PullRequestReviewThread) bool {
	for _, thread := range threads {
		if !thread.Resolved && !thread.IsBot {
			return true
		}
	}
	return false
}

func sameActionRepository(left, right ports.SCMRepo) bool {
	return strings.EqualFold(strings.TrimSpace(left.Provider), strings.TrimSpace(right.Provider)) &&
		strings.EqualFold(strings.TrimSpace(left.Host), strings.TrimSpace(right.Host)) &&
		strings.EqualFold(strings.Trim(strings.TrimSuffix(left.Repo, ".git"), "/"), strings.Trim(strings.TrimSuffix(right.Repo, ".git"), "/"))
}

func mapActionError(err error) error {
	switch {
	case errors.Is(err, ports.ErrSCMNotFound):
		return ErrPRNotFound
	case errors.Is(err, ports.ErrSCMActionForbidden):
		return ErrPRForbidden
	case errors.Is(err, ports.ErrSCMActionPrecondition):
		return ErrPRPreconditions
	default:
		return err
	}
}
