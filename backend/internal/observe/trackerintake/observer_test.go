package trackerintake

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
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
	if !strings.Contains(call.Prompt, "Fix login") || !strings.Contains(call.Prompt, "The login form submits twice.") {
		t.Fatalf("prompt missing issue context:\n%s", call.Prompt)
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
	// One live intake worker already exists; cap is 2, so only ONE more may spawn
	// even though two more issues are eligible.
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

func TestPollDefersWhenAlreadyAtMaxConcurrent(t *testing.T) {
	// Two live intake workers already exist and the cap is 2: no new spawn, and
	// the tracker is never even queried for this project.
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
	if len(tracker.repos) != 0 {
		t.Fatalf("tracker queried %d times, want 0 when already at cap", len(tracker.repos))
	}
}

func TestLiveIntakeWorkersByProjectIgnoresTerminatedAndNonWorkers(t *testing.T) {
	sessions := []domain.SessionRecord{
		{ID: "a", ProjectID: "demo", Kind: domain.KindWorker, IssueID: "github:acme/demo#1"},
		{ID: "b", ProjectID: "demo", Kind: domain.KindWorker, IssueID: "github:acme/demo#2", IsTerminated: true},
		{ID: "c", ProjectID: "demo", Kind: domain.KindOrchestrator, IssueID: "github:acme/demo#3"},
		{ID: "d", ProjectID: "demo", Kind: domain.KindWorker},                     // no issue id (ad-hoc worker)
		{ID: "manual", ProjectID: "demo", Kind: domain.KindWorker, IssueID: "47"}, // manual --issue, not intake-spawned
		{ID: "e", ProjectID: "other", Kind: domain.KindWorker, IssueID: "github:acme/other#1"},
	}
	counts := liveIntakeWorkersByProject(sessions)
	if counts["demo"] != 1 {
		t.Fatalf("demo live intake workers = %d, want 1", counts["demo"])
	}
	if counts["other"] != 1 {
		t.Fatalf("other live intake workers = %d, want 1", counts["other"])
	}
}

func TestBuildIssuePromptCapsLargeIssueBody(t *testing.T) {
	prompt := BuildIssuePrompt(domain.Issue{
		ID:    domain.TrackerID{Provider: domain.TrackerProviderGitHub, Native: "acme/demo#99"},
		Title: "Large issue",
		URL:   "https://github.com/acme/demo/issues/99",
		Body:  strings.Repeat("body ", 2000),
	})
	if len(prompt) > maxIntakePromptLen {
		t.Fatalf("prompt length = %d, want <= %d", len(prompt), maxIntakePromptLen)
	}
	if !strings.Contains(prompt, "Issue content truncated") {
		t.Fatalf("prompt missing truncation notice:\n%s", prompt)
	}
	if !strings.Contains(prompt, "https://github.com/acme/demo/issues/99") {
		t.Fatalf("prompt missing issue URL:\n%s", prompt)
	}
	if !strings.HasSuffix(prompt, intakePromptFooter) {
		t.Fatalf("prompt missing footer:\n%s", prompt)
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
	calls     []ports.SpawnConfig
	failIssue domain.IssueID
}

func (f *fakeSpawner) Spawn(_ context.Context, cfg ports.SpawnConfig) (domain.Session, error) {
	f.calls = append(f.calls, cfg)
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
