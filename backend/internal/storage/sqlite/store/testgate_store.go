package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
	"github.com/aoagents/agent-orchestrator/backend/internal/testgate"
)

// ReplaceReviewFindings replaces the structured findings emitted by one review run.
func (s *Store) ReplaceReviewFindings(ctx context.Context, reviewRunID string, findings []testgate.ReviewFinding, createdAt time.Time) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	return s.inTx(ctx, "replace review findings", func(q *gen.Queries) error {
		if err := q.DeleteReviewFindingsByRun(ctx, reviewRunID); err != nil {
			return fmt.Errorf("delete review findings for run %s: %w", reviewRunID, err)
		}
		for _, finding := range findings {
			if finding.RunID == "" {
				finding.RunID = reviewRunID
			}
			if finding.CreatedAt.IsZero() {
				finding.CreatedAt = createdAt
			}
			if err := q.InsertReviewFinding(ctx, gen.InsertReviewFindingParams{
				ID:              finding.ID,
				ReviewRunID:     finding.RunID,
				File:            finding.File,
				Line:            int64(finding.Line),
				Severity:        string(finding.Severity),
				Title:           finding.Title,
				Claim:           finding.Claim,
				FailureScenario: finding.FailureScenario,
				Behavioral:      boolInt(finding.Behavioral),
				CreatedAt:       finding.CreatedAt,
			}); err != nil {
				return fmt.Errorf("insert review finding %s: %w", finding.ID, err)
			}
		}
		return nil
	})
}

// ListReviewFindingsByRun returns structured findings for one review run, oldest first.
func (s *Store) ListReviewFindingsByRun(ctx context.Context, reviewRunID string) ([]testgate.ReviewFinding, error) {
	rows, err := s.qr.ListReviewFindingsByRun(ctx, reviewRunID)
	if err != nil {
		return nil, fmt.Errorf("list review findings for run %s: %w", reviewRunID, err)
	}
	out := make([]testgate.ReviewFinding, 0, len(rows))
	for _, row := range rows {
		out = append(out, reviewFindingFromGen(row))
	}
	return out, nil
}

// InsertTestGateRun records one pod/runtime verification run.
func (s *Store) InsertTestGateRun(ctx context.Context, run testgate.TestRun) error {
	artifacts, err := encodeStringSlice(run.Artifacts)
	if err != nil {
		return fmt.Errorf("encode test gate run artifacts: %w", err)
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.qw.InsertTestGateRun(ctx, gen.InsertTestGateRunParams{
		ID:             run.ID,
		SessionID:      run.SessionID,
		ReviewRunID:    run.ReviewRunID,
		PRURL:          run.PRURL,
		TargetSha:      run.TargetSHA,
		Kind:           string(run.Kind),
		Classification: string(run.Classification),
		Summary:        run.Summary,
		ArtifactsJson:  artifacts,
		PodHandleID:    run.PodHandleID,
		CreatedAt:      run.CreatedAt,
	}); err != nil {
		return fmt.Errorf("insert test gate run %s: %w", run.ID, err)
	}
	return nil
}

// GetLatestTestGateRun returns the newest run for a session/PR/SHA/kind tuple.
func (s *Store) GetLatestTestGateRun(ctx context.Context, sessionID domain.SessionID, prURL, targetSHA string, kind testgate.RunKind) (testgate.TestRun, bool, error) {
	row, err := s.qr.GetLatestTestGateRun(ctx, gen.GetLatestTestGateRunParams{
		SessionID: string(sessionID),
		PRURL:     prURL,
		TargetSha: targetSHA,
		Kind:      string(kind),
	})
	if errors.Is(err, sql.ErrNoRows) {
		return testgate.TestRun{}, false, nil
	}
	if err != nil {
		return testgate.TestRun{}, false, fmt.Errorf("get latest test gate run for session %s pr %s sha %s: %w", sessionID, prURL, targetSHA, err)
	}
	run, err := testRunFromGen(row)
	if err != nil {
		return testgate.TestRun{}, false, fmt.Errorf("decode test gate run artifacts %s: %w", row.ID, err)
	}
	return run, true, nil
}

// InsertTestEvidence records targeted runtime evidence for a review finding.
func (s *Store) InsertTestEvidence(ctx context.Context, evidence testgate.TestEvidence) error {
	artifacts, err := encodeStringSlice(evidence.Artifacts)
	if err != nil {
		return fmt.Errorf("encode test evidence artifacts: %w", err)
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.qw.InsertTestEvidence(ctx, gen.InsertTestEvidenceParams{
		ID:            evidence.ID,
		TestRunID:     evidence.TestRunID,
		FindingID:     evidence.FindingID,
		Source:        string(evidence.Source),
		Outcome:       string(evidence.Outcome),
		Summary:       evidence.Summary,
		ArtifactsJson: artifacts,
		CreatedAt:     evidence.CreatedAt,
	}); err != nil {
		return fmt.Errorf("insert test evidence %s: %w", evidence.ID, err)
	}
	return nil
}

// ListTestEvidenceByTestRun returns targeted runtime evidence for one test run.
func (s *Store) ListTestEvidenceByTestRun(ctx context.Context, testRunID string) ([]testgate.TestEvidence, error) {
	rows, err := s.qr.ListTestEvidenceByTestRun(ctx, testRunID)
	if err != nil {
		return nil, fmt.Errorf("list test evidence for run %s: %w", testRunID, err)
	}
	out := make([]testgate.TestEvidence, 0, len(rows))
	for _, row := range rows {
		evidence, err := testEvidenceFromGen(row)
		if err != nil {
			return nil, fmt.Errorf("decode test evidence artifacts %s: %w", row.ID, err)
		}
		out = append(out, evidence)
	}
	return out, nil
}

// UpsertFusedVerdict records the latest synthesized verdict for a session/PR/SHA.
func (s *Store) UpsertFusedVerdict(ctx context.Context, verdict testgate.FusedVerdict) error {
	findings, err := encodeFusedFindings(verdict.Findings)
	if err != nil {
		return fmt.Errorf("encode fused verdict findings: %w", err)
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.qw.UpsertFusedVerdict(ctx, gen.UpsertFusedVerdictParams{
		ID:           verdict.ID,
		SessionID:    verdict.SessionID,
		ReviewRunID:  verdict.ReviewRunID,
		TestRunID:    verdict.TestRunID,
		PRURL:        verdict.PRURL,
		TargetSha:    verdict.TargetSHA,
		Outcome:      string(verdict.Outcome),
		Blocking:     boolInt(verdict.Blocking),
		Summary:      verdict.Summary,
		FindingsJson: findings,
		CreatedAt:    verdict.CreatedAt,
	}); err != nil {
		return fmt.Errorf("upsert fused verdict %s: %w", verdict.ID, err)
	}
	return nil
}

// GetFusedVerdict returns the latest synthesized verdict for a session/PR/SHA.
func (s *Store) GetFusedVerdict(ctx context.Context, sessionID domain.SessionID, prURL, targetSHA string) (testgate.FusedVerdict, bool, error) {
	row, err := s.qr.GetFusedVerdict(ctx, gen.GetFusedVerdictParams{
		SessionID: string(sessionID),
		PRURL:     prURL,
		TargetSha: targetSHA,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return testgate.FusedVerdict{}, false, nil
	}
	if err != nil {
		return testgate.FusedVerdict{}, false, fmt.Errorf("get fused verdict for session %s pr %s sha %s: %w", sessionID, prURL, targetSHA, err)
	}
	verdict, err := fusedVerdictFromGen(row)
	if err != nil {
		return testgate.FusedVerdict{}, false, fmt.Errorf("decode fused verdict findings %s: %w", row.ID, err)
	}
	return verdict, true, nil
}

func reviewFindingFromGen(row gen.ReviewFinding) testgate.ReviewFinding {
	return testgate.ReviewFinding{
		ID:              row.ID,
		RunID:           row.ReviewRunID,
		File:            row.File,
		Line:            int(row.Line),
		Severity:        testgate.Severity(row.Severity),
		Title:           row.Title,
		Claim:           row.Claim,
		FailureScenario: row.FailureScenario,
		Behavioral:      row.Behavioral != 0,
		CreatedAt:       row.CreatedAt,
	}
}

func testRunFromGen(row gen.TestGateRun) (testgate.TestRun, error) {
	artifacts, err := decodeStringSlice(row.ArtifactsJson)
	if err != nil {
		return testgate.TestRun{}, err
	}
	return testgate.TestRun{
		ID:             row.ID,
		SessionID:      row.SessionID,
		ReviewRunID:    row.ReviewRunID,
		PRURL:          row.PRURL,
		TargetSHA:      row.TargetSha,
		Kind:           testgate.RunKind(row.Kind),
		Classification: testgate.Classification(row.Classification),
		Summary:        row.Summary,
		Artifacts:      artifacts,
		PodHandleID:    row.PodHandleID,
		CreatedAt:      row.CreatedAt,
	}, nil
}

func testEvidenceFromGen(row gen.TestGateEvidence) (testgate.TestEvidence, error) {
	artifacts, err := decodeStringSlice(row.ArtifactsJson)
	if err != nil {
		return testgate.TestEvidence{}, err
	}
	return testgate.TestEvidence{
		ID:        row.ID,
		TestRunID: row.TestRunID,
		FindingID: row.FindingID,
		Source:    testgate.EvidenceSource(row.Source),
		Outcome:   testgate.EvidenceOutcome(row.Outcome),
		Summary:   row.Summary,
		Artifacts: artifacts,
		CreatedAt: row.CreatedAt,
	}, nil
}

func fusedVerdictFromGen(row gen.FusedVerdict) (testgate.FusedVerdict, error) {
	findings, err := decodeFusedFindings(row.FindingsJson)
	if err != nil {
		return testgate.FusedVerdict{}, err
	}
	return testgate.FusedVerdict{
		ID:          row.ID,
		SessionID:   row.SessionID,
		ReviewRunID: row.ReviewRunID,
		TestRunID:   row.TestRunID,
		PRURL:       row.PRURL,
		TargetSHA:   row.TargetSha,
		Outcome:     testgate.FusedOutcome(row.Outcome),
		Blocking:    row.Blocking != 0,
		Summary:     row.Summary,
		Findings:    findings,
		CreatedAt:   row.CreatedAt,
	}, nil
}

func encodeStringSlice(values []string) (string, error) {
	if values == nil {
		values = []string{}
	}
	data, err := json.Marshal(values)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func decodeStringSlice(raw string) ([]string, error) {
	if raw == "" {
		return []string{}, nil
	}
	var values []string
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return nil, err
	}
	if values == nil {
		return []string{}, nil
	}
	return values, nil
}

func encodeFusedFindings(findings []testgate.FusedFinding) (string, error) {
	if findings == nil {
		findings = []testgate.FusedFinding{}
	}
	data, err := json.Marshal(findings)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func decodeFusedFindings(raw string) ([]testgate.FusedFinding, error) {
	if raw == "" {
		return []testgate.FusedFinding{}, nil
	}
	var findings []testgate.FusedFinding
	if err := json.Unmarshal([]byte(raw), &findings); err != nil {
		return nil, err
	}
	if findings == nil {
		return []testgate.FusedFinding{}, nil
	}
	return findings, nil
}
