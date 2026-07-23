package testgate

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// Store is the durable persistence surface Manager needs.
type Store interface {
	GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error)
	InsertTestGateRun(ctx context.Context, run TestRun) error
	GetLatestTestGateRun(ctx context.Context, sessionID domain.SessionID, prURL, targetSHA string, kind RunKind) (TestRun, bool, error)
	ListReviewFindingsByRun(ctx context.Context, reviewRunID string) ([]ReviewFinding, error)
	InsertTestEvidence(ctx context.Context, evidence TestEvidence) error
	UpsertFusedVerdict(ctx context.Context, verdict FusedVerdict) error
}

// Runner executes the real runtime-verification job, typically in an ephemeral pod.
type Runner interface {
	Run(ctx context.Context, req RunRequest) (RunResult, error)
}

// RunRequest is the payload sent to the runtime-verification runner.
type RunRequest struct {
	Kind          RunKind          `json:"kind"`
	ReviewRun     domain.ReviewRun `json:"reviewRun"`
	WorkspacePath string           `json:"workspacePath,omitempty"`
	Baseline      TestRun          `json:"baseline,omitempty"`
	Findings      []ReviewFinding  `json:"findings,omitempty"`
}

// RunResult is the parsed runtime-verification command result.
type RunResult struct {
	Run      TestRun
	Evidence []TestEvidence
}

// ManagerDeps configures a Manager.
type ManagerDeps struct {
	Store  Store
	Runner Runner
	Logger *slog.Logger
	Clock  func() time.Time
	NewID  func() string
}

// Manager coordinates baseline pod runs, targeted finding verification, and
// synthesized fused verdict persistence.
type Manager struct {
	store           Store
	runner          Runner
	logger          *slog.Logger
	clock           func() time.Time
	newID           func() string
	mu              sync.Mutex
	baselineFlights map[string]*baselineFlight
}

type baselineFlight struct {
	done chan struct{}
	run  TestRun
	err  error
}

// NewManager creates a test-gate manager from its dependencies.
func NewManager(deps ManagerDeps) *Manager {
	clock := deps.Clock
	if clock == nil {
		clock = func() time.Time { return time.Now().UTC() }
	}
	newID := deps.NewID
	if newID == nil {
		newID = uuid.NewString
	}
	logger := deps.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Manager{
		store:  deps.Store,
		runner: deps.Runner,
		logger: logger,
		clock:  clock,
		newID:  newID,
	}
}

// StartBaseline launches a baseline run without blocking the review trigger path.
func (m *Manager) StartBaseline(ctx context.Context, run domain.ReviewRun) {
	if m == nil || m.runner == nil || m.store == nil {
		return
	}
	go func() {
		if _, _, err := m.RunBaseline(context.WithoutCancel(ctx), run); err != nil {
			m.logger.Warn("testgate baseline failed", "reviewRun", run.ID, "err", err)
		}
	}()
}

// RunBaseline executes and stores the baseline runtime verification for a review run.
func (m *Manager) RunBaseline(ctx context.Context, reviewRun domain.ReviewRun) (TestRun, bool, error) {
	if m == nil || m.runner == nil || m.store == nil {
		return TestRun{}, false, nil
	}
	return m.runBaselineSingleflight(ctx, reviewRun)
}

func (m *Manager) runBaselineSingleflight(ctx context.Context, reviewRun domain.ReviewRun) (TestRun, bool, error) {
	key := baselineKey(reviewRun)
	m.mu.Lock()
	if m.baselineFlights == nil {
		m.baselineFlights = make(map[string]*baselineFlight)
	}
	if flight, ok := m.baselineFlights[key]; ok {
		m.mu.Unlock()
		select {
		case <-flight.done:
			return flight.run, flight.err == nil, flight.err
		case <-ctx.Done():
			return TestRun{}, false, ctx.Err()
		}
	}
	flight := &baselineFlight{done: make(chan struct{})}
	m.baselineFlights[key] = flight
	m.mu.Unlock()

	flight.run, flight.err = m.runBaselineOnce(ctx, reviewRun)
	close(flight.done)

	m.mu.Lock()
	if m.baselineFlights[key] == flight {
		delete(m.baselineFlights, key)
	}
	m.mu.Unlock()
	return flight.run, flight.err == nil, flight.err
}

func (m *Manager) runBaselineOnce(ctx context.Context, reviewRun domain.ReviewRun) (TestRun, error) {
	req, err := m.runRequest(ctx, RunKindBaseline, reviewRun, TestRun{}, nil)
	if err != nil {
		return TestRun{}, err
	}
	res, err := m.runner.Run(ctx, req)
	if err != nil {
		if ctx.Err() != nil {
			return TestRun{}, ctx.Err()
		}
		res = RunResult{Run: infraRun(fmt.Sprintf("runtime verification could not run: %v", err))}
	}
	run, err := m.normalizeRun(res.Run, reviewRun, RunKindBaseline)
	if err != nil {
		return TestRun{}, err
	}
	if err := m.store.InsertTestGateRun(ctx, run); err != nil {
		return TestRun{}, err
	}
	return run, nil
}

// RunAfterReviewSubmit verifies behavioral findings, synthesizes the fused
// verdict, and persists it for UI/API consumption.
func (m *Manager) RunAfterReviewSubmit(ctx context.Context, reviewRun domain.ReviewRun) (FusedVerdict, bool, error) {
	if m == nil || m.store == nil {
		return FusedVerdict{}, false, nil
	}
	if baseline, ok, err := m.activeBaseline(ctx, reviewRun); err != nil {
		return FusedVerdict{}, false, err
	} else if ok {
		fused, err := m.runAfterReviewSubmitWithBaseline(ctx, reviewRun, baseline)
		return fused, err == nil, err
	}
	baseline, ok, err := m.store.GetLatestTestGateRun(ctx, reviewRun.SessionID, reviewRun.PRURL, reviewRun.TargetSHA, RunKindBaseline)
	if err != nil {
		return FusedVerdict{}, false, err
	}
	if !ok {
		if run, ran, err := m.RunBaseline(ctx, reviewRun); err != nil {
			return FusedVerdict{}, false, err
		} else if ran {
			baseline = run
			ok = true
		}
	}
	if !ok {
		baseline = TestRun{
			SessionID:      string(reviewRun.SessionID),
			ReviewRunID:    reviewRun.ID,
			PRURL:          reviewRun.PRURL,
			TargetSHA:      reviewRun.TargetSHA,
			Kind:           RunKindBaseline,
			Classification: ClassificationNotConfigured,
			Summary:        "runtime verification is not configured",
			CreatedAt:      m.clock(),
		}
	}
	fused, err := m.runAfterReviewSubmitWithBaseline(ctx, reviewRun, baseline)
	return fused, err == nil, err
}

func (m *Manager) activeBaseline(ctx context.Context, reviewRun domain.ReviewRun) (TestRun, bool, error) {
	key := baselineKey(reviewRun)
	m.mu.Lock()
	flight := m.baselineFlights[key]
	m.mu.Unlock()
	if flight == nil {
		return TestRun{}, false, nil
	}
	select {
	case <-flight.done:
		return flight.run, flight.err == nil, flight.err
	case <-ctx.Done():
		return TestRun{}, false, ctx.Err()
	}
}

func (m *Manager) runAfterReviewSubmitWithBaseline(ctx context.Context, reviewRun domain.ReviewRun, baseline TestRun) (FusedVerdict, error) {
	findings, err := m.store.ListReviewFindingsByRun(ctx, reviewRun.ID)
	if err != nil {
		return FusedVerdict{}, err
	}

	evidence := []TestEvidence{}
	testRunID := baseline.ID
	behavioral := behavioralFindings(findings)
	if baseline.Classification == ClassificationPassed && m.runner != nil && len(behavioral) > 0 {
		req, err := m.runRequest(ctx, RunKindTargeted, reviewRun, baseline, behavioral)
		if err != nil {
			return FusedVerdict{}, err
		}
		res, err := m.runner.Run(ctx, req)
		if err != nil {
			if ctx.Err() != nil {
				return FusedVerdict{}, ctx.Err()
			}
			res = RunResult{Run: infraRun(fmt.Sprintf("targeted runtime verification could not run: %v", err))}
		}
		targetedRun, err := m.normalizeRun(res.Run, reviewRun, RunKindTargeted)
		if err != nil {
			return FusedVerdict{}, err
		}
		if err := m.store.InsertTestGateRun(ctx, targetedRun); err != nil {
			return FusedVerdict{}, err
		}
		testRunID = targetedRun.ID
		for _, normalized := range m.validEvidence(res.Evidence, targetedRun.ID, behavioral) {
			if err := m.store.InsertTestEvidence(ctx, normalized); err != nil {
				return FusedVerdict{}, err
			}
			evidence = append(evidence, normalized)
		}
	}

	fused := Synthesize(SynthesisInput{
		Baseline:      baseline,
		ReviewVerdict: ReviewVerdict(reviewRun.Verdict),
		Findings:      findings,
		Evidence:      evidence,
	})
	fused = m.normalizeFused(fused, reviewRun, testRunID)
	if err := m.store.UpsertFusedVerdict(ctx, fused); err != nil {
		return FusedVerdict{}, err
	}
	return fused, nil
}

func baselineKey(reviewRun domain.ReviewRun) string {
	return string(reviewRun.SessionID) + "\x00" + reviewRun.PRURL + "\x00" + reviewRun.TargetSHA
}

// NotConfiguredRunner is a safe default until a project has a concrete pod runner.
type NotConfiguredRunner struct {
	Summary string
}

// Run returns a neutral not-configured runtime-verification result.
func (r NotConfiguredRunner) Run(context.Context, RunRequest) (RunResult, error) {
	return RunResult{Run: TestRun{
		Classification: ClassificationNotConfigured,
		Summary:        firstNonEmpty(r.Summary, "runtime verification is not configured"),
	}}, nil
}

func infraRun(summary string) TestRun {
	return TestRun{Classification: ClassificationInfra, Summary: summary}
}

func (m *Manager) normalizeRun(run TestRun, reviewRun domain.ReviewRun, kind RunKind) (TestRun, error) {
	if run.ID == "" {
		run.ID = m.newID()
	}
	if run.SessionID == "" {
		run.SessionID = string(reviewRun.SessionID)
	}
	if run.ReviewRunID == "" {
		run.ReviewRunID = reviewRun.ID
	}
	if run.PRURL == "" {
		run.PRURL = reviewRun.PRURL
	}
	if run.TargetSHA == "" {
		run.TargetSHA = reviewRun.TargetSHA
	}
	if run.Kind == "" {
		run.Kind = kind
	}
	if run.CreatedAt.IsZero() {
		run.CreatedAt = m.clock()
	}
	if !run.Classification.Valid() {
		return TestRun{}, fmt.Errorf("testgate: invalid run classification %q", run.Classification)
	}
	return run, nil
}

func (m *Manager) runRequest(ctx context.Context, kind RunKind, reviewRun domain.ReviewRun, baseline TestRun, findings []ReviewFinding) (RunRequest, error) {
	req := RunRequest{Kind: kind, ReviewRun: reviewRun, Baseline: baseline, Findings: findings}
	if m.store == nil || reviewRun.SessionID == "" {
		return req, nil
	}
	session, ok, err := m.store.GetSession(ctx, reviewRun.SessionID)
	if err != nil {
		return RunRequest{}, err
	}
	if ok {
		req.WorkspacePath = session.Metadata.WorkspacePath
	}
	return req, nil
}

func (m *Manager) normalizeEvidence(evidence TestEvidence, testRunID string) TestEvidence {
	if evidence.ID == "" {
		evidence.ID = m.newID()
	}
	evidence.TestRunID = testRunID
	if evidence.Source == "" {
		evidence.Source = EvidenceSourceTestInfra
	}
	if evidence.CreatedAt.IsZero() {
		evidence.CreatedAt = m.clock()
	}
	return evidence
}

func (m *Manager) validEvidence(evidence []TestEvidence, testRunID string, findings []ReviewFinding) []TestEvidence {
	knownFinding := make(map[string]struct{}, len(findings))
	for _, finding := range findings {
		if finding.ID != "" {
			knownFinding[finding.ID] = struct{}{}
		}
	}
	out := make([]TestEvidence, 0, len(evidence))
	for _, ev := range evidence {
		ev.TestRunID = testRunID
		if ev.Source == "" {
			ev.Source = EvidenceSourceTestInfra
		}
		if _, ok := knownFinding[ev.FindingID]; !ok {
			m.logger.Warn("testgate ignored evidence for unknown finding", "findingID", ev.FindingID, "testRun", testRunID)
			continue
		}
		if !ev.Source.Valid() {
			m.logger.Warn("testgate ignored evidence with invalid source", "findingID", ev.FindingID, "source", ev.Source, "testRun", testRunID)
			continue
		}
		if !ev.Outcome.Valid() {
			m.logger.Warn("testgate ignored evidence with invalid outcome", "findingID", ev.FindingID, "outcome", ev.Outcome, "testRun", testRunID)
			continue
		}
		out = append(out, m.normalizeEvidence(ev, testRunID))
	}
	return out
}

func (m *Manager) normalizeFused(fused FusedVerdict, reviewRun domain.ReviewRun, testRunID string) FusedVerdict {
	if fused.ID == "" {
		fused.ID = m.newID()
	}
	if fused.SessionID == "" {
		fused.SessionID = string(reviewRun.SessionID)
	}
	if fused.ReviewRunID == "" {
		fused.ReviewRunID = reviewRun.ID
	}
	if fused.TestRunID == "" {
		fused.TestRunID = testRunID
	}
	if fused.PRURL == "" {
		fused.PRURL = reviewRun.PRURL
	}
	if fused.TargetSHA == "" {
		fused.TargetSHA = reviewRun.TargetSHA
	}
	if fused.CreatedAt.IsZero() {
		fused.CreatedAt = m.clock()
	}
	if fused.Findings == nil {
		fused.Findings = []FusedFinding{}
	}
	return fused
}

func behavioralFindings(findings []ReviewFinding) []ReviewFinding {
	out := make([]ReviewFinding, 0, len(findings))
	for _, finding := range findings {
		if finding.Behavioral {
			out = append(out, finding)
		}
	}
	return out
}
