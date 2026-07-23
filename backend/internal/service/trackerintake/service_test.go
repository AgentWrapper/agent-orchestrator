package trackerintake

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

func TestIdentityReturnsAuthenticatedLogin(t *testing.T) {
	svc := New(&fakeTracker{user: domain.TrackerUser{Login: "octocat"}})
	got, err := svc.Identity(context.Background())
	if err != nil {
		t.Fatalf("Identity: %v", err)
	}
	if got.Login != "octocat" {
		t.Fatalf("login = %q, want octocat", got.Login)
	}
}

func TestIdentityMapsTrackerFailure(t *testing.T) {
	svc := New(&fakeTracker{userErr: errors.New("offline")})
	_, err := svc.Identity(context.Background())
	var apiError *apierr.Error
	if !errors.As(err, &apiError) || apiError.Code != "GITHUB_IDENTITY_FAILED" {
		t.Fatalf("err = %#v, want GITHUB_IDENTITY_FAILED", err)
	}
}

func TestLabelsCachesAndRefreshesRepositoryCatalog(t *testing.T) {
	now := time.Date(2026, 7, 7, 10, 0, 0, 0, time.UTC)
	tracker := &fakeTracker{labels: []domain.TrackerLabel{{Name: "bug", Color: "d73a4a"}}}
	store := &fakeProjectStore{project: domain.ProjectRecord{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
	}}
	svc := NewWithDeps(Deps{Tracker: tracker, Store: store, Clock: func() time.Time { return now }})

	for _, refresh := range []bool{false, false, true} {
		labels, err := svc.Labels(context.Background(), "demo", refresh)
		if err != nil {
			t.Fatalf("Labels(refresh=%v): %v", refresh, err)
		}
		if len(labels) != 1 || labels[0].Name != "bug" {
			t.Fatalf("labels = %#v", labels)
		}
	}
	if tracker.labelCalls != 2 {
		t.Fatalf("ListLabels calls = %d, want 2", tracker.labelCalls)
	}

	now = now.Add(5*time.Minute + time.Nanosecond)
	if _, err := svc.Labels(context.Background(), "demo", false); err != nil {
		t.Fatalf("Labels after TTL: %v", err)
	}
	if tracker.labelCalls != 3 {
		t.Fatalf("ListLabels calls after TTL = %d, want 3", tracker.labelCalls)
	}
}

func TestPreviewCountsOpenIssuesMatchingUserAndLabels(t *testing.T) {
	tracker := &fakeTracker{
		user: domain.TrackerUser{Login: "octocat"},
		issues: []domain.Issue{
			{State: domain.IssueOpen, Labels: []string{"bug", "ready"}, Assignees: []string{"OctoCat"}},
			{State: domain.IssueOpen, Labels: []string{"bug"}, Assignees: []string{"octocat"}},
			{State: domain.IssueOpen, Labels: []string{"ready"}, Assignees: []string{"octocat"}},
			{State: domain.IssueOpen, Labels: []string{"needs-design"}, Assignees: []string{"octocat"}},
			{State: domain.IssueOpen, Labels: []string{"bug", "ready"}, Assignees: []string{"someone-else"}},
			{State: domain.IssueDone, Labels: []string{"bug", "ready"}, Assignees: []string{"octocat"}},
		},
	}
	store := &fakeProjectStore{project: domain.ProjectRecord{ID: "demo", RepoOriginURL: "https://github.com/acme/demo.git"}}
	svc := NewWithDeps(Deps{Tracker: tracker, Store: store})

	preview, err := svc.Preview(context.Background(), "demo", []string{"bug", "ready"})
	if err != nil {
		t.Fatalf("Preview: %v", err)
	}
	if preview.Count != 3 {
		t.Fatalf("count = %d, want 3", preview.Count)
	}
	if tracker.listFilter.Assignee != "octocat" || len(tracker.listFilter.Labels) != 0 || tracker.listFilter.State != domain.ListOpen {
		t.Fatalf("filter = %#v", tracker.listFilter)
	}
}

func TestPreviewRejectsInvalidLabels(t *testing.T) {
	svc := NewWithDeps(Deps{Tracker: &fakeTracker{}, Store: &fakeProjectStore{project: domain.ProjectRecord{ID: "demo"}}})
	_, err := svc.Preview(context.Background(), "demo", []string{" "})
	var apiError *apierr.Error
	if !errors.As(err, &apiError) || apiError.Code != "INVALID_TRACKER_INTAKE_FILTER" {
		t.Fatalf("err = %#v, want INVALID_TRACKER_INTAKE_FILTER", err)
	}
}

type fakeTracker struct {
	user       domain.TrackerUser
	userErr    error
	labels     []domain.TrackerLabel
	labelCalls int
	issues     []domain.Issue
	listFilter domain.ListFilter
}

func (f *fakeTracker) ListLabels(context.Context, domain.TrackerRepo) ([]domain.TrackerLabel, error) {
	f.labelCalls++
	return append([]domain.TrackerLabel(nil), f.labels...), nil
}

func (f *fakeTracker) List(_ context.Context, _ domain.TrackerRepo, filter domain.ListFilter) ([]domain.Issue, error) {
	f.listFilter = filter
	return append([]domain.Issue(nil), f.issues...), nil
}

type fakeProjectStore struct {
	project domain.ProjectRecord
	found   bool
	err     error
}

func (f *fakeProjectStore) GetProject(context.Context, string) (domain.ProjectRecord, bool, error) {
	found := f.found
	if !found && f.project.ID != "" {
		found = true
	}
	return f.project, found, f.err
}

func (f *fakeTracker) AuthenticatedUser(context.Context) (domain.TrackerUser, error) {
	return f.user, f.userErr
}
