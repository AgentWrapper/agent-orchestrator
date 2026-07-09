package trackerintake

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestPollSpawnsWorkerForEligibleIssue(t *testing.T) {
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{
				Enabled:  true,
				Assignee: "alice",
			}},
		}},
	}
	tracker := &fakeTracker{issues: []domain.Issue{{
		ID:        domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#12"},
		Title:     "Fix login",
		Body:      "The login form submits twice.",
		State:     domain.IssueOpen,
		URL:       "https://github.com/acme/demo/issues/12",
		Labels:    []string{"agent-ready"},
		Assignees: []string{"alice"},
	}}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 1 {
		t.Fatalf("spawn calls = %d, want 1", len(spawner.calls))
	}
	call := spawner.calls[0]
	if call.ProjectID != "demo" || call.Kind != domain.KindWorker {
		t.Fatalf("spawn config = %+v", call)
	}
	if call.IssueID != "github:acme/demo#12" {
		t.Fatalf("IssueID = %q, want canonical github id", call.IssueID)
	}
	// The spawn prompt is the router invocation only (GH #118); issue context
	// (title, body) must NOT leak into it — the worker's skill reads the ticket.
	// The canonical id still rides along in the session's IssueID env, asserted
	// above.
	if want := "/address-issue 12"; call.Prompt != want {
		t.Fatalf("prompt = %q, want exactly %q", call.Prompt, want)
	}
	if len(tracker.filters) != 1 {
		t.Fatalf("tracker filters = %d, want 1", len(tracker.filters))
	}
	if got := tracker.filters[0]; got.State != domain.ListOpen || got.Assignee != "alice" || len(got.Labels) != 0 {
		t.Fatalf("tracker filter = %+v", got)
	}
}

func TestPollSkipsExistingIssueSessionsAfterRestart(t *testing.T) {
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "alice"}},
		}},
		sessions: []domain.SessionRecord{{ID: "demo-1", ProjectID: "demo", IssueID: "github:acme/demo#12"}},
	}
	tracker := &fakeTracker{issues: []domain.Issue{{
		ID:        domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#12"},
		Title:     "Already running",
		State:     domain.IssueOpen,
		Assignees: []string{"alice"},
	}}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 0 {
		t.Fatalf("spawn calls = %d, want 0", len(spawner.calls))
	}
}

func TestPollSkipsSessionScanWhenIntakeDisabled(t *testing.T) {
	store := &fakeStore{
		projects:    []domain.ProjectRecord{{ID: "demo"}},
		sessionsErr: errors.New("session scan should not run"),
	}

	if err := New(singleResolver(&fakeTracker{}), store, &fakeSpawner{}, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v, want nil", err)
	}
}

func TestPollSkipsIneligibleAndInvalidProjects(t *testing.T) {
	store := &fakeStore{
		projects: []domain.ProjectRecord{
			{ID: "off", RepoOriginURL: "https://github.com/acme/off.git"},
			// A "broad" project (enabled, no assignee) is no longer ineligible —
			// issue #80 made that a valid opt-out-by-default config. Its pickup
			// behavior is covered by TestPollAppliesDefaultOptOutLabels.
			{ID: "missing-origin", Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "alice"}}},
		},
	}
	tracker := &fakeTracker{issues: []domain.Issue{{
		ID:    domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/off#1"},
		Title: "ignored",
		State: domain.IssueOpen,
	}}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(tracker.repos) != 0 {
		t.Fatalf("tracker was called for invalid/off projects: %+v", tracker.repos)
	}
	if len(spawner.calls) != 0 {
		t.Fatalf("spawn calls = %d, want 0", len(spawner.calls))
	}
}

func TestPollContinuesAfterTrackerAndSpawnFailures(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{
		{ID: "bad", RepoOriginURL: "https://github.com/acme/bad.git", Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "alice"}}},
		{ID: "good", RepoOriginURL: "https://github.com/acme/good.git", Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "alice"}}},
	}}
	tracker := &fakeTracker{
		failRepos: map[string]error{"acme/bad": errors.New("rate limited")},
		issuesByRepo: map[string][]domain.Issue{
			"acme/good": {
				{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/good#1"}, Title: "first", State: domain.IssueOpen, Assignees: []string{"alice"}},
				{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/good#2"}, Title: "second", State: domain.IssueOpen, Assignees: []string{"alice"}},
			},
		},
	}
	spawner := &fakeSpawner{failIssue: domain.IssueID("github:acme/good#1")}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 2 {
		t.Fatalf("spawn attempts = %d, want 2", len(spawner.calls))
	}
	if spawner.calls[1].IssueID != "github:acme/good#2" {
		t.Fatalf("second spawn issue = %q", spawner.calls[1].IssueID)
	}
}

func TestPollBacksOffProjectAfterFailure(t *testing.T) {
	now := time.Date(2026, 6, 27, 10, 0, 0, 0, time.UTC)
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "alice"}},
	}}}
	tracker := &fakeTracker{failRepos: map[string]error{"acme/demo": errors.New("rate limited")}}
	observer := New(singleResolver(tracker), store, &fakeSpawner{}, Config{
		Clock:          func() time.Time { return now },
		FailureBackoff: time.Minute,
		Logger:         discardLogger(),
	})

	if err := observer.Poll(context.Background()); err != nil {
		t.Fatalf("first Poll() error = %v", err)
	}
	if len(tracker.repos) != 1 {
		t.Fatalf("tracker calls after first poll = %d, want 1", len(tracker.repos))
	}

	if err := observer.Poll(context.Background()); err != nil {
		t.Fatalf("second Poll() error = %v", err)
	}
	if len(tracker.repos) != 1 {
		t.Fatalf("tracker calls during backoff = %d, want still 1", len(tracker.repos))
	}

	now = now.Add(time.Minute + time.Nanosecond)
	if err := observer.Poll(context.Background()); err != nil {
		t.Fatalf("third Poll() error = %v", err)
	}
	if len(tracker.repos) != 2 {
		t.Fatalf("tracker calls after backoff = %d, want 2", len(tracker.repos))
	}
}

func TestPollSkipsNonOpenIssueStates(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "alice"}},
	}}}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "already active", State: domain.IssueInProgress, Assignees: []string{"alice"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "ready", State: domain.IssueOpen, Assignees: []string{"alice"}},
	}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 1 || spawner.calls[0].IssueID != "github:acme/demo#2" {
		t.Fatalf("spawn calls = %+v, want only open issue #2", spawner.calls)
	}
}

func TestPollAppliesLocalEligibilityFilter(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, Assignee: "alice"}},
	}}}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "unassigned", State: domain.IssueOpen},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "wrong assignee", State: domain.IssueOpen, Assignees: []string{"bob"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#3"}, Title: "eligible", State: domain.IssueOpen, Labels: []string{"Agent-Ready"}, Assignees: []string{"Alice"}},
	}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 1 || spawner.calls[0].IssueID != "github:acme/demo#3" {
		t.Fatalf("spawn calls = %+v, want only eligible issue #3", spawner.calls)
	}
}

func TestIssueMatchesConfigAssigneeSpecialValues(t *testing.T) {
	assigned := domain.Issue{Assignees: []string{"alice"}}
	unassigned := domain.Issue{}
	if !issueMatchesConfig(assigned, domain.TrackerIntakeConfig{Assignee: "*"}) {
		t.Fatal("assigned issue should match assignee=*")
	}
	if issueMatchesConfig(unassigned, domain.TrackerIntakeConfig{Assignee: "*"}) {
		t.Fatal("unassigned issue should not match assignee=*")
	}
	if !issueMatchesConfig(unassigned, domain.TrackerIntakeConfig{Assignee: "none"}) {
		t.Fatal("unassigned issue should match assignee=none")
	}
	if issueMatchesConfig(assigned, domain.TrackerIntakeConfig{Assignee: "none"}) {
		t.Fatal("assigned issue should not match assignee=none")
	}
}

func TestIssueMatchesConfigLabelFilters(t *testing.T) {
	withLabels := func(labels ...string) domain.Issue {
		return domain.Issue{Assignees: []string{"alice"}, Labels: labels}
	}
	// Include rule: only issues carrying an included label match.
	includeCfg := domain.TrackerIntakeConfig{Assignee: "alice", Labels: []string{"agent-ok"}}
	if !issueMatchesConfig(withLabels("Agent-OK"), includeCfg) {
		t.Fatal("issue with included label (case-insensitive) should match")
	}
	if issueMatchesConfig(withLabels("other"), includeCfg) {
		t.Fatal("issue without any included label should not match")
	}
	if issueMatchesConfig(withLabels(), includeCfg) {
		t.Fatal("issue with no labels should not match an include rule")
	}
	// Exclude rule wins over everything else.
	excludeCfg := domain.TrackerIntakeConfig{Assignee: "alice", ExcludeLabels: []string{"agent:noauto"}}
	if issueMatchesConfig(withLabels("Agent:NoAuto"), excludeCfg) {
		t.Fatal("issue with excluded label should never match")
	}
	if !issueMatchesConfig(withLabels("something"), excludeCfg) {
		t.Fatal("issue without the excluded label should match")
	}
	// Exclusion beats inclusion when both apply.
	bothCfg := domain.TrackerIntakeConfig{Assignee: "alice", Labels: []string{"agent-ok"}, ExcludeLabels: []string{"agent:noauto"}}
	if issueMatchesConfig(withLabels("agent-ok", "agent:noauto"), bothCfg) {
		t.Fatal("exclusion must win over inclusion")
	}
	if !issueMatchesConfig(withLabels("agent-ok"), bothCfg) {
		t.Fatal("included-only issue should match when not excluded")
	}
}

func TestPollAppliesLabelFilters(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{
			Enabled:       true,
			Assignee:      "alice",
			Labels:        []string{"agent-ok"},
			ExcludeLabels: []string{"agent:noauto"},
		}},
	}}}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "no included label", State: domain.IssueOpen, Assignees: []string{"alice"}, Labels: []string{"chore"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "excluded", State: domain.IssueOpen, Assignees: []string{"alice"}, Labels: []string{"agent-ok", "agent:noauto"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#3"}, Title: "eligible", State: domain.IssueOpen, Assignees: []string{"alice"}, Labels: []string{"Agent-OK"}},
	}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 1 || spawner.calls[0].IssueID != "github:acme/demo#3" {
		t.Fatalf("spawn calls = %+v, want only eligible issue #3", spawner.calls)
	}
}

func TestPollHonorsMaxConcurrentAgainstLiveWorkers(t *testing.T) {
	// One live worker already exists; cap is 2, so only ONE more may spawn even
	// though two more issues are eligible.
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{
				Enabled:       true,
				Assignee:      "alice",
				MaxConcurrent: 2,
			}},
		}},
		sessions: []domain.SessionRecord{
			{ID: "demo-live", ProjectID: "demo", Kind: domain.KindWorker, IssueID: "github:acme/demo#100"},
		},
	}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "first", State: domain.IssueOpen, Assignees: []string{"alice"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "second", State: domain.IssueOpen, Assignees: []string{"alice"}},
	}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 1 {
		t.Fatalf("spawn calls = %d, want 1 (cap of 2 minus 1 live worker)", len(spawner.calls))
	}
	if spawner.calls[0].IssueID != "github:acme/demo#1" {
		t.Fatalf("first spawn issue = %q, want github:acme/demo#1", spawner.calls[0].IssueID)
	}
}

func TestPollDefersNormalIssuesWhenAlreadyAtMaxConcurrent(t *testing.T) {
	// Two live cap-consuming workers already exist and the cap is 2: normal issues are
	// deferred. The tracker is still queried so later nopool issues in the result
	// set can escape the cap.
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{
				Enabled:       true,
				Assignee:      "alice",
				MaxConcurrent: 2,
			}},
		}},
		sessions: []domain.SessionRecord{
			{ID: "demo-a", ProjectID: "demo", Kind: domain.KindWorker, IssueID: "github:acme/demo#100"},
			{ID: "demo-b", ProjectID: "demo", Kind: domain.KindWorker, IssueID: "github:acme/demo#101"},
		},
	}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "eligible", State: domain.IssueOpen, Assignees: []string{"alice"}},
	}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 0 {
		t.Fatalf("spawn calls = %d, want 0 (already at cap)", len(spawner.calls))
	}
	if len(tracker.repos) != 1 {
		t.Fatalf("tracker queried %d times, want 1 so nopool issues can be discovered", len(tracker.repos))
	}
}

func TestPollDefersWithoutBackoffWhenSpawnHitsConcurrencyCap(t *testing.T) {
	now := time.Date(2026, 7, 8, 10, 0, 0, 0, time.UTC)
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{
				Enabled:       true,
				Assignee:      "alice",
				MaxConcurrent: 1,
			}},
		}},
	}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "first", State: domain.IssueOpen, Assignees: []string{"alice"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "second", State: domain.IssueOpen, Assignees: []string{"alice"}},
	}}
	spawner := &fakeSpawner{
		failErrByIssue: map[domain.IssueID]error{
			"github:acme/demo#1": apierr.Conflict("WORKER_CONCURRENCY_CAP", "session: worker concurrency cap reached", nil),
		},
	}
	observer := New(singleResolver(tracker), store, spawner, Config{
		Clock:          func() time.Time { return now },
		FailureBackoff: time.Hour,
		Logger:         discardLogger(),
	})

	if err := observer.Poll(context.Background()); err != nil {
		t.Fatalf("first Poll() error = %v", err)
	}
	if len(spawner.calls) != 1 {
		t.Fatalf("spawn calls = %d, want 1 cap collision then defer", len(spawner.calls))
	}
	if len(tracker.repos) != 1 {
		t.Fatalf("tracker calls after first poll = %d, want 1", len(tracker.repos))
	}

	if err := observer.Poll(context.Background()); err != nil {
		t.Fatalf("second Poll() error = %v", err)
	}
	if len(tracker.repos) != 2 {
		t.Fatalf("tracker calls after second poll = %d, want 2 (cap collision must not enter failure backoff)", len(tracker.repos))
	}
}

func TestLiveWorkersByProjectIgnoresTerminatedAndNonWorkers(t *testing.T) {
	sessions := []domain.SessionRecord{
		{ID: "a", ProjectID: "demo", Kind: domain.KindWorker, IssueID: "github:acme/demo#1"},
		{ID: "b", ProjectID: "demo", Kind: domain.KindWorker, IssueID: "github:acme/demo#2", IsTerminated: true},
		{ID: "c", ProjectID: "demo", Kind: domain.KindOrchestrator, IssueID: "github:acme/demo#3"},
		{ID: "d", ProjectID: "demo", Kind: domain.KindWorker},
		{ID: "manual", ProjectID: "demo", Kind: domain.KindWorker, IssueID: "47"},
		{ID: "urgent", ProjectID: "demo", Kind: domain.KindWorker, IssueID: "github:acme/demo#4", Metadata: domain.SessionMetadata{IntakePoolBypass: true}},
		{ID: "e", ProjectID: "other", Kind: domain.KindWorker, IssueID: "github:acme/other#1"},
	}
	counts := liveWorkersByProject(sessions)
	if counts["demo"] != 3 {
		t.Fatalf("demo cap-consuming live workers = %d, want 3 (nopool sessions do not consume cap)", counts["demo"])
	}
	if counts["other"] != 1 {
		t.Fatalf("other live workers = %d, want 1", counts["other"])
	}
}

// TestBuildIssuePromptIsRouterInvocationOnly pins the permanent contract from
// GH #118: an intake-spawned worker is handed EXACTLY `/address-issue <id>` and
// nothing else. The router reads the issue itself, so no title/url/labels/body
// dump and no "implement the change" footer may leak into the prompt — even for
// a huge issue body that the old code would have truncated and appended.
func TestBuildIssuePromptIsRouterInvocationOnly(t *testing.T) {
	prompt := BuildIssuePrompt(domain.Issue{
		ID:     domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#118"},
		Title:  "Large issue",
		URL:    "https://github.com/acme/demo/issues/118",
		Labels: []string{"feature"},
		Body:   strings.Repeat("body ", 2000),
	})
	if want := "/address-issue 118"; prompt != want {
		t.Fatalf("prompt = %q, want exactly %q", prompt, want)
	}
}

// TestBuildIssuePromptRefFallsBackToNative covers a native id that carries no
// "#N" suffix: the whole trimmed native is used verbatim so the worker still
// gets a resolvable reference rather than an empty argument.
func TestBuildIssuePromptRefFallsBackToNative(t *testing.T) {
	prompt := BuildIssuePrompt(domain.Issue{
		ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "  bare-id  "},
	})
	if want := "/address-issue bare-id"; prompt != want {
		t.Fatalf("prompt = %q, want exactly %q", prompt, want)
	}
}

func TestTrackerRepoUsesConfiguredRepo(t *testing.T) {
	project := domain.ProjectRecord{
		ID:            "demo",
		RepoOriginURL: "https://github.com/wrong/repo.git",
		Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{
			Enabled:  true,
			Repo:     "acme/demo",
			Assignee: "alice",
		}},
	}
	repo, ok := trackerRepo(project, project.Config.TrackerIntake.WithDefaults())
	if !ok {
		t.Fatal("trackerRepo ok = false")
	}
	if repo.Native != "acme/demo" {
		t.Fatalf("repo.Native = %q, want acme/demo", repo.Native)
	}
}

func singleResolver(tracker ports.Tracker) TrackerResolver {
	return SingleTrackerResolver{Provider: domain.TrackerProviderGitHub, Adapter: tracker}
}

type fakeStore struct {
	projects    []domain.ProjectRecord
	sessions    []domain.SessionRecord
	sessionsErr error
}

func (f *fakeStore) ListProjects(context.Context) ([]domain.ProjectRecord, error) {
	return append([]domain.ProjectRecord(nil), f.projects...), nil
}

func (f *fakeStore) ListAllSessions(context.Context) ([]domain.SessionRecord, error) {
	return append([]domain.SessionRecord(nil), f.sessions...), f.sessionsErr
}

type fakeTracker struct {
	issues       []domain.Issue
	issuesByRepo map[string][]domain.Issue
	failRepos    map[string]error
	repos        []domain.TrackerRepo
	filters      []domain.ListFilter
}

func (f *fakeTracker) Get(context.Context, domain.TrackerID) (domain.Issue, error) {
	return domain.Issue{}, nil
}

func (f *fakeTracker) List(_ context.Context, repo domain.TrackerRepo, filter domain.ListFilter) ([]domain.Issue, error) {
	f.repos = append(f.repos, repo)
	f.filters = append(f.filters, filter)
	if err := f.failRepos[repo.Native]; err != nil {
		return nil, err
	}
	if f.issuesByRepo != nil {
		return append([]domain.Issue(nil), f.issuesByRepo[repo.Native]...), nil
	}
	return append([]domain.Issue(nil), f.issues...), nil
}

func (f *fakeTracker) Preflight(context.Context) error { return nil }

type fakeSpawner struct {
	calls          []ports.SpawnConfig
	failIssue      domain.IssueID
	failErrByIssue map[domain.IssueID]error
}

func (f *fakeSpawner) Spawn(_ context.Context, cfg ports.SpawnConfig) (domain.Session, error) {
	f.calls = append(f.calls, cfg)
	if err := f.failErrByIssue[cfg.IssueID]; err != nil {
		return domain.Session{}, err
	}
	if cfg.IssueID == f.failIssue {
		return domain.Session{}, errors.New("spawn failed")
	}
	return domain.Session{SessionRecord: domain.SessionRecord{ID: domain.SessionID(string(cfg.ProjectID) + "-1"), ProjectID: cfg.ProjectID, IssueID: cfg.IssueID, Kind: cfg.Kind}}, nil
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// TestIssueMatchesConfigExcludePrefix covers the scoped-label prefix rule from
// issue #80: an exclude entry "charter" opts out the whole charter:* family
// (charter, charter:C03) without enumerating each one, while a distinct label
// like charter-audit (hyphen, not colon) is NOT swept up by the "charter"
// prefix — it must be listed separately.
func TestIssueMatchesConfigExcludePrefix(t *testing.T) {
	withLabels := func(labels ...string) domain.Issue {
		return domain.Issue{Assignees: []string{"alice"}, Labels: labels}
	}
	cfg := domain.TrackerIntakeConfig{Assignee: "alice", ExcludeLabels: []string{"charter"}}

	if issueMatchesConfig(withLabels("charter"), cfg) {
		t.Fatal("exact label charter should be excluded")
	}
	if issueMatchesConfig(withLabels("charter:C03"), cfg) {
		t.Fatal("scoped label charter:C03 should be excluded by the charter prefix")
	}
	if issueMatchesConfig(withLabels("Charter:C03"), cfg) {
		t.Fatal("prefix match must be case-insensitive")
	}
	if !issueMatchesConfig(withLabels("charter-audit"), cfg) {
		t.Fatal("charter-audit (hyphen) must NOT be swept up by the charter: prefix")
	}
	if !issueMatchesConfig(withLabels("chartering"), cfg) {
		t.Fatal("chartering must NOT match the charter prefix (prefix requires a ':' boundary)")
	}

	// Multi-segment entries keep their full scope: "agent:noauto" excludes
	// "agent:noauto:beta" but a bare "agent" scope must not.
	multi := domain.TrackerIntakeConfig{Assignee: "alice", ExcludeLabels: []string{"agent:noauto"}}
	if issueMatchesConfig(withLabels("agent:noauto:beta"), multi) {
		t.Fatal("agent:noauto must exclude the agent:noauto:* family")
	}
	if !issueMatchesConfig(withLabels("agent:other"), multi) {
		t.Fatal("agent:noauto must NOT exclude a different agent:* scope")
	}
}

// TestIssueHasExcludedLabelFoldConsistency locks that the exact-match and
// scoped-prefix-match paths fold identically. The long-s (ſ) folds to "s" under
// EqualFold, so an entry "scope" must exclude both "ſcope" (exact) and "ſcope:x"
// (scoped prefix) — the two case-insensitive paths cannot disagree.
func TestIssueHasExcludedLabelFoldConsistency(t *testing.T) {
	if !issueHasExcludedLabel([]string{"ſcope"}, "scope") {
		t.Fatal("exact fold match should hold for ſcope vs scope")
	}
	if !issueHasExcludedLabel([]string{"ſcope:x"}, "scope") {
		t.Fatal("scoped-prefix fold match should hold for ſcope:x vs scope")
	}
}

// TestPollAppliesDefaultOptOutLabels proves opt-out-by-default: a project that
// enables intake without configuring ExcludeLabels still skips issues carrying
// any of the default opt-out labels, and works everything else.
func TestPollAppliesDefaultOptOutLabels(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		// No Assignee, no ExcludeLabels: pure opt-out-by-default.
		Config: domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true}},
	}}}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "opted out", State: domain.IssueOpen, Labels: []string{"no-ao"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "charter family", State: domain.IssueOpen, Labels: []string{"charter:C03"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#3"}, Title: "deferred", State: domain.IssueOpen, Labels: []string{"deferred"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#4"}, Title: "plain unlabeled", State: domain.IssueOpen},
	}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	// #1 no-ao, #2 charter:C03 (prefix), #3 deferred are all default opt-outs;
	// only the unlabeled #4 is worked.
	if len(spawner.calls) != 1 || spawner.calls[0].IssueID != "github:acme/demo#4" {
		t.Fatalf("spawn calls = %+v, want only the unlabeled issue #4", spawner.calls)
	}
}

// TestPollPicksUpSensitiveUnlabeledIssue locks the two-gates rule from #80:
// "sensitive" lives ONLY at the merge gate and NEVER at the work gate. An issue
// describing sensitive-path work is picked up and worked exactly like any other
// unlabeled issue; parking for a human happens later at merge, not here.
func TestPollPicksUpSensitiveUnlabeledIssue(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true}},
	}}}
	tracker := &fakeTracker{issues: []domain.Issue{{
		ID:    domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#7"},
		Title: "Refactor backend/internal/daemon session lifecycle",
		Body:  "Touches backend/internal/session_manager and backend/internal/lifecycle.",
		State: domain.IssueOpen,
	}}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 1 || spawner.calls[0].IssueID != "github:acme/demo#7" {
		t.Fatalf("sensitive-but-unlabeled issue must be picked up; spawn calls = %+v", spawner.calls)
	}
}

// mixIssues builds n open, eligible issues for a repo.
func mixIssues(repo string, n int) []domain.Issue {
	issues := make([]domain.Issue, 0, n)
	for i := 1; i <= n; i++ {
		issues = append(issues, domain.Issue{
			ID:    domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: fmt.Sprintf("%s#%d", repo, i)},
			Title: fmt.Sprintf("issue %d", i),
			State: domain.IssueOpen,
		})
	}
	return issues
}

// TestPollWorkerMixConvergesWithinPass proves the acceptance criteria: with a
// weighted mix configured, intake picks a provider-matched harness+model per
// spawn (deficit-based) so the realized distribution over a single pass matches
// the target apportionment (60/30/10 over 10 spawns -> 6/3/1). It also confirms
// the codex/fugu buckets carry no explicit model (the manager resolves the
// provider default) while the claude bucket carries its pinned opus model — no
// claude model ever lands on a codex spawn.
func TestPollWorkerMixConvergesWithinPass(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config: domain.ProjectConfig{
			TrackerIntake: domain.TrackerIntakeConfig{Enabled: true},
			WorkerMix: domain.WorkerMix{
				{Harness: domain.HarnessCodex, Weight: 60},
				{Harness: domain.HarnessCodexFugu, Weight: 30},
				{Harness: domain.HarnessClaudeCode, Model: "opus", Weight: 10},
			},
		},
	}}}
	tracker := &fakeTracker{issues: mixIssues("acme/demo", 10)}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 10 {
		t.Fatalf("spawn calls = %d, want 10", len(spawner.calls))
	}
	counts := map[domain.AgentHarness]int{}
	models := map[domain.AgentHarness]string{}
	for _, c := range spawner.calls {
		counts[c.Harness]++
		models[c.Harness] = c.Model
	}
	want := map[domain.AgentHarness]int{
		domain.HarnessCodex:      6,
		domain.HarnessCodexFugu:  3,
		domain.HarnessClaudeCode: 1,
	}
	for h, w := range want {
		if counts[h] != w {
			t.Fatalf("harness %s = %d, want %d (all=%v)", h, counts[h], w, counts)
		}
	}
	if models[domain.HarnessClaudeCode] != "opus" {
		t.Fatalf("claude bucket model = %q, want opus", models[domain.HarnessClaudeCode])
	}
	if models[domain.HarnessCodex] != "" {
		t.Fatalf("codex bucket model = %q, want empty (manager resolves provider default)", models[domain.HarnessCodex])
	}
	if models[domain.HarnessCodexFugu] != "" {
		t.Fatalf("fugu bucket model = %q, want empty (manager resolves provider default)", models[domain.HarnessCodexFugu])
	}
}

// TestPollWorkerMixBiasesTowardUnderservedBucket proves selection is
// deficit-based against the ALREADY-running fleet, not a fresh count: with a
// 50/50 mix and two codex workers already live, the next two intake spawns both
// go to fugu to rebalance toward the target ratio.
func TestPollWorkerMixBiasesTowardUnderservedBucket(t *testing.T) {
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config: domain.ProjectConfig{
				TrackerIntake: domain.TrackerIntakeConfig{Enabled: true},
				WorkerMix: domain.WorkerMix{
					{Harness: domain.HarnessCodex, Weight: 50},
					{Harness: domain.HarnessCodexFugu, Weight: 50},
				},
			},
		}},
		sessions: []domain.SessionRecord{
			{ID: "demo-1", ProjectID: "demo", Kind: domain.KindWorker, Harness: domain.HarnessCodex},
			{ID: "demo-2", ProjectID: "demo", Kind: domain.KindWorker, Harness: domain.HarnessCodex},
		},
	}
	tracker := &fakeTracker{issues: mixIssues("acme/demo", 2)}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 2 {
		t.Fatalf("spawn calls = %d, want 2", len(spawner.calls))
	}
	for i, c := range spawner.calls {
		if c.Harness != domain.HarnessCodexFugu {
			t.Fatalf("spawn %d harness = %q, want fugu (rebalancing against 2 live codex)", i, c.Harness)
		}
	}
}

// TestPollWorkerMixRespectsConcurrencyCap proves the cap (#49) still bounds the
// mixed spawns: with maxConcurrent=2 and no live workers, only two of the four
// eligible issues spawn this pass, and both come from the mix.
func TestPollWorkerMixRespectsConcurrencyCap(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config: domain.ProjectConfig{
			TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, MaxConcurrent: 2},
			WorkerMix: domain.WorkerMix{
				{Harness: domain.HarnessCodex, Weight: 50},
				{Harness: domain.HarnessCodexFugu, Weight: 50},
			},
		},
	}}}
	tracker := &fakeTracker{issues: mixIssues("acme/demo", 4)}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 2 {
		t.Fatalf("spawn calls = %d, want 2 (cap)", len(spawner.calls))
	}
	for i, c := range spawner.calls {
		if c.Harness == "" {
			t.Fatalf("spawn %d harness empty; mix must have selected one", i)
		}
	}
}

func TestPollRoutingLabelOverridesWorkerMixWithinCap(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config: domain.ProjectConfig{
			TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, MaxConcurrent: 2},
			WorkerMix: domain.WorkerMix{
				{Harness: domain.HarnessCodex, Weight: 100},
			},
		},
	}}}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "pinned", State: domain.IssueOpen, Labels: []string{"agent:claude"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "mixed", State: domain.IssueOpen},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#3"}, Title: "capped", State: domain.IssueOpen},
	}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 2 {
		t.Fatalf("spawn calls = %d, want 2 within cap", len(spawner.calls))
	}
	if spawner.calls[0].Harness != domain.HarnessClaudeCode {
		t.Fatalf("pinned issue harness = %q, want claude-code", spawner.calls[0].Harness)
	}
	if spawner.calls[1].Harness != domain.HarnessCodex {
		t.Fatalf("mixed issue harness = %q, want codex", spawner.calls[1].Harness)
	}
}

func TestPollRoutingLabelCountsAgainstWorkerMixWithinPass(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config: domain.ProjectConfig{
			TrackerIntake: domain.TrackerIntakeConfig{Enabled: true},
			WorkerMix: domain.WorkerMix{
				{Harness: domain.HarnessCodex, Weight: 50},
				{Harness: domain.HarnessCodexFugu, Weight: 50},
			},
		},
	}}}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "pinned codex", State: domain.IssueOpen, Labels: []string{"agent:codex"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "mixed", State: domain.IssueOpen},
	}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 2 {
		t.Fatalf("spawn calls = %d, want 2", len(spawner.calls))
	}
	if spawner.calls[0].Harness != domain.HarnessCodex {
		t.Fatalf("pinned issue harness = %q, want codex", spawner.calls[0].Harness)
	}
	if spawner.calls[1].Harness != domain.HarnessCodexFugu {
		t.Fatalf("mixed issue harness = %q, want fugu because pinned codex consumed its bucket", spawner.calls[1].Harness)
	}
}

func TestPollNoPoolRoutingLabelCountsAgainstWorkerMixWithinPass(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config: domain.ProjectConfig{
			TrackerIntake: domain.TrackerIntakeConfig{Enabled: true},
			WorkerMix: domain.WorkerMix{
				{Harness: domain.HarnessCodex, Weight: 50},
				{Harness: domain.HarnessCodexFugu, Weight: 50},
			},
		},
	}}}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "urgent pinned codex", State: domain.IssueOpen, Labels: []string{"nopool", "agent:codex"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "mixed", State: domain.IssueOpen},
	}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 2 {
		t.Fatalf("spawn calls = %d, want 2", len(spawner.calls))
	}
	if spawner.calls[0].Harness != domain.HarnessCodex || !spawner.calls[0].IntakePoolBypass {
		t.Fatalf("nopool pinned issue = harness %q bypass %t, want codex bypass", spawner.calls[0].Harness, spawner.calls[0].IntakePoolBypass)
	}
	if spawner.calls[1].Harness != domain.HarnessCodexFugu {
		t.Fatalf("mixed issue harness = %q, want fugu because nopool pinned codex still counts for mix balance", spawner.calls[1].Harness)
	}
}

func TestPollNoPoolBypassesMaxConcurrentWithoutOpeningNormalCapacity(t *testing.T) {
	store := &fakeStore{
		projects: []domain.ProjectRecord{{
			ID:            "demo",
			RepoOriginURL: "https://github.com/acme/demo.git",
			Config: domain.ProjectConfig{
				TrackerIntake: domain.TrackerIntakeConfig{Enabled: true, MaxConcurrent: 1},
				WorkerMix:     domain.WorkerMix{{Harness: domain.HarnessCodex, Weight: 100}},
			},
		}},
		sessions: []domain.SessionRecord{
			{ID: "demo-live", ProjectID: "demo", Kind: domain.KindWorker, IssueID: "github:acme/demo#100"},
		},
	}
	tracker := &fakeTracker{issues: []domain.Issue{
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#1"}, Title: "normal capped", State: domain.IssueOpen},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#2"}, Title: "urgent", State: domain.IssueOpen, Labels: []string{"nopool", "agent:fugu"}},
		{ID: domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#3"}, Title: "normal still capped", State: domain.IssueOpen},
	}}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 1 {
		t.Fatalf("spawn calls = %d, want only the nopool issue despite cap", len(spawner.calls))
	}
	call := spawner.calls[0]
	if call.IssueID != "github:acme/demo#2" || call.Harness != domain.HarnessCodexFugu {
		t.Fatalf("nopool spawn = issue %q harness %q, want issue #2 on codex-fugu", call.IssueID, call.Harness)
	}
	if !call.IntakePoolBypass {
		t.Fatal("nopool spawn did not carry IntakePoolBypass")
	}
}

// TestPollNoMixKeepsSingleDefault proves back-compat: with no mix configured the
// spawn carries no harness/model, so the session manager resolves the single
// worker.agent default exactly as before.
func TestPollNoMixKeepsSingleDefault(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config:        domain.ProjectConfig{TrackerIntake: domain.TrackerIntakeConfig{Enabled: true}},
	}}}
	tracker := &fakeTracker{issues: mixIssues("acme/demo", 1)}
	spawner := &fakeSpawner{}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 1 {
		t.Fatalf("spawn calls = %d, want 1", len(spawner.calls))
	}
	if got := spawner.calls[0]; got.Harness != "" || got.Model != "" {
		t.Fatalf("no-mix spawn should carry no harness/model, got harness=%q model=%q", got.Harness, got.Model)
	}
}

// TestPollWorkerMixFailedSpawnDoesNotConsumeBucket proves a failed spawn does
// not shift the running distribution: when the first codex pick fails, the retry
// budget is not "used up" on that bucket — the next successful spawn still lands
// on the bucket the deficit selector would have chosen without the failure.
func TestPollWorkerMixFailedSpawnDoesNotConsumeBucket(t *testing.T) {
	store := &fakeStore{projects: []domain.ProjectRecord{{
		ID:            "demo",
		RepoOriginURL: "https://github.com/acme/demo.git",
		Config: domain.ProjectConfig{
			TrackerIntake: domain.TrackerIntakeConfig{Enabled: true},
			WorkerMix: domain.WorkerMix{
				{Harness: domain.HarnessCodex, Weight: 50},
				{Harness: domain.HarnessCodexFugu, Weight: 50},
			},
		},
	}}}
	// Issue #1 is picked first (codex, the earliest row on a tie) and fails; the
	// running count stays empty, so issue #2 must again pick codex.
	tracker := &fakeTracker{issues: mixIssues("acme/demo", 2)}
	spawner := &fakeSpawner{failIssue: domain.IssueID("github:acme/demo#1")}

	if err := New(singleResolver(tracker), store, spawner, Config{Logger: discardLogger()}).Poll(context.Background()); err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(spawner.calls) != 2 {
		t.Fatalf("spawn calls = %d, want 2 (both attempted)", len(spawner.calls))
	}
	if spawner.calls[0].Harness != domain.HarnessCodex {
		t.Fatalf("first pick = %q, want codex", spawner.calls[0].Harness)
	}
	if spawner.calls[1].Harness != domain.HarnessCodex {
		t.Fatalf("second pick = %q, want codex (failed spawn must not consume the codex bucket)", spawner.calls[1].Harness)
	}
}
