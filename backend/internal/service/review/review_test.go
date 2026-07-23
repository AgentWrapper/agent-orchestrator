package review

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/testgate"
)

type fakeStore struct {
	mu sync.Mutex

	run       domain.ReviewRun
	ok        bool
	batchRuns []domain.ReviewRun
	prs       []domain.PullRequest

	updateCalls   int
	markCalls     int
	markedIDs     []string
	findings      []testgate.ReviewFinding
	findingsByRun map[string][]testgate.ReviewFinding
	fused         map[string]testgate.FusedVerdict
}

func (f *fakeStore) GetReviewRun(_ context.Context, id string) (domain.ReviewRun, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, run := range f.batchRuns {
		if run.ID == id {
			return run, true, nil
		}
	}
	if f.ok && f.run.ID == id {
		return f.run, true, nil
	}
	return domain.ReviewRun{}, false, nil
}

func (f *fakeStore) UpdateReviewRunResult(_ context.Context, id string, status domain.ReviewRunStatus, verdict domain.ReviewVerdict, body, githubReviewID string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := range f.batchRuns {
		if f.batchRuns[i].ID == id {
			if f.batchRuns[i].Status != domain.ReviewRunRunning {
				return false, nil
			}
			f.updateCalls++
			f.batchRuns[i].Status = status
			f.batchRuns[i].Verdict = verdict
			f.batchRuns[i].Body = body
			f.batchRuns[i].GithubReviewID = githubReviewID
			if f.run.ID == id {
				f.run = f.batchRuns[i]
			}
			return true, nil
		}
	}
	if f.run.Status != domain.ReviewRunRunning {
		return false, nil
	}
	f.updateCalls++
	f.run.Status = status
	f.run.Verdict = verdict
	f.run.Body = body
	f.run.GithubReviewID = githubReviewID
	return true, nil
}

func (f *fakeStore) MarkReviewRunDelivered(_ context.Context, id string, deliveredAt time.Time) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.markCalls++
	f.markedIDs = append(f.markedIDs, id)
	if f.run.ID == id && f.run.Status == domain.ReviewRunComplete && f.run.DeliveredAt == nil {
		f.run.Status = domain.ReviewRunDelivered
		f.run.DeliveredAt = &deliveredAt
	}
	for i := range f.batchRuns {
		if f.batchRuns[i].ID == id && f.batchRuns[i].Status == domain.ReviewRunComplete && f.batchRuns[i].DeliveredAt == nil {
			f.batchRuns[i].Status = domain.ReviewRunDelivered
			f.batchRuns[i].DeliveredAt = &deliveredAt
			return true, nil
		}
	}
	if f.run.ID != id || f.run.Status != domain.ReviewRunDelivered {
		return false, nil
	}
	return true, nil
}

func (f *fakeStore) ListReviewRunsByBatch(context.Context, domain.SessionID, string) ([]domain.ReviewRun, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := append([]domain.ReviewRun(nil), f.batchRuns...)
	return out, nil
}

func (f *fakeStore) ListPRsBySession(context.Context, domain.SessionID) ([]domain.PullRequest, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := append([]domain.PullRequest(nil), f.prs...)
	return out, nil
}

func (f *fakeStore) ReplaceReviewFindings(_ context.Context, runID string, findings []testgate.ReviewFinding, _ time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.findings = append([]testgate.ReviewFinding(nil), findings...)
	if f.findingsByRun == nil {
		f.findingsByRun = make(map[string][]testgate.ReviewFinding)
	}
	f.findingsByRun[runID] = append([]testgate.ReviewFinding(nil), findings...)
	return nil
}

func (f *fakeStore) GetFusedVerdict(_ context.Context, _ domain.SessionID, prURL, targetSHA string) (testgate.FusedVerdict, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fused == nil {
		return testgate.FusedVerdict{}, false, nil
	}
	verdict, ok := f.fused[prURL+"\x00"+targetSHA]
	return verdict, ok, nil
}

func (f *fakeStore) markCallCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.markCalls
}

type fakeReducer struct {
	mu sync.Mutex

	outcome    lifecycle.ReviewDeliveryOutcome
	err        error
	calls      int
	batchCalls int
	got        lifecycle.ReviewResult
	gotBatchID string
	gotBatch   []lifecycle.ReviewResult
	called     chan struct{}
}

func (f *fakeReducer) ApplyReviewResult(_ context.Context, _ domain.SessionID, result lifecycle.ReviewResult) (lifecycle.ReviewDeliveryOutcome, error) {
	f.mu.Lock()
	f.calls++
	f.got = result
	called := f.called
	outcome := f.outcome
	err := f.err
	f.mu.Unlock()
	if called != nil {
		called <- struct{}{}
	}
	return outcome, err
}

func (f *fakeReducer) ApplyReviewBatch(_ context.Context, _ domain.SessionID, batchID string, results []lifecycle.ReviewResult) (lifecycle.ReviewDeliveryOutcome, error) {
	f.mu.Lock()
	f.batchCalls++
	f.gotBatchID = batchID
	f.gotBatch = append([]lifecycle.ReviewResult(nil), results...)
	called := f.called
	outcome := f.outcome
	err := f.err
	f.mu.Unlock()
	if called != nil {
		called <- struct{}{}
	}
	return outcome, err
}

func (f *fakeReducer) callCounts() (int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls, f.batchCalls
}

func (f *fakeReducer) lastResult() lifecycle.ReviewResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.got
}

type fakeTestGate struct {
	mu sync.Mutex

	baselines []domain.ReviewRun
	fused     map[string]testgate.FusedVerdict
	err       error
	calls     []domain.ReviewRun
	started   chan struct{}
	release   chan struct{}
	ctxErr    error
}

func (f *fakeTestGate) StartBaseline(_ context.Context, run domain.ReviewRun) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.baselines = append(f.baselines, run)
}

func (f *fakeTestGate) RunAfterReviewSubmit(ctx context.Context, run domain.ReviewRun) (testgate.FusedVerdict, bool, error) {
	f.mu.Lock()
	f.calls = append(f.calls, run)
	started := f.started
	release := f.release
	f.mu.Unlock()
	if started != nil {
		started <- struct{}{}
	}
	if release != nil {
		<-release
	}
	f.mu.Lock()
	f.ctxErr = ctx.Err()
	if f.err != nil {
		err := f.err
		f.mu.Unlock()
		return testgate.FusedVerdict{}, false, err
	}
	if f.fused == nil {
		f.mu.Unlock()
		return testgate.FusedVerdict{}, false, nil
	}
	verdict, ok := f.fused[run.ID]
	f.mu.Unlock()
	return verdict, ok, nil
}

func (f *fakeTestGate) contextErr() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.ctxErr
}

func TestSubmitAsyncTestGateReturnsBeforeRuntimeVerification(t *testing.T) {
	st := &fakeStore{ok: true, run: domain.ReviewRun{ID: "run-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning}}
	reducer := &fakeReducer{outcome: lifecycle.ReviewDeliverySent, called: make(chan struct{}, 1)}
	gate := &fakeTestGate{
		started: make(chan struct{}, 1),
		release: make(chan struct{}),
		fused: map[string]testgate.FusedVerdict{
			"run-1": {
				Outcome:  testgate.FusedOutcomeChangesRequested,
				Blocking: true,
				Findings: []testgate.FusedFinding{{Title: "runtime failure", Blocking: true}},
			},
		},
	}
	svc := New(nil, st, WithLifecycleReducer(reducer), WithTestGate(gate), WithAsyncTestGate(), WithBackgroundContext(context.Background()))
	ctx, cancel := context.WithCancel(context.Background())

	runs, err := svc.SubmitMany(ctx, "mer-1", []SubmittedReview{{RunID: "run-1", Verdict: domain.VerdictChangesRequested, Body: "fix it"}})
	if err != nil {
		t.Fatalf("SubmitMany: %v", err)
	}
	cancel()
	if len(runs) != 1 || runs[0].Status != domain.ReviewRunComplete {
		t.Fatalf("runs = %+v, want completed submit response", runs)
	}
	select {
	case <-gate.started:
	case <-time.After(time.Second):
		t.Fatal("test gate did not start")
	}
	reducerCalls, _ := reducer.callCounts()
	if markCalls := st.markCallCount(); reducerCalls != 0 || markCalls != 0 {
		t.Fatalf("async submit should return before delivery: calls=%d mark=%d", reducerCalls, markCalls)
	}

	close(gate.release)
	select {
	case <-reducer.called:
	case <-time.After(time.Second):
		t.Fatal("async test gate did not deliver fused review")
	}
	if err := gate.contextErr(); err != nil {
		t.Fatalf("test gate context was canceled by request context: %v", err)
	}
	got := reducer.lastResult()
	if got.Verdict != domain.VerdictChangesRequested || !strings.Contains(got.Body, "runtime failure") {
		t.Fatalf("reducer result = %+v, want fused runtime delivery", got)
	}
}

func TestSubmitPersistsThenAppliesThenStampsDelivered(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	st := &fakeStore{ok: true, run: domain.ReviewRun{ID: "run-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning}}
	reducer := &fakeReducer{outcome: lifecycle.ReviewDeliverySent}
	svc := New(nil, st, WithLifecycleReducer(reducer), WithClock(func() time.Time { return now }))

	run, err := svc.Submit(context.Background(), "mer-1", "run-1", domain.VerdictChangesRequested, "fix it", "987")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if st.updateCalls != 1 || reducer.calls != 1 || st.markCalls != 1 {
		t.Fatalf("calls update/reducer/mark = %d/%d/%d", st.updateCalls, reducer.calls, st.markCalls)
	}
	if reducer.got.Verdict != domain.VerdictChangesRequested || reducer.got.Body != "fix it" || reducer.got.GithubReviewID != "987" {
		t.Fatalf("reducer saw wrong result: %+v", reducer.got)
	}
	if run.Status != domain.ReviewRunDelivered || run.DeliveredAt == nil || !run.DeliveredAt.Equal(now) {
		t.Fatalf("run not stamped delivered: %+v", run)
	}
}

func TestSubmitPersistsStructuredFindingsAndSuppressesRuntimeApprovedDelivery(t *testing.T) {
	st := &fakeStore{ok: true, run: domain.ReviewRun{ID: "run-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning}}
	reducer := &fakeReducer{outcome: lifecycle.ReviewDeliverySent}
	gate := &fakeTestGate{fused: map[string]testgate.FusedVerdict{
		"run-1": {
			Outcome: testgate.FusedOutcomeApproved,
			Summary: "runtime refuted the finding",
			Findings: []testgate.FusedFinding{{
				Source:         testgate.EvidenceSourceTestInfra,
				RuntimeOutcome: testgate.EvidenceOutcomeRefuted,
				Blocking:       false,
			}},
		},
	}}
	svc := New(nil, st, WithLifecycleReducer(reducer), WithTestGate(gate))

	runs, err := svc.SubmitMany(context.Background(), "mer-1", []SubmittedReview{{
		RunID:   "run-1",
		Verdict: domain.VerdictChangesRequested,
		Body:    "fix it",
		Findings: []testgate.ReviewFinding{{
			Claim:      "route returns 500",
			Behavioral: true,
		}},
	}})
	if err != nil {
		t.Fatalf("SubmitMany: %v", err)
	}
	if len(runs) != 1 || runs[0].Status != domain.ReviewRunComplete {
		t.Fatalf("runs = %+v, want completed but undelivered", runs)
	}
	if reducer.calls != 0 || reducer.batchCalls != 0 || st.markCalls != 0 {
		t.Fatalf("runtime-approved review should not deliver: calls=%d batch=%d mark=%d", reducer.calls, reducer.batchCalls, st.markCalls)
	}
	if len(st.findings) != 1 || st.findings[0].ID == "" || st.findings[0].Title == "" || st.findings[0].RunID != "run-1" {
		t.Fatalf("findings = %+v", st.findings)
	}
}

func TestSubmitApprovedButFusedAppFailureDeliversRuntimeFeedback(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	st := &fakeStore{ok: true, run: domain.ReviewRun{ID: "run-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning}}
	reducer := &fakeReducer{outcome: lifecycle.ReviewDeliverySent}
	gate := &fakeTestGate{fused: map[string]testgate.FusedVerdict{
		"run-1": {
			Outcome:  testgate.FusedOutcomeAppFailed,
			Blocking: true,
			Summary:  "baseline smoke failed",
			Findings: []testgate.FusedFinding{{Title: "app does not boot", Summary: "Electron exited 1", Blocking: true}},
		},
	}}
	svc := New(nil, st, WithLifecycleReducer(reducer), WithTestGate(gate), WithClock(func() time.Time { return now }))

	runs, err := svc.SubmitMany(context.Background(), "mer-1", []SubmittedReview{{RunID: "run-1", Verdict: domain.VerdictApproved}})
	if err != nil {
		t.Fatalf("SubmitMany: %v", err)
	}
	if reducer.calls != 1 || reducer.got.Verdict != domain.VerdictChangesRequested || !strings.Contains(reducer.got.Body, "AO test gate") {
		t.Fatalf("reducer result = %+v calls=%d", reducer.got, reducer.calls)
	}
	if len(runs) != 1 || runs[0].Status != domain.ReviewRunDelivered || runs[0].DeliveredAt == nil || !runs[0].DeliveredAt.Equal(now) {
		t.Fatalf("runs = %+v, want delivered", runs)
	}
}

func TestSubmitChangesRequestedWithoutRuntimeRefutationStillDelivers(t *testing.T) {
	st := &fakeStore{ok: true, run: domain.ReviewRun{ID: "run-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning}}
	reducer := &fakeReducer{outcome: lifecycle.ReviewDeliverySent}
	gate := &fakeTestGate{fused: map[string]testgate.FusedVerdict{
		"run-1": {Outcome: testgate.FusedOutcomeApproved, Summary: "baseline passed"},
	}}
	svc := New(nil, st, WithLifecycleReducer(reducer), WithTestGate(gate))

	runs, err := svc.SubmitMany(context.Background(), "mer-1", []SubmittedReview{{
		RunID:   "run-1",
		Verdict: domain.VerdictChangesRequested,
		Body:    "legacy reviewer body",
	}})
	if err != nil {
		t.Fatalf("SubmitMany: %v", err)
	}
	if reducer.calls != 1 || reducer.got.Body != "legacy reviewer body" || reducer.got.Verdict != domain.VerdictChangesRequested {
		t.Fatalf("reducer result = %+v calls=%d, want original changes_requested delivery", reducer.got, reducer.calls)
	}
	if len(runs) != 1 || runs[0].Status != domain.ReviewRunDelivered {
		t.Fatalf("runs = %+v, want delivered", runs)
	}
}

func TestSubmitFusedMixedFindingsDeliversOnlyBlockingFindings(t *testing.T) {
	st := &fakeStore{ok: true, run: domain.ReviewRun{ID: "run-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning}}
	reducer := &fakeReducer{outcome: lifecycle.ReviewDeliverySent}
	gate := &fakeTestGate{fused: map[string]testgate.FusedVerdict{
		"run-1": {
			Outcome: testgate.FusedOutcomeChangesRequested,
			Findings: []testgate.FusedFinding{
				{Title: "false alarm", Summary: "targeted repro returned 200", Source: testgate.EvidenceSourceTestInfra, RuntimeOutcome: testgate.EvidenceOutcomeRefuted, Blocking: false},
				{File: "src/server.go", Line: 42, Title: "real failure", Summary: "targeted repro returned 500", Source: testgate.EvidenceSourceTestInfra, RuntimeOutcome: testgate.EvidenceOutcomeConfirmed, Blocking: true},
			},
		},
	}}
	svc := New(nil, st, WithLifecycleReducer(reducer), WithTestGate(gate))

	if _, err := svc.SubmitMany(context.Background(), "mer-1", []SubmittedReview{{
		RunID:          "run-1",
		Verdict:        domain.VerdictChangesRequested,
		Body:           "false alarm\nreal failure",
		GithubReviewID: "987",
		Findings: []testgate.ReviewFinding{
			{ID: "finding-1", Title: "false alarm", Behavioral: true},
			{ID: "finding-2", Title: "real failure", Behavioral: true},
		},
	}}); err != nil {
		t.Fatalf("SubmitMany: %v", err)
	}
	if reducer.calls != 1 {
		t.Fatalf("reducer calls = %d, want 1", reducer.calls)
	}
	if strings.Contains(reducer.got.Body, "false alarm") {
		t.Fatalf("delivery body leaked refuted finding: %q", reducer.got.Body)
	}
	if reducer.got.GithubReviewID != "" {
		t.Fatalf("fused delivery should not forward review id for refuted comments, got %q", reducer.got.GithubReviewID)
	}
	if !strings.Contains(reducer.got.Body, "real failure") || !strings.Contains(reducer.got.Body, "AO test gate") {
		t.Fatalf("delivery body = %q, want blocking fused finding", reducer.got.Body)
	}
	if !strings.Contains(reducer.got.Body, "src/server.go:42") {
		t.Fatalf("delivery body = %q, want blocking finding location", reducer.got.Body)
	}
}

func TestSubmitRejectsInvalidFindingSeverityBeforePersistence(t *testing.T) {
	st := &fakeStore{ok: true, run: domain.ReviewRun{ID: "run-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning}}
	svc := New(nil, st)

	_, err := svc.SubmitMany(context.Background(), "mer-1", []SubmittedReview{{
		RunID:   "run-1",
		Verdict: domain.VerdictChangesRequested,
		Body:    "fix it",
		Findings: []testgate.ReviewFinding{{
			Severity:   testgate.Severity("urgent"),
			Title:      "bad severity",
			Behavioral: true,
		}},
	}})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
	if st.updateCalls != 0 || len(st.findings) != 0 {
		t.Fatalf("invalid finding should not persist review result or findings: updates=%d findings=%+v", st.updateCalls, st.findings)
	}
}

func TestSubmitManyNamespacesReviewerFindingIDsByRun(t *testing.T) {
	st := &fakeStore{
		ok: true,
		batchRuns: []domain.ReviewRun{
			{ID: "run-1", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning},
			{ID: "run-2", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr2", TargetSHA: "sha2", Status: domain.ReviewRunRunning},
		},
	}
	svc := New(nil, st)

	if _, err := svc.SubmitMany(context.Background(), "mer-1", []SubmittedReview{
		{
			RunID:   "run-1",
			Verdict: domain.VerdictChangesRequested,
			Body:    "fix pr1",
			Findings: []testgate.ReviewFinding{{
				ID:         "finding-1",
				Title:      "shared local id",
				Behavioral: true,
			}},
		},
		{
			RunID:   "run-2",
			Verdict: domain.VerdictChangesRequested,
			Body:    "fix pr2",
			Findings: []testgate.ReviewFinding{{
				ID:         "finding-1",
				Title:      "shared local id",
				Behavioral: true,
			}},
		},
	}); err != nil {
		t.Fatalf("SubmitMany: %v", err)
	}
	if got := st.findingsByRun["run-1"][0].ID; got != "run-1:finding-1" {
		t.Fatalf("run-1 finding id = %q, want scoped id", got)
	}
	if got := st.findingsByRun["run-2"][0].ID; got != "run-2:finding-1" {
		t.Fatalf("run-2 finding id = %q, want scoped id", got)
	}
}

func TestSubmitBatchRunDoesNotWaitForOtherRunningRuns(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	st := &fakeStore{
		ok:  true,
		run: domain.ReviewRun{ID: "run-1", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning},
		batchRuns: []domain.ReviewRun{
			{ID: "run-1", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning},
			{ID: "run-2", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr2", TargetSHA: "sha2", Status: domain.ReviewRunRunning},
		},
		prs: []domain.PullRequest{{URL: "pr1", HeadSHA: "sha1"}, {URL: "pr2", HeadSHA: "sha2"}},
	}
	reducer := &fakeReducer{outcome: lifecycle.ReviewDeliverySent}
	svc := New(nil, st, WithLifecycleReducer(reducer), WithClock(func() time.Time { return now }))

	run, err := svc.Submit(context.Background(), "mer-1", "run-1", domain.VerdictChangesRequested, "fix pr1", "101")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if run.Status != domain.ReviewRunDelivered || run.DeliveredAt == nil || !run.DeliveredAt.Equal(now) {
		t.Fatalf("first submit status = %+v, want delivered", run)
	}
	if reducer.batchCalls != 1 || len(reducer.gotBatch) != 1 || reducer.gotBatch[0].RunID != "run-1" || st.markCalls != 1 {
		t.Fatalf("submitted run should deliver independently: batchCalls=%d got=%+v markCalls=%d", reducer.batchCalls, reducer.gotBatch, st.markCalls)
	}
}

func TestSubmitManySendsCombinedChangesRequested(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	st := &fakeStore{
		ok: true,
		batchRuns: []domain.ReviewRun{
			{ID: "run-1", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning},
			{ID: "run-2", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr2", TargetSHA: "sha2", Status: domain.ReviewRunRunning},
			{ID: "run-3", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr3", TargetSHA: "sha3", Status: domain.ReviewRunComplete, Verdict: domain.VerdictApproved},
			{ID: "run-4", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr4", TargetSHA: "old", Status: domain.ReviewRunComplete, Verdict: domain.VerdictChangesRequested, Body: "stale"},
			{ID: "run-5", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr5", TargetSHA: "sha5", Status: domain.ReviewRunFailed},
		},
		prs: []domain.PullRequest{
			{URL: "pr1", HeadSHA: "sha1"},
			{URL: "pr2", HeadSHA: "sha2"},
			{URL: "pr3", HeadSHA: "sha3"},
			{URL: "pr4", HeadSHA: "new"},
			{URL: "pr5", HeadSHA: "sha5"},
		},
	}
	reducer := &fakeReducer{outcome: lifecycle.ReviewDeliverySent}
	svc := New(nil, st, WithLifecycleReducer(reducer), WithClock(func() time.Time { return now }))

	runs, err := svc.SubmitMany(context.Background(), "mer-1", []SubmittedReview{
		{RunID: "run-1", Verdict: domain.VerdictChangesRequested, Body: "fix pr1", GithubReviewID: "101"},
		{RunID: "run-2", Verdict: domain.VerdictChangesRequested, Body: "fix pr2", GithubReviewID: "102"},
		{RunID: "run-3", Verdict: domain.VerdictApproved},
	})
	if err != nil {
		t.Fatalf("SubmitMany: %v", err)
	}
	if reducer.batchCalls != 1 || reducer.gotBatchID != "batch-1" {
		t.Fatalf("batch delivery calls/id = %d/%q", reducer.batchCalls, reducer.gotBatchID)
	}
	if len(reducer.gotBatch) != 2 || reducer.gotBatch[0].RunID != "run-1" || reducer.gotBatch[1].RunID != "run-2" {
		t.Fatalf("delivered batch = %+v, want run-1 and run-2 only", reducer.gotBatch)
	}
	if st.markCalls != 2 {
		t.Fatalf("markCalls = %d, want 2", st.markCalls)
	}
	if runs[0].Status != domain.ReviewRunDelivered || runs[0].DeliveredAt == nil || !runs[0].DeliveredAt.Equal(now) ||
		runs[1].Status != domain.ReviewRunDelivered || runs[1].DeliveredAt == nil || !runs[1].DeliveredAt.Equal(now) {
		t.Fatalf("submitted runs not stamped delivered: %+v", runs)
	}
}

func TestSubmitBatchApprovedOnlySendsNothing(t *testing.T) {
	st := &fakeStore{
		ok:  true,
		run: domain.ReviewRun{ID: "run-2", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr2", TargetSHA: "sha2", Status: domain.ReviewRunRunning},
		batchRuns: []domain.ReviewRun{
			{ID: "run-1", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunComplete, Verdict: domain.VerdictApproved},
			{ID: "run-2", SessionID: "mer-1", BatchID: "batch-1", PRURL: "pr2", TargetSHA: "sha2", Status: domain.ReviewRunRunning},
		},
		prs: []domain.PullRequest{{URL: "pr1", HeadSHA: "sha1"}, {URL: "pr2", HeadSHA: "sha2"}},
	}
	reducer := &fakeReducer{outcome: lifecycle.ReviewDeliverySent}
	svc := New(nil, st, WithLifecycleReducer(reducer))

	if _, err := svc.Submit(context.Background(), "mer-1", "run-2", domain.VerdictApproved, "", "102"); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if reducer.batchCalls != 0 || st.markCalls != 0 {
		t.Fatalf("approved-only batch should not deliver: batchCalls=%d markCalls=%d", reducer.batchCalls, st.markCalls)
	}
}

func TestSubmitDeliveryFailureLeavesCompletedUndeliveredForRetry(t *testing.T) {
	sendErr := errors.New("dead pane")
	st := &fakeStore{ok: true, run: domain.ReviewRun{ID: "run-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning}}
	reducer := &fakeReducer{err: sendErr}
	svc := New(nil, st, WithLifecycleReducer(reducer))

	if _, err := svc.Submit(context.Background(), "mer-1", "run-1", domain.VerdictChangesRequested, "fix it", "987"); !errors.Is(err, sendErr) {
		t.Fatalf("err = %v, want sendErr", err)
	}
	if st.run.Status != domain.ReviewRunComplete || st.run.DeliveredAt != nil || st.markCalls != 0 {
		t.Fatalf("failed delivery should leave completed/undelivered without stamp: %+v markCalls=%d", st.run, st.markCalls)
	}

	reducer.err = nil
	reducer.outcome = lifecycle.ReviewDeliverySent
	if _, err := svc.Submit(context.Background(), "mer-1", "run-1", domain.VerdictChangesRequested, "fix it", "987"); err != nil {
		t.Fatalf("retry Submit: %v", err)
	}
	if st.updateCalls != 1 || reducer.calls != 2 || st.run.Status != domain.ReviewRunDelivered || st.run.DeliveredAt == nil {
		t.Fatalf("retry should not rewrite result and should stamp delivery: update=%d reducer=%d run=%+v", st.updateCalls, reducer.calls, st.run)
	}
}

func TestSubmitCompletedRetryRejectsDifferentRecordedFields(t *testing.T) {
	tests := []struct {
		name           string
		body           string
		githubReviewID string
	}{
		{name: "different body", body: "different", githubReviewID: "987"},
		{name: "different review id", body: "fix it", githubReviewID: "654"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			st := &fakeStore{ok: true, run: domain.ReviewRun{
				ID: "run-1", SessionID: "mer-1", PRURL: "pr1", TargetSHA: "sha1",
				Status: domain.ReviewRunComplete, Verdict: domain.VerdictChangesRequested,
				Body: "fix it", GithubReviewID: "987",
			}}
			reducer := &fakeReducer{outcome: lifecycle.ReviewDeliverySent}
			svc := New(nil, st, WithLifecycleReducer(reducer))

			if _, err := svc.Submit(context.Background(), "mer-1", "run-1", domain.VerdictChangesRequested, tt.body, tt.githubReviewID); !errors.Is(err, ErrInvalid) {
				t.Fatalf("err = %v, want ErrInvalid", err)
			}
			if st.updateCalls != 0 || st.markCalls != 0 || reducer.calls != 0 {
				t.Fatalf("mismatched retry should not rewrite or deliver: update=%d mark=%d reducer=%d", st.updateCalls, st.markCalls, reducer.calls)
			}
		})
	}
}
