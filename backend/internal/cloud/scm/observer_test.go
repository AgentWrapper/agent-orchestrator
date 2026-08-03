package scm

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	cloudlocalgh "github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm/localgh"
)

func TestObservationSignatureExcludesAllObservedAtTimestamps(t *testing.T) {
	first := cloudlocalgh.PullRequestObservation{
		Repository: "aoagents/agent-orchestrator",
		Number:     42,
		State:      "open",
		ObservedAt: time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC),
		Checks: []cloudlocalgh.CheckObservation{{
			Name:       "test",
			Status:     "completed",
			Conclusion: "success",
			ObservedAt: time.Date(2026, 8, 3, 12, 1, 0, 0, time.UTC),
		}},
		ReviewThreads: []cloudlocalgh.ReviewThreadObservation{{
			ID:         "thread-one",
			IsResolved: false,
			ObservedAt: time.Date(2026, 8, 3, 12, 2, 0, 0, time.UTC),
		}},
	}
	second := first
	second.ObservedAt = first.ObservedAt.Add(time.Hour)
	second.Checks = append([]cloudlocalgh.CheckObservation(nil), first.Checks...)
	second.Checks[0].ObservedAt = first.Checks[0].ObservedAt.Add(time.Hour)
	second.ReviewThreads = append([]cloudlocalgh.ReviewThreadObservation(nil), first.ReviewThreads...)
	second.ReviewThreads[0].ObservedAt = first.ReviewThreads[0].ObservedAt.Add(time.Hour)

	if observationSignature(first) != observationSignature(second) {
		t.Fatal("observer timestamp-only changes produced a new dedupe signature")
	}
	second.CIState = "failing"
	if observationSignature(first) == observationSignature(second) {
		t.Fatal("observer state change was incorrectly deduplicated")
	}
}

type observerTargetStore struct {
	targets []cloudpostgres.SCMTarget
}

func (s *observerTargetStore) ListSCMTargets(context.Context) ([]cloudpostgres.SCMTarget, error) {
	return s.targets, nil
}

func (*observerTargetStore) WriteSCMObservation(
	context.Context,
	clouddomain.AccountID,
	clouddomain.SessionID,
	cloudlocalgh.PullRequestObservation,
) error {
	return nil
}

type observerRoundTripFunc func(*http.Request) (*http.Response, error)

func (f observerRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestGitHubAppObserverSkipsUnlinkedAndRevokedTargets(t *testing.T) {
	repositoryID := int64(991)
	store := &observerTargetStore{targets: []cloudpostgres.SCMTarget{
		{
			AccountID:          clouddomain.AccountID("org-one"),
			OrgID:              clouddomain.OrgID("org-one"),
			SessionID:          clouddomain.SessionID("unlinked"),
			RepositoryURL:      "https://github.com/aoagents/agent-orchestrator",
			Branch:             "ao/unlinked",
			GitHubGrantActive:  false,
			GitHubRepositoryID: nil,
		},
		{
			AccountID:          clouddomain.AccountID("org-one"),
			OrgID:              clouddomain.OrgID("org-one"),
			SessionID:          clouddomain.SessionID("revoked"),
			RepositoryURL:      "https://github.com/aoagents/agent-orchestrator",
			Branch:             "ao/revoked",
			GitHubGrantActive:  false,
			GitHubRepositoryID: &repositoryID,
		},
	}}
	requests := 0
	client := cloudlocalgh.NewWithTokenSource(
		cloudlocalgh.StaticTokenSource("should-not-be-used"),
		&http.Client{Transport: observerRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			requests++
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`[]`)),
				Request:    request,
			}, nil
		})},
	)
	observer := New(store, client, nil, time.Minute, nil, WithGitHubAppMode())
	observer.observe(context.Background())
	if requests != 0 {
		t.Fatalf("GitHub requests = %d, want zero for unlinked/revoked targets", requests)
	}
}

func TestRefreshRepositoryObservesOnlyMatchingActiveTargets(t *testing.T) {
	t.Parallel()
	repositoryID := int64(991)
	otherRepositoryID := int64(992)
	store := &observerTargetStore{targets: []cloudpostgres.SCMTarget{
		{
			AccountID:          "org-one",
			OrgID:              "org-one",
			SessionID:          "matching",
			RepositoryURL:      "https://github.com/aoagents/agent-orchestrator",
			Branch:             "ao/matching",
			GitHubGrantActive:  true,
			GitHubRepositoryID: &repositoryID,
		},
		{
			AccountID:          "org-one",
			OrgID:              "org-one",
			SessionID:          "other-repository",
			RepositoryURL:      "https://github.com/aoagents/other",
			Branch:             "ao/other",
			GitHubGrantActive:  true,
			GitHubRepositoryID: &otherRepositoryID,
		},
		{
			AccountID:          "org-two",
			OrgID:              "org-two",
			SessionID:          "other-org",
			RepositoryURL:      "https://github.com/aoagents/agent-orchestrator",
			Branch:             "ao/other-org",
			GitHubGrantActive:  true,
			GitHubRepositoryID: &repositoryID,
		},
		{
			AccountID:          "org-one",
			OrgID:              "org-one",
			SessionID:          "revoked",
			RepositoryURL:      "https://github.com/aoagents/agent-orchestrator",
			Branch:             "ao/revoked",
			GitHubGrantActive:  false,
			GitHubRepositoryID: &repositoryID,
		},
	}}
	requests := 0
	client := cloudlocalgh.NewWithTokenSource(
		cloudlocalgh.StaticTokenSource("scoped-test-token"),
		&http.Client{Transport: observerRoundTripFunc(func(request *http.Request) (*http.Response, error) {
			requests++
			if got := request.URL.Query().Get("head"); got != "aoagents:ao/matching" {
				t.Fatalf("observed branch scope = %q", got)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`[]`)),
				Request:    request,
			}, nil
		})},
	)
	observer := New(store, client, nil, time.Minute, nil, WithGitHubAppMode())

	if err := observer.RefreshRepository(context.Background(), "org-one", repositoryID); err != nil {
		t.Fatalf("RefreshRepository() error = %v", err)
	}
	if requests != 1 {
		t.Fatalf("GitHub requests = %d, want one matching active target", requests)
	}
}
