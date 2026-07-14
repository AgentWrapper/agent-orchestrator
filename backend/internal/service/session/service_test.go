package session

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
)

type fakeTelemetrySink struct{ events []ports.TelemetryEvent }

func (f *fakeTelemetrySink) Emit(_ context.Context, ev ports.TelemetryEvent) {
	f.events = append(f.events, ev)
}
func (f *fakeTelemetrySink) Close(context.Context) error { return nil }

type fakeStore struct {
	sessions map[domain.SessionID]domain.SessionRecord
	pr       map[domain.SessionID]domain.PRFacts
	projects map[string]domain.ProjectRecord
	checks   map[string][]domain.PullRequestCheck
	reviews  map[string][]domain.PullRequestReview
	threads  map[string][]domain.PullRequestReviewThread
	comments map[string][]domain.PullRequestComment
	num      int
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		sessions: map[domain.SessionID]domain.SessionRecord{},
		pr:       map[domain.SessionID]domain.PRFacts{},
		projects: map[string]domain.ProjectRecord{},
		checks:   map[string][]domain.PullRequestCheck{},
		reviews:  map[string][]domain.PullRequestReview{},
		threads:  map[string][]domain.PullRequestReviewThread{},
		comments: map[string][]domain.PullRequestComment{},
	}
}

func (f *fakeStore) CreateSession(_ context.Context, rec domain.SessionRecord) (domain.SessionRecord, error) {
	f.num++
	rec.ID = domain.SessionID(fmt.Sprintf("%s-%d", rec.ProjectID, f.num))
	f.sessions[rec.ID] = rec
	return rec, nil
}

func (f *fakeStore) GetSession(_ context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	r, ok := f.sessions[id]
	return r, ok, nil
}

func (f *fakeStore) ListSessions(_ context.Context, p domain.ProjectID) ([]domain.SessionRecord, error) {
	var out []domain.SessionRecord
	for _, r := range f.sessions {
		if r.ProjectID == p {
			out = append(out, r)
		}
	}
	return out, nil
}

func (f *fakeStore) ListAllSessions(_ context.Context) ([]domain.SessionRecord, error) {
	out := make([]domain.SessionRecord, 0, len(f.sessions))
	for _, r := range f.sessions {
		out = append(out, r)
	}
	return out, nil
}

func (f *fakeStore) RenameSession(_ context.Context, id domain.SessionID, displayName string, updatedAt time.Time) (bool, error) {
	r, ok := f.sessions[id]
	if !ok {
		return false, nil
	}
	r.DisplayName = displayName
	r.UpdatedAt = updatedAt
	f.sessions[id] = r
	return true, nil
}

func (f *fakeStore) SetSessionPreviewURL(_ context.Context, id domain.SessionID, previewURL string, updatedAt time.Time) (bool, error) {
	r, ok := f.sessions[id]
	if !ok {
		return false, nil
	}
	r.Metadata.PreviewURL = previewURL
	r.UpdatedAt = updatedAt
	f.sessions[id] = r
	return true, nil
}

func (f *fakeStore) GetDisplayPRFactsForSession(_ context.Context, id domain.SessionID) (domain.PRFacts, bool, error) {
	pr, ok := f.pr[id]
	return pr, ok, nil
}

func (f *fakeStore) ListPRsBySession(_ context.Context, id domain.SessionID) ([]domain.PullRequest, error) {
	pr, ok := f.pr[id]
	if !ok {
		return nil, nil
	}
	return []domain.PullRequest{{URL: pr.URL, SessionID: id, Number: pr.Number, Draft: pr.Draft, Merged: pr.Merged, Closed: pr.Closed, CI: pr.CI, Review: pr.Review, Mergeability: pr.Mergeability, UpdatedAt: pr.UpdatedAt}}, nil
}

func (f *fakeStore) ListPRFactsForSession(_ context.Context, id domain.SessionID) ([]domain.PRFacts, error) {
	pr, ok := f.pr[id]
	if !ok {
		return nil, nil
	}
	return []domain.PRFacts{pr}, nil
}

func (f *fakeStore) ListChecks(_ context.Context, prURL string) ([]domain.PullRequestCheck, error) {
	return append([]domain.PullRequestCheck(nil), f.checks[prURL]...), nil
}

func (f *fakeStore) ListPRReviews(_ context.Context, prURL string) ([]domain.PullRequestReview, error) {
	return append([]domain.PullRequestReview(nil), f.reviews[prURL]...), nil
}

func (f *fakeStore) ListPRReviewThreads(_ context.Context, prURL string) ([]domain.PullRequestReviewThread, error) {
	return append([]domain.PullRequestReviewThread(nil), f.threads[prURL]...), nil
}

func (f *fakeStore) ListPRComments(_ context.Context, prURL string) ([]domain.PullRequestComment, error) {
	return append([]domain.PullRequestComment(nil), f.comments[prURL]...), nil
}

func (f *fakeStore) GetProject(_ context.Context, id string) (domain.ProjectRecord, bool, error) {
	p, ok := f.projects[id]
	return p, ok, nil
}

func TestSessionListDerivesStatusFromPRFacts(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Activity: domain.Activity{State: domain.ActivityActive}}
	st.pr["mer-1"] = domain.PRFacts{URL: "pr1", CI: domain.CIFailing}

	list, err := (&Service{store: st}).List(context.Background(), ListFilter{ProjectID: "mer"})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Status != domain.StatusCIFailed {
		t.Fatalf("got %+v", list)
	}
}

func TestSessionRenameUpdatesDisplayName(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer"}

	err := (&Service{store: st}).Rename(context.Background(), "mer-1", "  Fix issue #90  ")
	if err != nil {
		t.Fatal(err)
	}
	if got := st.sessions["mer-1"].DisplayName; got != "Fix issue #90" {
		t.Fatalf("display name = %q, want trimmed rename", got)
	}
}

func TestSessionSetPreviewPersistsURL(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer"}

	sess, err := (&Service{store: st, clock: time.Now}).SetPreview(context.Background(), "mer-1", "file:///tmp/index.html")
	if err != nil {
		t.Fatal(err)
	}
	if sess.Metadata.PreviewURL != "file:///tmp/index.html" {
		t.Fatalf("returned preview url = %q, want set value", sess.Metadata.PreviewURL)
	}
	if got := st.sessions["mer-1"].Metadata.PreviewURL; got != "file:///tmp/index.html" {
		t.Fatalf("persisted preview url = %q, want set value", got)
	}
}

func TestSessionSetPreviewUnknownSession(t *testing.T) {
	st := newFakeStore()
	if _, err := (&Service{store: st}).SetPreview(context.Background(), "ghost-1", "http://x"); err == nil {
		t.Fatal("want error for unknown session")
	}
}

func TestSessionRenameMissingSessionReturnsNotFound(t *testing.T) {
	st := newFakeStore()

	err := (&Service{store: st}).Rename(context.Background(), "mer-404", "Missing")
	var e *apierr.Error
	if !errors.As(err, &e) || e.Kind != apierr.KindNotFound || e.Code != "SESSION_NOT_FOUND" {
		t.Fatalf("err = %v, want apierr NotFound SESSION_NOT_FOUND", err)
	}
}

// fakeCommander records Kill/Spawn calls so a test can assert the
// clean-orchestrator ordering without wiring a real session engine.
type fakeCommander struct {
	killed          []domain.SessionID
	retired         []domain.SessionID
	sent            []domain.SessionID
	cleanupProjects []domain.ProjectID
	killErr         error
	retireErr       error
	sendErr         error
	cleanupErr      error
	spawnErr        error
	spawnRecord     domain.SessionRecord
	spawned         bool
	spawnedCfg      ports.SpawnConfig
	killsAtSpawn    int
}

func (f *fakeCommander) Spawn(_ context.Context, cfg ports.SpawnConfig) (domain.SessionRecord, error) {
	if f.spawnErr != nil {
		return domain.SessionRecord{}, f.spawnErr
	}
	f.spawned = true
	f.spawnedCfg = cfg
	f.killsAtSpawn = len(f.retired)
	if f.spawnRecord.ID != "" {
		return f.spawnRecord, nil
	}
	return domain.SessionRecord{ID: "mer-9", ProjectID: cfg.ProjectID, Kind: cfg.Kind, Harness: cfg.Harness}, nil
}
func (f *fakeCommander) Restore(context.Context, domain.SessionID) (domain.SessionRecord, error) {
	return domain.SessionRecord{}, nil
}
func (f *fakeCommander) Kill(_ context.Context, id domain.SessionID) (bool, error) {
	if f.killErr != nil {
		return false, f.killErr
	}
	f.killed = append(f.killed, id)
	return true, nil
}
func (f *fakeCommander) RetireForReplacement(_ context.Context, id domain.SessionID) error {
	if f.retireErr != nil {
		return f.retireErr
	}
	f.retired = append(f.retired, id)
	return nil
}
func (f *fakeCommander) Send(_ context.Context, id domain.SessionID, _ string) error {
	if f.sendErr != nil {
		return f.sendErr
	}
	f.sent = append(f.sent, id)
	return nil
}
func (f *fakeCommander) Cleanup(_ context.Context, project domain.ProjectID) (sessionmanager.CleanupResult, error) {
	f.cleanupProjects = append(f.cleanupProjects, project)
	if f.cleanupErr != nil {
		return sessionmanager.CleanupResult{}, f.cleanupErr
	}
	return sessionmanager.CleanupResult{
		Cleaned: []domain.SessionID{"mer-1"},
		Skipped: []sessionmanager.CleanupSkip{{SessionID: "mer-2", Reason: "workspace has uncommitted changes"}},
	}, nil
}
func (f *fakeCommander) RollbackSpawn(context.Context, domain.SessionID) (bool, bool, error) {
	return false, false, nil
}

// TestCleanupMapsManagerResult: the service forwards both reclaimed and
// skipped sessions, with non-nil slices so the wire shape stays stable.
func TestCleanupMapsManagerResult(t *testing.T) {
	svc := &Service{manager: &fakeCommander{}}
	out, err := svc.Cleanup(context.Background(), "mer")
	if err != nil {
		t.Fatalf("Cleanup: %v", err)
	}
	if len(out.Cleaned) != 1 || out.Cleaned[0] != "mer-1" {
		t.Fatalf("cleaned = %#v", out.Cleaned)
	}
	if len(out.Skipped) != 1 || out.Skipped[0].SessionID != "mer-2" || out.Skipped[0].Reason != "workspace has uncommitted changes" {
		t.Fatalf("skipped = %#v", out.Skipped)
	}
}

func TestTeardownProjectKillsActiveSessionsThenCleansProject(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer"}
	st.sessions["mer-2"] = domain.SessionRecord{ID: "mer-2", ProjectID: "mer", IsTerminated: true}
	st.sessions["other-1"] = domain.SessionRecord{ID: "other-1", ProjectID: "other"}
	fc := &fakeCommander{}
	svc := &Service{manager: fc, store: st}

	if err := svc.TeardownProject(context.Background(), "mer"); err != nil {
		t.Fatalf("TeardownProject: %v", err)
	}
	if len(fc.killed) != 1 || fc.killed[0] != "mer-1" {
		t.Fatalf("killed = %#v, want only mer-1", fc.killed)
	}
	if len(fc.cleanupProjects) != 1 || fc.cleanupProjects[0] != "mer" {
		t.Fatalf("cleanup projects = %#v, want [mer]", fc.cleanupProjects)
	}
}

func TestTeardownProjectStopsOnKillError(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer"}
	boom := errors.New("boom")
	fc := &fakeCommander{killErr: boom}
	svc := &Service{manager: fc, store: st}

	err := svc.TeardownProject(context.Background(), "mer")
	if !errors.Is(err, boom) {
		t.Fatalf("TeardownProject err = %v, want boom", err)
	}
	if len(fc.cleanupProjects) != 0 {
		t.Fatalf("cleanup projects = %#v, want none after kill failure", fc.cleanupProjects)
	}
}

func TestSpawnOrchestratorCleanRetiresActiveOrchestratorsBeforeSpawn(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer"}
	// Two active orchestrators plus an unrelated worker and a terminated
	// orchestrator that must be left alone.
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Kind: domain.KindOrchestrator}
	st.sessions["mer-2"] = domain.SessionRecord{ID: "mer-2", ProjectID: "mer", Kind: domain.KindOrchestrator}
	st.sessions["mer-3"] = domain.SessionRecord{ID: "mer-3", ProjectID: "mer", Kind: domain.KindWorker}
	st.sessions["mer-4"] = domain.SessionRecord{ID: "mer-4", ProjectID: "mer", Kind: domain.KindOrchestrator, IsTerminated: true}

	fc := &fakeCommander{}
	svc := &Service{manager: fc, store: st}

	if _, err := svc.SpawnOrchestrator(context.Background(), "mer", true); err != nil {
		t.Fatalf("SpawnOrchestrator: %v", err)
	}

	if len(fc.retired) != 2 {
		t.Fatalf("retired = %v, want the two active orchestrators", fc.retired)
	}
	if len(fc.sent) != 2 {
		t.Fatalf("retire notices = %v, want the two active orchestrators", fc.sent)
	}
	if !fc.spawned || fc.killsAtSpawn != 2 {
		t.Fatalf("spawn must run after both retirements: spawned=%v retirementsAtSpawn=%d", fc.spawned, fc.killsAtSpawn)
	}
	if len(fc.killed) != 0 {
		t.Fatalf("interactive Kill must not be used for replacement: killed=%v", fc.killed)
	}
}

func TestSpawnOrchestratorCleanContinuesWhenRetireNoticeFails(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer"}
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Kind: domain.KindOrchestrator}
	fc := &fakeCommander{sendErr: errors.New("pane closed")}
	svc := &Service{manager: fc, store: st}

	if _, err := svc.SpawnOrchestrator(context.Background(), "mer", true); err != nil {
		t.Fatalf("SpawnOrchestrator: %v", err)
	}
	if len(fc.retired) != 1 || fc.retired[0] != "mer-1" {
		t.Fatalf("retired = %v, want mer-1 despite retire notice failure", fc.retired)
	}
	if !fc.spawned {
		t.Fatal("replacement should still spawn when retire notice delivery fails")
	}
}

// TestSpawnUnknownProjectReturns404 covers Bug 1: an HTTP spawn for an
// unregistered projectId must surface PROJECT_NOT_FOUND (apierr.NotFound)
// BEFORE any session row is created, so no orphan terminated row is left
// behind under `--include-terminated`.
func TestSpawnUnknownProjectReturns404(t *testing.T) {
	st := newFakeStore()
	fc := &fakeCommander{}
	svc := &Service{manager: fc, store: st}

	_, err := svc.Spawn(context.Background(), ports.SpawnConfig{ProjectID: "ghost", Kind: domain.KindWorker})
	var e *apierr.Error
	if !errors.As(err, &e) || e.Kind != apierr.KindNotFound || e.Code != "PROJECT_NOT_FOUND" {
		t.Fatalf("err = %v, want apierr.NotFound PROJECT_NOT_FOUND", err)
	}
	if fc.spawned {
		t.Fatal("manager.Spawn must NOT be invoked for an unknown project")
	}
}

func TestSpawnEmitsFirstSessionOnboardingAndDuration(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", RegisteredAt: time.Unix(100, 0).UTC()}
	sink := &fakeTelemetrySink{}
	fc := &fakeCommander{}
	svc := NewWithDeps(Deps{
		Manager:   fc,
		Store:     st,
		Telemetry: sink,
		Clock:     func() time.Time { return time.Unix(102, 0).UTC() },
	})

	if _, err := svc.Spawn(context.Background(), ports.SpawnConfig{ProjectID: "mer"}); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if len(sink.events) != 2 {
		t.Fatalf("events = %#v, want spawned + first_session", sink.events)
	}
	if sink.events[0].Name != "ao.session.spawned" || sink.events[1].Name != "ao.onboarding.first_session_spawned" {
		t.Fatalf("event names = %#v", []string{sink.events[0].Name, sink.events[1].Name})
	}
	if got := sink.events[0].Payload["duration_ms"]; got != int64(0) {
		t.Fatalf("spawn duration_ms = %#v, want 0 with fixed clock", got)
	}
	if got := sink.events[1].Payload["since_first_project_ms"]; got != int64(2000) {
		t.Fatalf("since_first_project_ms = %#v, want 2000", got)
	}
}

type fakeTracker struct {
	issue domain.Issue
	err   error
	ids   []domain.TrackerID
}

func (f *fakeTracker) Get(_ context.Context, id domain.TrackerID) (domain.Issue, error) {
	f.ids = append(f.ids, id)
	if f.err != nil {
		return domain.Issue{}, f.err
	}
	return f.issue, nil
}

func (f *fakeTracker) List(context.Context, domain.TrackerRepo, domain.ListFilter) ([]domain.Issue, error) {
	return nil, nil
}

func (f *fakeTracker) Preflight(context.Context) error { return nil }

func TestSpawnEnrichesIssueContextFromTracker(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", RepoOriginURL: "https://github.com/acme/repo.git"}
	fc := &fakeCommander{}
	tracker := &fakeTracker{issue: domain.Issue{
		ID:        domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/repo#42"},
		Title:     "Fix generated prompts",
		Body:      "Prompt files should include standing instructions.",
		State:     domain.IssueInProgress,
		URL:       "https://github.com/acme/repo/issues/42",
		Labels:    []string{"bug", "prompts"},
		Assignees: []string{"dev"},
	}}
	svc := NewWithDeps(Deps{Manager: fc, Store: st, Tracker: tracker})

	if _, err := svc.Spawn(context.Background(), ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, IssueID: "42"}); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if len(tracker.ids) != 1 || tracker.ids[0].Provider != domain.TrackerProviderGitHub || tracker.ids[0].Native != "acme/repo#42" {
		t.Fatalf("tracker ids = %+v, want github acme/repo#42", tracker.ids)
	}
	issueContext := fc.spawnedCfg.IssueContext
	for _, want := range []string{
		"Issue: acme/repo#42",
		"Title: Fix generated prompts",
		"State: in_progress",
		"URL: https://github.com/acme/repo/issues/42",
		"Labels: bug, prompts",
		"Assignees: dev",
		"Body:\nPrompt files should include standing instructions.",
	} {
		if !strings.Contains(issueContext, want) {
			t.Fatalf("IssueContext missing %q:\n%s", want, issueContext)
		}
	}
}

func TestSpawnIssueContextFetchFailureFallsBack(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", RepoOriginURL: "https://github.com/acme/repo"}
	fc := &fakeCommander{}
	tracker := &fakeTracker{err: errors.New("tracker unavailable")}
	svc := NewWithDeps(Deps{Manager: fc, Store: st, Tracker: tracker})

	if _, err := svc.Spawn(context.Background(), ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, IssueID: "42"}); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if len(tracker.ids) != 1 {
		t.Fatalf("tracker calls = %d, want 1", len(tracker.ids))
	}
	if fc.spawnedCfg.IssueContext != "" {
		t.Fatalf("IssueContext = %q, want fallback empty context", fc.spawnedCfg.IssueContext)
	}
}

// TestSpawnPreservesIssueIDWhenTrackerIsNil covers the issue #2685 boundary: when
// the daemon wiring cannot build a GitHub tracker (no token), it hands the session
// service a true-nil ports.Tracker. Spawn must still create the session, preserve
// IssueID, and skip only the GitHub issue-context enrichment — not panic on a
// typed-nil tracker the way the pre-fix wiring did.
func TestSpawnPreservesIssueIDWhenTrackerIsNil(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", RepoOriginURL: "https://github.com/acme/repo"}
	fc := &fakeCommander{}
	svc := NewWithDeps(Deps{Manager: fc, Store: st, Tracker: nil})

	if _, err := svc.Spawn(context.Background(), ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, IssueID: "107"}); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if fc.spawnedCfg.IssueID != "107" {
		t.Fatalf("IssueID = %q, want 107 preserved", fc.spawnedCfg.IssueID)
	}
	if fc.spawnedCfg.IssueContext != "" {
		t.Fatalf("IssueContext = %q, want empty (no tracker enrichment)", fc.spawnedCfg.IssueContext)
	}
}

func TestSpawnIssueContextSkipsUnresolvableIssueRef(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", RepoOriginURL: "https://github.com/acme/repo"}
	fc := &fakeCommander{}
	tracker := &fakeTracker{}
	svc := NewWithDeps(Deps{Manager: fc, Store: st, Tracker: tracker})

	if _, err := svc.Spawn(context.Background(), ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, IssueID: "not-an-issue"}); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if len(tracker.ids) != 0 {
		t.Fatalf("tracker calls = %d, want 0", len(tracker.ids))
	}
	if fc.spawnedCfg.IssueContext != "" {
		t.Fatalf("IssueContext = %q, want empty", fc.spawnedCfg.IssueContext)
	}
}

func TestSpawnFailedEmitsDuration(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer"}
	sink := &fakeTelemetrySink{}
	fc := &fakeCommander{spawnErr: errors.New("boom")}
	now := time.Unix(200, 0).UTC()
	svc := NewWithDeps(Deps{
		Manager:   fc,
		Store:     st,
		Telemetry: sink,
		Clock: func() time.Time {
			v := now
			now = now.Add(1500 * time.Millisecond)
			return v
		},
	})

	if _, err := svc.Spawn(context.Background(), ports.SpawnConfig{ProjectID: "mer"}); err == nil {
		t.Fatal("Spawn should fail")
	}
	if len(sink.events) != 1 || sink.events[0].Name != "ao.session.spawn_failed" {
		t.Fatalf("events = %#v, want one spawn_failed", sink.events)
	}
	if got := sink.events[0].Payload["duration_ms"]; got != int64(1500) {
		t.Fatalf("spawn_failed duration_ms = %#v, want 1500", got)
	}
	if got := sink.events[0].Payload["error_kind"]; got != "internal" {
		t.Fatalf("spawn_failed error_kind = %#v, want internal", got)
	}
	if got := sink.events[0].Payload["component"]; got != "session_service" {
		t.Fatalf("spawn_failed component = %#v, want session_service", got)
	}
	if got := sink.events[0].Payload["operation"]; got != "spawn_session" {
		t.Fatalf("spawn_failed operation = %#v, want spawn_session", got)
	}
	if got := sink.events[0].Payload["fingerprint"]; got == "" {
		t.Fatalf("spawn_failed fingerprint = %#v, want non-empty", got)
	}
}

func TestSpawnEmitsTelemetryOnSuccess(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer"}
	st.sessions["old-1"] = domain.SessionRecord{ID: "old-1", ProjectID: "other"}
	fc := &fakeCommander{}
	ts := &fakeTelemetrySink{}
	svc := NewWithDeps(Deps{Manager: fc, Store: st, Telemetry: ts, Clock: func() time.Time { return time.Unix(1700000000, 0).UTC() }})

	_, err := svc.Spawn(context.Background(), ports.SpawnConfig{
		ProjectID: "mer",
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessCodex,
	})
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if len(ts.events) != 1 {
		t.Fatalf("telemetry events = %d, want 1", len(ts.events))
	}
	ev := ts.events[0]
	if ev.Name != "ao.session.spawned" || ev.Source != "session_service" {
		t.Fatalf("event = %+v", ev)
	}
	if ev.ProjectID == nil || *ev.ProjectID != "mer" || ev.SessionID == nil || *ev.SessionID != "mer-9" {
		t.Fatalf("event ids = %+v", ev)
	}
}

func TestSpawnEmitsTelemetryOnFailure(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer"}
	fc := &fakeCommander{spawnErr: errors.New("boom")}
	ts := &fakeTelemetrySink{}
	svc := NewWithDeps(Deps{Manager: fc, Store: st, Telemetry: ts, Clock: func() time.Time { return time.Unix(1700000000, 0).UTC() }})

	_, err := svc.Spawn(context.Background(), ports.SpawnConfig{
		ProjectID: "mer",
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessCodex,
	})
	if err == nil {
		t.Fatal("Spawn error = nil, want failure")
	}
	if len(ts.events) != 1 {
		t.Fatalf("telemetry events = %d, want 1", len(ts.events))
	}
	ev := ts.events[0]
	if ev.Name != "ao.session.spawn_failed" || ev.Source != "session_service" || ev.Level != ports.TelemetryLevelError {
		t.Fatalf("event = %+v", ev)
	}
	if ev.ProjectID == nil || *ev.ProjectID != "mer" || ev.SessionID != nil {
		t.Fatalf("event ids = %+v", ev)
	}
	if got := ev.Payload["error_kind"]; got != "internal" {
		t.Fatalf("event payload error_kind = %#v, want internal", got)
	}
	if got := ev.Payload["component"]; got != "session_service" {
		t.Fatalf("event payload component = %#v, want session_service", got)
	}
	if got := ev.Payload["operation"]; got != "spawn_session" {
		t.Fatalf("event payload operation = %#v, want spawn_session", got)
	}
	if got := ev.Payload["fingerprint"]; got == "" {
		t.Fatalf("event payload fingerprint = %#v, want non-empty", got)
	}
	if _, ok := ev.Payload["error"]; ok {
		t.Fatalf("event payload leaked raw error: %+v", ev.Payload)
	}
}

func TestSpawnEmitsTypedErrorCodeOnFailure(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer"}
	fc := &fakeCommander{spawnErr: fmt.Errorf("spawn: %w: %q", sessionmanager.ErrUnknownHarness, "bogus")}
	ts := &fakeTelemetrySink{}
	svc := NewWithDeps(Deps{Manager: fc, Store: st, Telemetry: ts, Clock: func() time.Time { return time.Unix(1700000000, 0).UTC() }})

	_, err := svc.Spawn(context.Background(), ports.SpawnConfig{
		ProjectID: "mer",
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessCodex,
	})
	if err == nil {
		t.Fatal("Spawn error = nil, want failure")
	}
	if len(ts.events) != 1 {
		t.Fatalf("telemetry events = %d, want 1", len(ts.events))
	}
	ev := ts.events[0]
	if got := ev.Payload["error_kind"]; got != "invalid" {
		t.Fatalf("event payload error_kind = %#v, want invalid", got)
	}
	if got := ev.Payload["error_code"]; got != "UNKNOWN_HARNESS" {
		t.Fatalf("event payload error_code = %#v, want UNKNOWN_HARNESS", got)
	}
}

// TestSpawnOrchestratorUnknownProjectReturns404 is the orchestrator-side guard
// for Bug 1: same pre-validation, same typed envelope.
func TestSpawnOrchestratorUnknownProjectReturns404(t *testing.T) {
	st := newFakeStore()
	fc := &fakeCommander{}
	svc := &Service{manager: fc, store: st}

	_, err := svc.SpawnOrchestrator(context.Background(), "ghost", false)
	var e *apierr.Error
	if !errors.As(err, &e) || e.Kind != apierr.KindNotFound || e.Code != "PROJECT_NOT_FOUND" {
		t.Fatalf("err = %v, want apierr.NotFound PROJECT_NOT_FOUND", err)
	}
	if fc.spawned {
		t.Fatal("manager.Spawn must NOT be invoked for an unknown project")
	}
}

// TestToAPIErrorMapsWorkspaceBranchSentinels covers Bug 3: the workspace
// adapter's typed branch errors map to typed envelope errors instead of
// collapsing to a 500.
func TestToAPIErrorMapsWorkspaceBranchSentinels(t *testing.T) {
	cases := []struct {
		name     string
		err      error
		wantKind apierr.Kind
		wantCode string
	}{
		{"checked out elsewhere", fmt.Errorf("spawn mer-1: workspace: %w: \"x\" is checked out at \"/tmp\"", ports.ErrWorkspaceBranchCheckedOutElsewhere), apierr.KindConflict, "BRANCH_CHECKED_OUT_ELSEWHERE"},
		{"not fetched", fmt.Errorf("spawn mer-1: workspace: %w: \"x\" has no local head", ports.ErrWorkspaceBranchNotFetched), apierr.KindInvalid, "BRANCH_NOT_FETCHED"},
		{"invalid branch", fmt.Errorf("spawn mer-1: workspace: %w: \"bad!!\" (exit 1)", ports.ErrWorkspaceBranchInvalid), apierr.KindInvalid, "INVALID_BRANCH"},
		{"agent binary not found", fmt.Errorf("spawn mer-1: %w", ports.ErrAgentBinaryNotFound), apierr.KindInvalid, "AGENT_BINARY_NOT_FOUND"},
		{"runtime prerequisite missing", fmt.Errorf("spawn: %w: tmux required on macOS/Linux but not in PATH", ports.ErrRuntimePrerequisite), apierr.KindInvalid, "RUNTIME_PREREQUISITE_MISSING"},
		{"unknown harness", fmt.Errorf("spawn: %w: %q", sessionmanager.ErrUnknownHarness, "bogus"), apierr.KindInvalid, "UNKNOWN_HARNESS"},
		{"missing harness", fmt.Errorf("spawn: %w: configure project worker.agent or pass --harness", sessionmanager.ErrMissingHarness), apierr.KindInvalid, "AGENT_REQUIRED"},
		{"awaiting decision", fmt.Errorf("send mer-1: %w", sessionmanager.ErrAwaitingDecision), apierr.KindConflict, "SESSION_AWAITING_DECISION"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mapped := toAPIError(tc.err)
			var e *apierr.Error
			if !errors.As(mapped, &e) || e.Kind != tc.wantKind || e.Code != tc.wantCode {
				t.Fatalf("mapped = %v, want %s %s", mapped, tc.wantCode, e)
			}
		})
	}
}

// TestToAPIError_NotResumable asserts that ErrNotResumable (promptless worker
// with no adapter resume handle) maps to a Conflict with code SESSION_NOT_RESUMABLE.
func TestToAPIError_NotResumable(t *testing.T) {
	err := fmt.Errorf("restore mer-1: %w", sessionmanager.ErrNotResumable)
	mapped := toAPIError(err)
	var e *apierr.Error
	if !errors.As(mapped, &e) || e.Kind != apierr.KindConflict || e.Code != "SESSION_NOT_RESUMABLE" {
		t.Fatalf("mapped = %v, want Conflict SESSION_NOT_RESUMABLE", mapped)
	}
}

// TestSpawnOrchestratorNoCleanReturnsExistingWhenActiveExists is the RED test
// for the idempotency fix: when an active orchestrator already exists and
// clean=false, SpawnOrchestrator must return that orchestrator without minting
// a second one. Before the fix this test fails because a duplicate is spawned.
func TestSpawnOrchestratorNoCleanReturnsExistingWhenActiveExists(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer"}
	// Pre-load an active orchestrator.
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Kind: domain.KindOrchestrator}

	fc := &fakeCommander{}
	svc := &Service{manager: fc, store: st}

	got, err := svc.SpawnOrchestrator(context.Background(), "mer", false)
	if err != nil {
		t.Fatalf("SpawnOrchestrator: %v", err)
	}
	// Must return the existing orchestrator, not a newly minted one.
	if got.ID != "mer-1" {
		t.Fatalf("returned id = %q, want existing orchestrator mer-1", got.ID)
	}
	// Must NOT have called manager.Spawn (no duplicate created).
	if fc.spawned {
		t.Fatal("manager.Spawn must NOT be called when an active orchestrator already exists")
	}
	// Must NOT have killed anything.
	if len(fc.killed) != 0 {
		t.Fatalf("no kills expected with clean=false, got %v", fc.killed)
	}
	// Exactly one session in the store (no duplicate).
	if len(st.sessions) != 1 {
		t.Fatalf("session count = %d, want 1 (no duplicate)", len(st.sessions))
	}
}

// TestSpawnOrchestratorNoCleanSpawnsWhenNoneExists: clean=false spawns a new
// orchestrator when no active one exists for the project.
func TestSpawnOrchestratorNoCleanSpawnsWhenNoneExists(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer"}
	// No active orchestrator present.

	fc := &fakeCommander{}
	svc := &Service{manager: fc, store: st}

	got, err := svc.SpawnOrchestrator(context.Background(), "mer", false)
	if err != nil {
		t.Fatalf("SpawnOrchestrator: %v", err)
	}
	if !fc.spawned {
		t.Fatal("manager.Spawn must be called when no active orchestrator exists")
	}
	if len(fc.killed) != 0 {
		t.Fatalf("no kills expected with clean=false, got %v", fc.killed)
	}
	if got.ID == "" {
		t.Fatal("returned session must have an id")
	}
}

func TestSpawnOrchestratorVerifiesReplacementHarness(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{
		ID:     "mer",
		Config: domain.ProjectConfig{Orchestrator: domain.RoleOverride{Harness: domain.HarnessCodex}},
	}
	fc := &fakeCommander{
		spawnRecord: domain.SessionRecord{
			ID:        "mer-9",
			ProjectID: "mer",
			Kind:      domain.KindOrchestrator,
			Harness:   domain.HarnessClaudeCode,
			Metadata:  domain.SessionMetadata{Branch: "ao/mer-orchestrator"},
		},
	}
	svc := &Service{manager: fc, store: st}

	_, err := svc.SpawnOrchestrator(context.Background(), "mer", false)
	if err == nil || !strings.Contains(err.Error(), `uses harness "claude-code", want "codex"`) {
		t.Fatalf("SpawnOrchestrator err = %v, want harness verification failure", err)
	}
}

type fakePRClaimer struct {
	out errorFreeClaimOutcome
	err error
}

type errorFreeClaimOutcome struct {
	ports.ClaimOutcome
}

func (f fakePRClaimer) ClaimPR(context.Context, domain.PullRequest, []domain.PullRequestCheck, []domain.PullRequestReview, []domain.PullRequestReviewThread, []domain.PullRequestComment, ports.ReviewWriteMode, bool) (ports.ClaimOutcome, error) {
	return f.out.ClaimOutcome, f.err
}

type fakeSCM struct {
	obs       ports.SCMObservation
	review    ports.SCMReviewObservation
	fetchErr  error
	reviewErr error
}

func (f fakeSCM) ParseRepository(remote string) (ports.SCMRepo, bool) {
	owner, repo, err := githubRepoFromURL(remote)
	if err != nil {
		return ports.SCMRepo{}, false
	}
	return ports.SCMRepo{Provider: "github", Host: "github.com", Owner: owner, Name: repo, Repo: owner + "/" + repo}, true
}

func (f fakeSCM) FetchPullRequests(context.Context, []ports.SCMPRRef) ([]ports.SCMObservation, error) {
	if f.fetchErr != nil {
		return nil, f.fetchErr
	}
	if !f.obs.Fetched && f.obs.PR.URL == "" && f.obs.PR.Number == 0 {
		return nil, nil
	}
	return []ports.SCMObservation{f.obs}, nil
}

func (f fakeSCM) FetchReviewThreads(context.Context, ports.SCMPRRef) (ports.SCMReviewObservation, error) {
	return f.review, f.reviewErr
}

func TestClaimPRMapsObserverAndStoreErrors(t *testing.T) {
	st := newFakeStore()
	now := time.Date(2026, 6, 4, 12, 0, 0, 0, time.UTC)
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker, Metadata: domain.SessionMetadata{WorkspacePath: "/ws"}}
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", RepoOriginURL: "https://github.com/acme/repo"}

	cases := []struct {
		name string
		svc  *Service
		want error
	}{
		{"missing scm", NewWithDeps(Deps{Store: st}), ErrSCMUnavailable},
		{"not found", NewWithDeps(Deps{Store: st, PRClaimer: fakePRClaimer{}, SCM: fakeSCM{fetchErr: ports.ErrSCMNotFound}}), ErrPRNotFound},
		{"closed", NewWithDeps(Deps{Store: st, PRClaimer: fakePRClaimer{}, SCM: fakeSCM{obs: ports.SCMObservation{Fetched: true, Provider: "github", Host: "github.com", Repo: "acme/repo", PR: ports.SCMPRObservation{URL: "https://github.com/acme/repo/pull/7", Number: 7, Closed: true}}}}), ErrPRNotOpen},
		{"active owner", NewWithDeps(Deps{Store: st, PRClaimer: fakePRClaimer{err: ports.PRClaimedByActiveSessionError{Owner: "mer-2"}}, SCM: fakeSCM{obs: ports.SCMObservation{Fetched: true, Provider: "github", Host: "github.com", Repo: "acme/repo", PR: ports.SCMPRObservation{URL: "https://github.com/acme/repo/pull/7", Number: 7}}}}), ports.ErrPRClaimedByActiveSession},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := tc.svc.ClaimPR(context.Background(), "mer-1", "7", ClaimPROptions{AllowTakeover: false})
			if !errors.Is(err, tc.want) {
				t.Fatalf("err=%v, want %v", err, tc.want)
			}
		})
	}

	st.pr["mer-1"] = domain.PRFacts{URL: "https://github.com/acme/repo/pull/7", Number: 7, CI: domain.CIPassing, UpdatedAt: now}
	svc := NewWithDeps(Deps{Store: st, PRClaimer: fakePRClaimer{out: errorFreeClaimOutcome{ports.ClaimOutcome{PreviousOwner: "mer-2"}}}, SCM: fakeSCM{obs: ports.SCMObservation{Fetched: true, Provider: "github", Host: "github.com", Repo: "acme/repo", PR: ports.SCMPRObservation{URL: "https://github.com/acme/repo/pull/7", Number: 7}}}})
	res, err := svc.ClaimPR(context.Background(), "mer-1", "7", ClaimPROptions{AllowTakeover: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.TakenOverFrom) != 1 || res.TakenOverFrom[0] != "mer-2" || len(res.PRs) != 1 || res.PRs[0].URL == "" {
		t.Fatalf("claim result = %+v", res)
	}
}

func TestListPRsOrdersActiveBeforeClosedThenUpdatedDesc(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker}
	now := time.Date(2026, 6, 4, 12, 0, 0, 0, time.UTC)
	st.pr = map[domain.SessionID]domain.PRFacts{}
	stList := &multiPRFakeStore{fakeStore: st, prs: []domain.PullRequest{
		{URL: "closed-new", SessionID: "mer-1", Number: 1, Closed: true, UpdatedAt: now.Add(2 * time.Hour)},
		{URL: "open-old", SessionID: "mer-1", Number: 2, UpdatedAt: now},
		{URL: "open-new", SessionID: "mer-1", Number: 3, UpdatedAt: now.Add(time.Hour)},
	}}
	got, err := (&Service{store: stList}).ListPRs(context.Background(), "mer-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].URL != "open-new" || got[1].URL != "open-old" || got[2].URL != "closed-new" {
		t.Fatalf("order = %+v", got)
	}
}

func TestListPRSummariesOmitsRawLogsAndReviewBodies(t *testing.T) {
	st := newFakeStore()
	now := time.Date(2026, 6, 4, 12, 0, 0, 0, time.UTC)
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker}
	prURL := "https://github.com/acme/repo/pull/7"
	stList := &multiPRFakeStore{fakeStore: st, prs: []domain.PullRequest{{
		URL:                      prURL,
		HTMLURL:                  prURL,
		SessionID:                "mer-1",
		Number:                   7,
		CI:                       domain.CIFailing,
		Review:                   domain.ReviewChangesRequest,
		Mergeability:             domain.MergeConflicting,
		Provider:                 "github",
		Repo:                     "acme/repo",
		Title:                    "Fix dashboard",
		Author:                   "ada",
		SourceBranch:             "fix/dashboard",
		TargetBranch:             "main",
		HeadSHA:                  "abc123",
		ProviderMergeStateStatus: "dirty",
		UpdatedAt:                now,
		ObservedAt:               now.Add(-time.Minute),
		CIObservedAt:             now.Add(-time.Minute),
		ReviewObservedAt:         now.Add(-time.Minute),
	}}}
	stList.checks[prURL] = []domain.PullRequestCheck{
		{Name: "unit", Status: domain.PRCheckFailed, Conclusion: "failure", URL: "https://github.com/acme/repo/actions/runs/1", LogTail: "panic: secret"},
		{Name: "lint", Status: domain.PRCheckPassed, Conclusion: "success", URL: "https://github.com/acme/repo/actions/runs/2"},
	}
	stList.reviews[prURL] = []domain.PullRequestReview{
		{ID: "review-1", Author: "reviewer-a", State: domain.ReviewChangesRequest, URL: "https://github.com/acme/repo/pull/7#pullrequestreview-1", SubmittedAt: now.Add(-30 * time.Second)},
	}
	stList.comments[prURL] = []domain.PullRequestComment{
		{Author: "reviewer-a", File: "main.go", Line: 12, Body: "raw body must stay private", URL: "https://github.com/acme/repo/pull/7#discussion_r1"},
		{Author: "ci-bot", File: "main.go", Line: 13, Body: "bot body", URL: "https://github.com/acme/repo/pull/7#discussion_r2", IsBot: true},
		{Author: "reviewer-a", File: "test.go", Line: 22, Body: "another raw body", URL: "https://github.com/acme/repo/pull/7#discussion_r3"},
	}

	got, err := (&Service{store: stList}).ListPRSummaries(context.Background(), "mer-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("summaries = %+v", got)
	}
	pr := got[0]
	if pr.Title != "Fix dashboard" || pr.State != domain.PRStateOpen || pr.Provider != "github" || pr.Repo != "acme/repo" || pr.HeadSHA != "abc123" {
		t.Fatalf("metadata = %+v", pr)
	}
	if len(pr.CI.FailingChecks) != 1 || pr.CI.FailingChecks[0].Name != "unit" || pr.CI.FailingChecks[0].URL == "" {
		t.Fatalf("failing checks = %+v", pr.CI.FailingChecks)
	}
	if pr.Review.Decision != domain.ReviewChangesRequest || !pr.Review.HasUnresolvedHumanComments || len(pr.Review.UnresolvedBy) != 1 {
		t.Fatalf("review = %+v", pr.Review)
	}
	if reviewer := pr.Review.UnresolvedBy[0]; reviewer.ReviewerID != "reviewer-a" || reviewer.Count != 2 || len(reviewer.Links) != 2 {
		t.Fatalf("reviewer = %+v", reviewer)
	} else if reviewer.ReviewURL != "https://github.com/acme/repo/pull/7#pullrequestreview-1" {
		t.Fatalf("review url = %q", reviewer.ReviewURL)
	}
	if pr.Mergeability.State != domain.MergeConflicting || len(pr.Mergeability.ConflictFiles) != 0 || !containsString(pr.Mergeability.Reasons, "conflicts") {
		t.Fatalf("mergeability = %+v", pr.Mergeability)
	}
}

func TestListPRSummariesSuppressesFailingChecksUnlessCIFailing(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker}
	prURL := "https://github.com/acme/repo/pull/8"
	stList := &multiPRFakeStore{fakeStore: st, prs: []domain.PullRequest{{
		URL:       prURL,
		SessionID: "mer-1",
		Number:    8,
		CI:        domain.CIPassing,
		HeadSHA:   "new-sha",
		UpdatedAt: time.Date(2026, 6, 4, 12, 0, 0, 0, time.UTC),
	}}}
	stList.checks[prURL] = []domain.PullRequestCheck{
		{Name: "copy-check", CommitHash: "old-sha", Status: domain.PRCheckFailed, Conclusion: "failure", URL: "https://github.com/acme/repo/actions/runs/1"},
	}

	got, err := (&Service{store: stList}).ListPRSummaries(context.Background(), "mer-1")
	if err != nil {
		t.Fatal(err)
	}
	if got[0].CI.State != domain.CIPassing || len(got[0].CI.FailingChecks) != 0 {
		t.Fatalf("ci summary = %+v", got[0].CI)
	}
}

func TestListPRSummariesFiltersFailedChecksToCurrentHead(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker}
	prURL := "https://github.com/acme/repo/pull/9"
	stList := &multiPRFakeStore{fakeStore: st, prs: []domain.PullRequest{{
		URL:       prURL,
		SessionID: "mer-1",
		Number:    9,
		CI:        domain.CIFailing,
		HeadSHA:   "new-sha",
		UpdatedAt: time.Date(2026, 6, 4, 12, 0, 0, 0, time.UTC),
	}}}
	stList.checks[prURL] = []domain.PullRequestCheck{
		{Name: "old-copy-check", CommitHash: "old-sha", Status: domain.PRCheckFailed, Conclusion: "failure"},
		{Name: "current-lint", CommitHash: "new-sha", Status: domain.PRCheckFailed, Conclusion: "failure"},
	}

	got, err := (&Service{store: stList}).ListPRSummaries(context.Background(), "mer-1")
	if err != nil {
		t.Fatal(err)
	}
	checks := got[0].CI.FailingChecks
	if len(checks) != 1 || checks[0].Name != "current-lint" {
		t.Fatalf("failing checks = %+v", checks)
	}
}

func TestListPRSummariesSuppressesActiveDetailsForClosedOrMergedPRs(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker}
	prURL := "https://github.com/acme/repo/pull/10"
	stList := &multiPRFakeStore{fakeStore: st, prs: []domain.PullRequest{{
		URL:                      prURL,
		SessionID:                "mer-1",
		Number:                   10,
		Merged:                   true,
		CI:                       domain.CIFailing,
		Review:                   domain.ReviewChangesRequest,
		Mergeability:             domain.MergeConflicting,
		ProviderMergeStateStatus: "dirty",
		UpdatedAt:                time.Date(2026, 6, 4, 12, 0, 0, 0, time.UTC),
	}}}
	stList.checks[prURL] = []domain.PullRequestCheck{{Name: "unit", Status: domain.PRCheckFailed}}
	stList.comments[prURL] = []domain.PullRequestComment{{Author: "reviewer-a", File: "main.go", Line: 12, URL: "https://github.com/acme/repo/pull/10#discussion_r1"}}

	got, err := (&Service{store: stList}).ListPRSummaries(context.Background(), "mer-1")
	if err != nil {
		t.Fatal(err)
	}
	pr := got[0]
	if pr.State != domain.PRStateMerged {
		t.Fatalf("state = %q", pr.State)
	}
	if len(pr.CI.FailingChecks) != 0 || len(pr.Review.UnresolvedBy) != 0 || len(pr.Mergeability.Reasons) != 0 {
		t.Fatalf("active details should be suppressed for merged PR: ci=%+v review=%+v merge=%+v", pr.CI, pr.Review, pr.Mergeability)
	}
}

func TestListPRSummariesOnlyEmitsMergeReasonsForBlockedStates(t *testing.T) {
	st := newFakeStore()
	st.sessions["mer-1"] = domain.SessionRecord{ID: "mer-1", ProjectID: "mer", Kind: domain.KindWorker}
	now := time.Date(2026, 6, 4, 12, 0, 0, 0, time.UTC)
	stList := &multiPRFakeStore{fakeStore: st, prs: []domain.PullRequest{
		{
			URL:                      "mergeable",
			SessionID:                "mer-1",
			Number:                   11,
			CI:                       domain.CIFailing,
			Review:                   domain.ReviewRequired,
			Mergeability:             domain.MergeMergeable,
			ProviderMergeStateStatus: "behind",
			UpdatedAt:                now,
		},
		{
			URL:                      "blocked",
			SessionID:                "mer-1",
			Number:                   12,
			Review:                   domain.ReviewRequired,
			Mergeability:             domain.MergeBlocked,
			ProviderMergeStateStatus: "behind",
			UpdatedAt:                now.Add(time.Minute),
		},
	}}

	got, err := (&Service{store: stList}).ListPRSummaries(context.Background(), "mer-1")
	if err != nil {
		t.Fatal(err)
	}
	byNumber := map[int]PRSummary{}
	for _, pr := range got {
		byNumber[pr.Number] = pr
	}
	if reasons := byNumber[11].Mergeability.Reasons; len(reasons) != 0 {
		t.Fatalf("mergeable reasons = %+v", reasons)
	}
	if reasons := byNumber[12].Mergeability.Reasons; !containsString(reasons, "behind_base") || !containsString(reasons, "review_required") {
		t.Fatalf("blocked reasons = %+v", reasons)
	}
}

type multiPRFakeStore struct {
	*fakeStore
	prs []domain.PullRequest
}

func (f *multiPRFakeStore) ListPRsBySession(context.Context, domain.SessionID) ([]domain.PullRequest, error) {
	return f.prs, nil
}

func containsString(values []string, want string) bool {
	for _, got := range values {
		if got == want {
			return true
		}
	}
	return false
}
