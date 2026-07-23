package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/testgate"
)

func TestTestGateArtifactsRoundTrip(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	rec, err := s.CreateSession(ctx, sampleRecord("mer"))
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	if err := s.WritePR(ctx, domain.PullRequest{
		URL:       "https://example/pr/1",
		SessionID: rec.ID,
		Number:    1,
		HeadSHA:   "sha1",
		UpdatedAt: now,
	}, nil, nil); err != nil {
		t.Fatalf("write pr: %v", err)
	}
	if err := s.UpsertReview(ctx, domain.Review{
		ID: "rev-1", SessionID: rec.ID, ProjectID: rec.ProjectID,
		Harness: domain.ReviewerCodex, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("upsert review: %v", err)
	}
	if err := s.InsertReviewRun(ctx, domain.ReviewRun{
		ID: "review-run-1", ReviewID: "rev-1", SessionID: rec.ID, Harness: domain.ReviewerCodex,
		PRURL: "https://example/pr/1", TargetSHA: "sha1", Status: domain.ReviewRunRunning, CreatedAt: now,
	}); err != nil {
		t.Fatalf("insert review run: %v", err)
	}

	findings := []testgate.ReviewFinding{{
		ID:              "finding-1",
		RunID:           "review-run-1",
		File:            "handlers/diff.go",
		Line:            73,
		Severity:        testgate.SeverityHigh,
		Title:           "empty contract panics",
		Claim:           "summarizeDiff dereferences an empty contract",
		FailureScenario: "GET /diff/summary with an empty contract returns 500",
		Behavioral:      true,
	}}
	if err := s.ReplaceReviewFindings(ctx, "review-run-1", findings, now); err != nil {
		t.Fatalf("replace findings: %v", err)
	}
	gotFindings, err := s.ListReviewFindingsByRun(ctx, "review-run-1")
	if err != nil {
		t.Fatalf("list findings: %v", err)
	}
	if len(gotFindings) != 1 || gotFindings[0].ID != "finding-1" || !gotFindings[0].Behavioral || gotFindings[0].FailureScenario == "" {
		t.Fatalf("findings = %+v", gotFindings)
	}

	baseline := testgate.TestRun{
		ID: "test-run-1", SessionID: string(rec.ID), ReviewRunID: "review-run-1",
		PRURL: "https://example/pr/1", TargetSHA: "sha1", Kind: testgate.RunKindBaseline,
		Classification: testgate.ClassificationPassed, Summary: "smoke passed",
		Artifacts: []string{"trace.zip"}, PodHandleID: "pod-1", CreatedAt: now,
	}
	if err := s.InsertTestGateRun(ctx, baseline); err != nil {
		t.Fatalf("insert test run: %v", err)
	}
	gotRun, ok, err := s.GetLatestTestGateRun(ctx, rec.ID, "https://example/pr/1", "sha1", testgate.RunKindBaseline)
	if err != nil || !ok {
		t.Fatalf("latest run: ok=%v err=%v", ok, err)
	}
	if gotRun.ID != "test-run-1" || gotRun.Artifacts[0] != "trace.zip" || gotRun.PodHandleID != "pod-1" {
		t.Fatalf("test run = %+v", gotRun)
	}

	evidence := testgate.TestEvidence{
		ID: "evidence-1", TestRunID: "test-run-1", FindingID: "finding-1",
		Source: testgate.EvidenceSourceTestInfra, Outcome: testgate.EvidenceOutcomeConfirmed,
		Summary: "targeted repro returned 500", Artifacts: []string{"targeted.log"}, CreatedAt: now,
	}
	if err := s.InsertTestEvidence(ctx, evidence); err != nil {
		t.Fatalf("insert evidence: %v", err)
	}
	gotEvidence, err := s.ListTestEvidenceByTestRun(ctx, "test-run-1")
	if err != nil {
		t.Fatalf("list evidence: %v", err)
	}
	if len(gotEvidence) != 1 || gotEvidence[0].FindingID != "finding-1" || gotEvidence[0].Artifacts[0] != "targeted.log" {
		t.Fatalf("evidence = %+v", gotEvidence)
	}

	fused := testgate.FusedVerdict{
		ID: "fused-1", SessionID: string(rec.ID), ReviewRunID: "review-run-1", TestRunID: "test-run-1",
		PRURL: "https://example/pr/1", TargetSHA: "sha1", Outcome: testgate.FusedOutcomeChangesRequested,
		Blocking: true, Summary: "runtime confirmed reviewer finding", Findings: []testgate.FusedFinding{{
			FindingID: "finding-1", Source: testgate.EvidenceSourceTestInfra,
			RuntimeOutcome: testgate.EvidenceOutcomeConfirmed, Title: "empty contract panics", Blocking: true,
		}}, CreatedAt: now,
	}
	if err := s.UpsertFusedVerdict(ctx, fused); err != nil {
		t.Fatalf("upsert fused verdict: %v", err)
	}
	gotFused, ok, err := s.GetFusedVerdict(ctx, rec.ID, "https://example/pr/1", "sha1")
	if err != nil || !ok {
		t.Fatalf("get fused: ok=%v err=%v", ok, err)
	}
	if !gotFused.Blocking || gotFused.Outcome != testgate.FusedOutcomeChangesRequested || gotFused.Findings[0].RuntimeOutcome != testgate.EvidenceOutcomeConfirmed {
		t.Fatalf("fused = %+v", gotFused)
	}
}
