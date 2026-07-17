package pr

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type actionStore struct {
	sessions map[domain.SessionID]domain.SessionRecord
	projects map[string]domain.ProjectRecord
	prs      map[string]domain.PullRequest
	threads  map[string][]domain.PullRequestReviewThread
}

func (s *actionStore) GetSession(_ context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	record, ok := s.sessions[id]
	return record, ok, nil
}

func (s *actionStore) GetProject(_ context.Context, id string) (domain.ProjectRecord, bool, error) {
	record, ok := s.projects[id]
	return record, ok, nil
}

func (s *actionStore) GetPR(_ context.Context, url string) (domain.PullRequest, bool, error) {
	record, ok := s.prs[url]
	return record, ok, nil
}

func (s *actionStore) ListPRReviewThreads(_ context.Context, url string) ([]domain.PullRequestReviewThread, error) {
	return append([]domain.PullRequestReviewThread(nil), s.threads[url]...), nil
}

type actionResolver struct {
	projects []domain.ProjectRecord
	writer   ports.SCMActionWriter
	repo     ports.SCMRepo
	err      error
}

func (r *actionResolver) ResolveProjectActions(_ context.Context, project domain.ProjectRecord) (ResolvedProjectActions, error) {
	r.projects = append(r.projects, project)
	return ResolvedProjectActions{Writer: r.writer, Repository: r.repo}, r.err
}

type actionWriter struct {
	mergeRef     ports.SCMPRRef
	mergeHeadSHA string
	mergeErr     error
	resolvedRefs []ports.SCMPRRef
	resolvedIDs  []string
	resolveErr   error
	repliedIDs   []string
	replyBodies  []string
	replyErr     error
	operations   []string
}

func (w *actionWriter) SquashMerge(_ context.Context, ref ports.SCMPRRef, expectedHeadSHA string) error {
	w.mergeRef = ref
	w.mergeHeadSHA = expectedHeadSHA
	return w.mergeErr
}

func (w *actionWriter) ResolveReviewThread(_ context.Context, ref ports.SCMPRRef, threadID string) error {
	w.resolvedRefs = append(w.resolvedRefs, ref)
	w.resolvedIDs = append(w.resolvedIDs, threadID)
	w.operations = append(w.operations, "resolve:"+threadID)
	return w.resolveErr
}

func (w *actionWriter) ReplyReviewThread(_ context.Context, _ ports.SCMPRRef, threadID, body string) error {
	w.repliedIDs = append(w.repliedIDs, threadID)
	w.replyBodies = append(w.replyBodies, body)
	w.operations = append(w.operations, "reply:"+threadID)
	return w.replyErr
}

func actionFixture(t *testing.T) (*ActionService, *actionStore, *actionResolver, *actionWriter, MergeInput) {
	t.Helper()
	project := domain.ProjectRecord{
		ID: "project-1",
		Config: domain.ProjectConfig{SCM: domain.SCMProjectConfig{
			Provider: domain.SCMProviderGitLab, ConnectionID: "gitlab-main", Repo: "group/repo",
		}},
	}
	session := domain.SessionRecord{ID: "session-1", ProjectID: domain.ProjectID(project.ID)}
	prURL := "https://gitlab.example.com/group/repo/-/merge_requests/42"
	pull := domain.PullRequest{
		URL: prURL, SessionID: session.ID, Number: 42, Provider: "gitlab", Host: "gitlab.example.com",
		Repo: "group/repo", HeadSHA: "head-42", CI: domain.CIPassing, Review: domain.ReviewNone,
		Mergeability: domain.MergeMergeable,
	}
	store := &actionStore{
		sessions: map[domain.SessionID]domain.SessionRecord{session.ID: session},
		projects: map[string]domain.ProjectRecord{project.ID: project},
		prs:      map[string]domain.PullRequest{prURL: pull},
		threads: map[string][]domain.PullRequestReviewThread{prURL: {
			{ThreadID: "open-human", Resolved: true, IsBot: false},
			{ThreadID: "resolved-human", Resolved: true, IsBot: false},
			{ThreadID: "open-bot", Resolved: false, IsBot: true},
		}},
	}
	writer := &actionWriter{}
	resolver := &actionResolver{
		writer: writer,
		repo:   ports.SCMRepo{Provider: "gitlab", Host: "gitlab.example.com", Owner: "group", Name: "repo", Repo: "group/repo"},
	}
	service := NewActionService(ActionDeps{Store: store, Resolver: resolver})
	return service, store, resolver, writer, MergeInput{SessionID: session.ID, PRURL: prURL, ExpectedHeadSHA: "head-42"}
}

func TestMergeRequiresPassingCIReviewAndNoUnresolvedHumanThread(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*domain.PullRequest, *actionStore)
	}{
		{name: "CI pending", mutate: func(pr *domain.PullRequest, _ *actionStore) { pr.CI = domain.CIPending }},
		{name: "CI unknown", mutate: func(pr *domain.PullRequest, _ *actionStore) { pr.CI = domain.CIUnknown }},
		{name: "review required", mutate: func(pr *domain.PullRequest, _ *actionStore) { pr.Review = domain.ReviewRequired }},
		{name: "changes requested", mutate: func(pr *domain.PullRequest, _ *actionStore) { pr.Review = domain.ReviewChangesRequest }},
		{name: "unresolved human thread", mutate: func(_ *domain.PullRequest, store *actionStore) {
			threads := store.threads["https://gitlab.example.com/group/repo/-/merge_requests/42"]
			threads[0].Resolved = false
			store.threads["https://gitlab.example.com/group/repo/-/merge_requests/42"] = threads
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service, store, resolver, writer, input := actionFixture(t)
			pr := store.prs[input.PRURL]
			tc.mutate(&pr, store)
			store.prs[input.PRURL] = pr

			_, err := service.Merge(context.Background(), "42", input)
			if !errors.Is(err, ErrPRPreconditions) {
				t.Fatalf("error = %v, want preconditions", err)
			}
			if len(resolver.projects) != 0 || writer.mergeRef.Number != 0 {
				t.Fatalf("provider called for unmet preconditions: projects=%d ref=%#v", len(resolver.projects), writer.mergeRef)
			}
		})
	}
}

func TestMergeRejectsPRFromDifferentCurrentProjectRepository(t *testing.T) {
	service, _, resolver, writer, input := actionFixture(t)
	resolver.repo = ports.SCMRepo{
		Provider: "gitlab", Host: "gitlab.example.com", Owner: "group", Name: "other", Repo: "group/other",
	}

	_, err := service.Merge(context.Background(), "42", input)
	if !errors.Is(err, ErrPRNotFound) {
		t.Fatalf("error = %v, want not found", err)
	}
	if writer.mergeRef.Number != 0 {
		t.Fatalf("writer called with %#v", writer.mergeRef)
	}
}

func TestMergeRoutesPersistedPRThroughItsProjectWriter(t *testing.T) {
	service, _, resolver, writer, input := actionFixture(t)

	result, err := service.Merge(context.Background(), "42", input)
	if err != nil {
		t.Fatal(err)
	}
	if result != (MergeResult{PRNumber: 42, Method: "squash"}) {
		t.Fatalf("result = %#v", result)
	}
	wantRef := ports.SCMPRRef{
		Repo:   ports.SCMRepo{Provider: "gitlab", Host: "gitlab.example.com", Owner: "group", Name: "repo", Repo: "group/repo"},
		Number: 42, URL: input.PRURL,
	}
	if writer.mergeRef != wantRef || writer.mergeHeadSHA != "head-42" {
		t.Fatalf("merge = (%#v, %q), want (%#v, head-42)", writer.mergeRef, writer.mergeHeadSHA, wantRef)
	}
	if len(resolver.projects) != 1 || resolver.projects[0].ID != "project-1" {
		t.Fatalf("resolved projects = %#v", resolver.projects)
	}
}

func TestMergeRejectsMismatchedIdentityAndStaleHead(t *testing.T) {
	for _, tc := range []struct {
		name   string
		prID   string
		mutate func(*MergeInput)
	}{
		{name: "bad number", prID: "not-a-number"},
		{name: "wrong number", prID: "41"},
		{name: "wrong session", prID: "42", mutate: func(in *MergeInput) { in.SessionID = "session-2" }},
		{name: "wrong url", prID: "42", mutate: func(in *MergeInput) { in.PRURL += "/other" }},
		{name: "stale head", prID: "42", mutate: func(in *MergeInput) { in.ExpectedHeadSHA = "old-head" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service, _, resolver, writer, input := actionFixture(t)
			if tc.mutate != nil {
				tc.mutate(&input)
			}
			_, err := service.Merge(context.Background(), tc.prID, input)
			want := ErrPRNotFound
			if tc.name == "stale head" {
				want = ErrPRPreconditions
			}
			if !errors.Is(err, want) {
				t.Fatalf("error = %v, want %v", err, want)
			}
			if len(resolver.projects) != 0 || writer.mergeRef.Number != 0 {
				t.Fatalf("provider called for rejected identity: projects=%d merge=%#v", len(resolver.projects), writer.mergeRef)
			}
		})
	}
}

func TestResolveCommentsDefaultsToUnresolvedHumanThreads(t *testing.T) {
	service, store, _, writer, mergeInput := actionFixture(t)
	threads := store.threads[mergeInput.PRURL]
	threads[0].Resolved = false
	store.threads[mergeInput.PRURL] = threads
	result, err := service.ResolveComments(context.Background(), "42", ResolveCommentsInput{
		SessionID: mergeInput.SessionID,
		PRURL:     mergeInput.PRURL,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Resolved != 1 || !reflect.DeepEqual(writer.resolvedIDs, []string{"open-human"}) {
		t.Fatalf("result/ids = %#v / %v", result, writer.resolvedIDs)
	}
}

func TestResolveCommentsRejectsThreadOutsidePersistedPR(t *testing.T) {
	service, _, resolver, writer, mergeInput := actionFixture(t)
	_, err := service.ResolveComments(context.Background(), "42", ResolveCommentsInput{
		SessionID:  mergeInput.SessionID,
		PRURL:      mergeInput.PRURL,
		CommentIDs: []string{"different-pr-thread"},
	})
	if !errors.Is(err, ErrPRNotFound) {
		t.Fatalf("error = %v, want ErrPRNotFound", err)
	}
	if len(resolver.projects) != 0 || len(writer.resolvedIDs) != 0 {
		t.Fatalf("provider called for foreign thread: projects=%d ids=%v", len(resolver.projects), writer.resolvedIDs)
	}
}

func TestResolveCommentsRepliesBeforeResolvingSelectedThread(t *testing.T) {
	service, store, _, writer, mergeInput := actionFixture(t)
	threads := store.threads[mergeInput.PRURL]
	threads[0].Resolved = false
	store.threads[mergeInput.PRURL] = threads

	result, err := service.ResolveComments(context.Background(), "42", ResolveCommentsInput{
		SessionID: mergeInput.SessionID,
		PRURL:     mergeInput.PRURL,
		Replies: []ReviewThreadReply{{
			ThreadID: "open-human",
			Body:     "Fixed in head-43.",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Resolved != 1 || !reflect.DeepEqual(writer.operations, []string{"reply:open-human", "resolve:open-human"}) {
		t.Fatalf("result/operations = %#v / %v", result, writer.operations)
	}
	if !reflect.DeepEqual(writer.replyBodies, []string{"Fixed in head-43."}) {
		t.Fatalf("reply bodies = %v", writer.replyBodies)
	}
}

func TestResolveCommentsDoesNotResolveWhenReplyFails(t *testing.T) {
	service, store, _, writer, mergeInput := actionFixture(t)
	threads := store.threads[mergeInput.PRURL]
	threads[0].Resolved = false
	store.threads[mergeInput.PRURL] = threads
	writer.replyErr = ports.ErrSCMActionForbidden

	result, err := service.ResolveComments(context.Background(), "42", ResolveCommentsInput{
		SessionID: mergeInput.SessionID,
		PRURL:     mergeInput.PRURL,
		Replies:   []ReviewThreadReply{{ThreadID: "open-human", Body: "Fixed."}},
	})
	if !errors.Is(err, ErrPRForbidden) || result.Resolved != 0 || len(writer.resolvedIDs) != 0 {
		t.Fatalf("result/error/resolved = %#v / %v / %v", result, err, writer.resolvedIDs)
	}
}

func TestResolveCommentsRejectsInvalidReplyBeforeProviderLookup(t *testing.T) {
	for _, tc := range []struct {
		name    string
		replies []ReviewThreadReply
		want    error
	}{
		{name: "foreign thread", replies: []ReviewThreadReply{{ThreadID: "different-pr-thread", Body: "Fixed."}}, want: ErrPRNotFound},
		{name: "empty body", replies: []ReviewThreadReply{{ThreadID: "open-human", Body: "  "}}, want: ErrInvalidPRAction},
		{name: "duplicate thread", replies: []ReviewThreadReply{
			{ThreadID: "open-human", Body: "First."},
			{ThreadID: "open-human", Body: "Second."},
		}, want: ErrInvalidPRAction},
	} {
		t.Run(tc.name, func(t *testing.T) {
			service, store, resolver, writer, mergeInput := actionFixture(t)
			threads := store.threads[mergeInput.PRURL]
			threads[0].Resolved = false
			store.threads[mergeInput.PRURL] = threads

			_, err := service.ResolveComments(context.Background(), "42", ResolveCommentsInput{
				SessionID: mergeInput.SessionID,
				PRURL:     mergeInput.PRURL,
				Replies:   tc.replies,
			})
			if !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
			if len(resolver.projects) != 0 || len(writer.repliedIDs) != 0 || len(writer.resolvedIDs) != 0 {
				t.Fatalf("provider called for invalid replies %#v", tc.replies)
			}
		})
	}
}

func TestProviderActionErrorsAreMapped(t *testing.T) {
	for _, tc := range []struct {
		provider error
		want     error
	}{
		{provider: ports.ErrSCMNotFound, want: ErrPRNotFound},
		{provider: ports.ErrSCMActionForbidden, want: ErrPRForbidden},
		{provider: ports.ErrSCMActionPrecondition, want: ErrPRPreconditions},
	} {
		service, _, _, writer, input := actionFixture(t)
		writer.mergeErr = tc.provider
		_, err := service.Merge(context.Background(), "42", input)
		if !errors.Is(err, tc.want) {
			t.Fatalf("provider %v mapped to %v, want %v", tc.provider, err, tc.want)
		}
	}
}
