package testgate

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type fakeManagerStore struct {
	session      domain.SessionRecord
	baseline     TestRun
	hasBaseline  bool
	findings     []ReviewFinding
	insertedRuns []TestRun
	insertedEv   []TestEvidence
	fused        FusedVerdict
	fusedUpserts int

	validateEvidence bool
}

func (f *fakeManagerStore) GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error) {
	if f.session.ID == "" {
		return domain.SessionRecord{}, false, nil
	}
	return f.session, true, nil
}

func (f *fakeManagerStore) InsertTestGateRun(_ context.Context, run TestRun) error {
	f.insertedRuns = append(f.insertedRuns, run)
	return nil
}

func (f *fakeManagerStore) GetLatestTestGateRun(context.Context, domain.SessionID, string, string, RunKind) (TestRun, bool, error) {
	return f.baseline, f.hasBaseline, nil
}

func (f *fakeManagerStore) ListReviewFindingsByRun(context.Context, string) ([]ReviewFinding, error) {
	return append([]ReviewFinding(nil), f.findings...), nil
}

func (f *fakeManagerStore) InsertTestEvidence(_ context.Context, evidence TestEvidence) error {
	if f.validateEvidence {
		knownFinding := false
		for _, finding := range f.findings {
			if finding.ID == evidence.FindingID {
				knownFinding = true
				break
			}
		}
		if !knownFinding {
			return errors.New("foreign key mismatch")
		}
		switch evidence.Outcome {
		case EvidenceOutcomeUntested, EvidenceOutcomeConfirmed, EvidenceOutcomeRefuted:
		default:
			return errors.New("invalid evidence outcome")
		}
		if len(f.insertedRuns) > 0 && evidence.TestRunID != f.insertedRuns[len(f.insertedRuns)-1].ID {
			return errors.New("foreign key test run mismatch")
		}
	}
	f.insertedEv = append(f.insertedEv, evidence)
	return nil
}

func (f *fakeManagerStore) ListTestEvidenceByTestRun(context.Context, string) ([]TestEvidence, error) {
	return append([]TestEvidence(nil), f.insertedEv...), nil
}

func (f *fakeManagerStore) UpsertFusedVerdict(_ context.Context, verdict FusedVerdict) error {
	f.fused = verdict
	f.fusedUpserts++
	return nil
}

type fakeRunner struct {
	requests []RunRequest
	result   RunResult
	err      error
}

func (f *fakeRunner) Run(_ context.Context, req RunRequest) (RunResult, error) {
	f.requests = append(f.requests, req)
	return f.result, f.err
}

func TestManagerRunBaselineExecutesRunnerAndStoresRun(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	st := &fakeManagerStore{}
	runner := &fakeRunner{result: RunResult{Run: TestRun{
		Classification: ClassificationPassed,
		Summary:        "smoke passed",
		Artifacts:      []string{"trace.zip"},
	}}}
	m := NewManager(ManagerDeps{
		Store: st, Runner: runner,
		Clock: func() time.Time { return now },
		NewID: func() string { return "test-run-1" },
	})
	reviewRun := domain.ReviewRun{ID: "review-run-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1"}

	run, ok, err := m.RunBaseline(context.Background(), reviewRun)
	if err != nil || !ok {
		t.Fatalf("RunBaseline ok=%v err=%v", ok, err)
	}
	if len(runner.requests) != 1 || runner.requests[0].Kind != RunKindBaseline || runner.requests[0].ReviewRun.ID != "review-run-1" {
		t.Fatalf("requests = %+v", runner.requests)
	}
	if run.ID != "test-run-1" || run.SessionID != "mer-1" || run.ReviewRunID != "review-run-1" || run.Kind != RunKindBaseline || !run.CreatedAt.Equal(now) {
		t.Fatalf("run = %+v", run)
	}
	if len(st.insertedRuns) != 1 || st.insertedRuns[0].Artifacts[0] != "trace.zip" {
		t.Fatalf("inserted runs = %+v", st.insertedRuns)
	}
}

func TestManagerRunBaselinePassesWorkspacePathToRunner(t *testing.T) {
	st := &fakeManagerStore{session: domain.SessionRecord{ID: "mer-1", Metadata: domain.SessionMetadata{WorkspacePath: "/repo/worktree"}}}
	runner := &fakeRunner{result: RunResult{Run: TestRun{Classification: ClassificationPassed}}}
	m := NewManager(ManagerDeps{
		Store: st, Runner: runner,
		NewID: func() string { return "test-run-1" },
	})

	if _, ok, err := m.RunBaseline(context.Background(), domain.ReviewRun{ID: "review-run-1", SessionID: "mer-1"}); err != nil || !ok {
		t.Fatalf("RunBaseline ok=%v err=%v", ok, err)
	}
	if len(runner.requests) != 1 || runner.requests[0].WorkspacePath != "/repo/worktree" {
		t.Fatalf("requests = %+v", runner.requests)
	}
}

func TestManagerRunBaselineStoresInfraWhenRunnerFails(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	st := &fakeManagerStore{}
	runner := &fakeRunner{err: errors.New("daytona unavailable")}
	m := NewManager(ManagerDeps{
		Store: st, Runner: runner,
		Clock: func() time.Time { return now },
		NewID: func() string { return "test-run-1" },
	})
	reviewRun := domain.ReviewRun{ID: "review-run-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1"}

	run, ok, err := m.RunBaseline(context.Background(), reviewRun)
	if err != nil || !ok {
		t.Fatalf("RunBaseline ok=%v err=%v", ok, err)
	}
	if run.Classification != ClassificationInfra {
		t.Fatalf("classification = %q, want %q", run.Classification, ClassificationInfra)
	}
	if len(st.insertedRuns) != 1 || st.insertedRuns[0].Classification != ClassificationInfra {
		t.Fatalf("inserted runs = %+v", st.insertedRuns)
	}
}

func TestManagerRunAfterReviewSubmitRunsTargetedAndWritesFusedVerdict(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	st := &fakeManagerStore{
		hasBaseline: true,
		baseline:    TestRun{ID: "baseline-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1", Kind: RunKindBaseline, Classification: ClassificationPassed},
		findings: []ReviewFinding{{
			ID:         "finding-1",
			RunID:      "review-run-1",
			Severity:   SeverityHigh,
			Title:      "route fails",
			Claim:      "route returns 500",
			Behavioral: true,
		}},
	}
	runner := &fakeRunner{result: RunResult{
		Run: TestRun{Classification: ClassificationPassed, Summary: "targeted repro passed"},
		Evidence: []TestEvidence{{
			FindingID: "finding-1",
			Outcome:   EvidenceOutcomeConfirmed,
			Summary:   "targeted repro returned 500",
		}},
	}}
	ids := []string{"targeted-run-1", "evidence-1", "fused-1"}
	m := NewManager(ManagerDeps{
		Store: st, Runner: runner,
		Clock: func() time.Time { return now },
		NewID: func() string {
			id := ids[0]
			ids = ids[1:]
			return id
		},
	})
	reviewRun := domain.ReviewRun{ID: "review-run-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1", Verdict: domain.VerdictChangesRequested}

	fused, ok, err := m.RunAfterReviewSubmit(context.Background(), reviewRun)
	if err != nil || !ok {
		t.Fatalf("RunAfterReviewSubmit ok=%v err=%v", ok, err)
	}
	if len(runner.requests) != 1 || runner.requests[0].Kind != RunKindTargeted || len(runner.requests[0].Findings) != 1 {
		t.Fatalf("requests = %+v", runner.requests)
	}
	if len(st.insertedRuns) != 1 || st.insertedRuns[0].ID != "targeted-run-1" || st.insertedRuns[0].Kind != RunKindTargeted {
		t.Fatalf("inserted runs = %+v", st.insertedRuns)
	}
	if len(st.insertedEv) != 1 || st.insertedEv[0].ID != "evidence-1" || st.insertedEv[0].TestRunID != "targeted-run-1" {
		t.Fatalf("inserted evidence = %+v", st.insertedEv)
	}
	if fused.Outcome != FusedOutcomeChangesRequested || !fused.Blocking || fused.ID != "fused-1" || fused.TestRunID != "targeted-run-1" {
		t.Fatalf("fused = %+v", fused)
	}
	if st.fusedUpserts != 1 || st.fused.Outcome != FusedOutcomeChangesRequested {
		t.Fatalf("stored fused = %+v upserts=%d", st.fused, st.fusedUpserts)
	}
}

func TestManagerRunAfterReviewSubmitIgnoresMalformedEvidence(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	st := &fakeManagerStore{
		hasBaseline:      true,
		validateEvidence: true,
		baseline:         TestRun{ID: "baseline-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1", Kind: RunKindBaseline, Classification: ClassificationPassed},
		findings: []ReviewFinding{{
			ID:         "finding-1",
			RunID:      "review-run-1",
			Title:      "route fails",
			Behavioral: true,
		}},
	}
	runner := &fakeRunner{result: RunResult{
		Run: TestRun{Classification: ClassificationPassed, Summary: "targeted repro ran"},
		Evidence: []TestEvidence{
			{FindingID: "missing", Outcome: EvidenceOutcomeConfirmed, Summary: "unknown finding id"},
			{FindingID: "finding-1", Outcome: EvidenceOutcome("bogus"), Summary: "bad outcome"},
			{TestRunID: "other-run", FindingID: "finding-1", Outcome: EvidenceOutcomeRefuted, Summary: "targeted repro returned 200"},
		},
	}}
	ids := []string{"targeted-run-1", "evidence-1", "fused-1"}
	m := NewManager(ManagerDeps{
		Store: st, Runner: runner,
		Clock: func() time.Time { return now },
		NewID: func() string {
			id := ids[0]
			ids = ids[1:]
			return id
		},
	})
	reviewRun := domain.ReviewRun{ID: "review-run-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1", Verdict: domain.VerdictChangesRequested}

	fused, ok, err := m.RunAfterReviewSubmit(context.Background(), reviewRun)
	if err != nil || !ok {
		t.Fatalf("RunAfterReviewSubmit ok=%v err=%v", ok, err)
	}
	if len(st.insertedEv) != 1 || st.insertedEv[0].FindingID != "finding-1" || st.insertedEv[0].Outcome != EvidenceOutcomeRefuted {
		t.Fatalf("inserted evidence = %+v, want only valid refutation", st.insertedEv)
	}
	if fused.Outcome != FusedOutcomeApproved || fused.Blocking {
		t.Fatalf("fused = %+v, want runtime-approved non-blocking verdict", fused)
	}
}
