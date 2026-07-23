package testgate

import (
	"strings"
	"testing"
)

func TestParseVerdictLineAcceptsStructuredAOVerdict(t *testing.T) {
	got, ok, err := ParseVerdictLine(`AO_VERDICT {"classification":"passed","summary":"smoke passed","artifacts":["trace.zip"]}`)
	if err != nil {
		t.Fatalf("ParseVerdictLine err = %v", err)
	}
	if !ok {
		t.Fatal("ParseVerdictLine ok = false, want true")
	}
	if got.Classification != ClassificationPassed || got.Summary != "smoke passed" {
		t.Fatalf("verdict = %+v", got)
	}
	if len(got.Artifacts) != 1 || got.Artifacts[0] != "trace.zip" {
		t.Fatalf("artifacts = %#v", got.Artifacts)
	}
}

func TestParseVerdictLineAcceptsReleaseGateVerdict(t *testing.T) {
	passed := `AO_VERDICT {"classification":"passed","conclusion":"success","passed":true,"summary":"T0 pod smoke passed","artifactsUrl":"https://example/actions/1"}`
	got, ok, err := ParseVerdictLine(passed)
	if err != nil {
		t.Fatalf("ParseVerdictLine err = %v", err)
	}
	if !ok {
		t.Fatal("ParseVerdictLine ok = false, want true")
	}
	if got.Classification != ClassificationPassed || got.Summary != "T0 pod smoke passed" {
		t.Fatalf("verdict = %+v", got)
	}
	if len(got.Artifacts) != 1 || got.Artifacts[0] != "https://example/actions/1" {
		t.Fatalf("artifacts = %#v", got.Artifacts)
	}
}

func TestParseRunResultOutputUsesFinalVerdictAndEvidence(t *testing.T) {
	got, ok, err := ParseRunResultOutput(strings.Join([]string{
		`AO_VERDICT {"classification":"passed","summary":"early"}`,
		`runner log`,
		`AO_VERDICT {"classification":"app_failed","summary":"final","evidence":[{"findingId":"finding-1","outcome":"confirmed","summary":"reproduced"}]}`,
	}, "\n"))
	if err != nil {
		t.Fatalf("ParseRunResultOutput err = %v", err)
	}
	if !ok {
		t.Fatal("ParseRunResultOutput ok = false, want true")
	}
	if got.Run.Classification != ClassificationAppFailed || got.Run.Summary != "final" {
		t.Fatalf("run = %+v", got.Run)
	}
	if len(got.Evidence) != 1 || got.Evidence[0].FindingID != "finding-1" || got.Evidence[0].Outcome != EvidenceOutcomeConfirmed {
		t.Fatalf("evidence = %+v", got.Evidence)
	}
}

func TestParseRunResultOutputRejectsInvalidEvidenceOutcome(t *testing.T) {
	_, ok, err := ParseRunResultOutput(`AO_VERDICT {"classification":"passed","evidence":[{"findingId":"finding-1","outcome":"bogus"}]}`)
	if err == nil {
		t.Fatal("ParseRunResultOutput err = nil, want invalid evidence outcome")
	}
	if !ok {
		t.Fatal("ParseRunResultOutput ok = false, want true for malformed verdict payload")
	}
}

func TestParseVerdictLineDerivesClassificationFromPassedInfra(t *testing.T) {
	got, ok, err := ParseVerdictLine(`AO_VERDICT {"passed":false,"infra":true,"summary":"setup failed"}`)
	if err != nil {
		t.Fatalf("ParseVerdictLine err = %v", err)
	}
	if !ok {
		t.Fatal("ParseVerdictLine ok = false, want true")
	}
	if got.Classification != ClassificationInfra {
		t.Fatalf("classification = %q, want %q", got.Classification, ClassificationInfra)
	}
}

func TestParseVerdictLineIgnoresNonVerdictOutput(t *testing.T) {
	got, ok, err := ParseVerdictLine("ordinary runner log line")
	if err != nil {
		t.Fatalf("ParseVerdictLine err = %v", err)
	}
	if ok {
		t.Fatalf("ParseVerdictLine ok = true, verdict = %+v", got)
	}
}

func TestSynthesizeBaselineAppFailureBlocks(t *testing.T) {
	got := Synthesize(SynthesisInput{
		Baseline: TestRun{Classification: ClassificationAppFailed, Summary: "checkout crashes on boot"},
	})

	if got.Outcome != FusedOutcomeAppFailed || !got.Blocking {
		t.Fatalf("outcome = %+v, want blocking app failure", got)
	}
	if len(got.Findings) != 1 || got.Findings[0].Source != EvidenceSourceTestInfra {
		t.Fatalf("findings = %+v, want test-infra baseline finding", got.Findings)
	}
}

func TestSynthesizeInfraAndNotConfiguredDoNotBlock(t *testing.T) {
	for _, classification := range []Classification{ClassificationInfra, ClassificationNotConfigured} {
		got := Synthesize(SynthesisInput{
			Baseline: TestRun{Classification: classification, Summary: string(classification)},
		})
		if got.Blocking {
			t.Fatalf("%s synthesized blocking verdict: %+v", classification, got)
		}
		if got.Outcome != FusedOutcomeNeutral {
			t.Fatalf("%s outcome = %q, want %q", classification, got.Outcome, FusedOutcomeNeutral)
		}
	}
}

func TestSynthesizeChangesRequestedWithoutFindingsIsNeutral(t *testing.T) {
	got := Synthesize(SynthesisInput{
		Baseline:      TestRun{Classification: ClassificationPassed},
		ReviewVerdict: ReviewVerdictChangesRequested,
	})

	if got.Outcome != FusedOutcomeNeutral || got.Blocking {
		t.Fatalf("outcome = %+v, want neutral non-blocking verdict", got)
	}
}

func TestSynthesizeRuntimeConfirmationUpgradesBehavioralFinding(t *testing.T) {
	got := Synthesize(SynthesisInput{
		Baseline:      TestRun{Classification: ClassificationPassed},
		ReviewVerdict: ReviewVerdictChangesRequested,
		Findings: []ReviewFinding{{
			ID:              "finding-1",
			File:            "handlers/diff.go",
			Line:            73,
			Severity:        SeverityHigh,
			Title:           "empty contract panics",
			Claim:           "summarizeDiff dereferences an empty contract",
			FailureScenario: "GET /diff/summary with an empty contract returns 500",
			Behavioral:      true,
		}},
		Evidence: []TestEvidence{{
			FindingID: "finding-1",
			Outcome:   EvidenceOutcomeConfirmed,
			Summary:   "targeted repro returned 500",
		}},
	})

	if got.Outcome != FusedOutcomeChangesRequested || !got.Blocking {
		t.Fatalf("outcome = %+v, want blocking changes requested", got)
	}
	if len(got.Findings) != 1 || got.Findings[0].Source != EvidenceSourceTestInfra || got.Findings[0].RuntimeOutcome != EvidenceOutcomeConfirmed {
		t.Fatalf("findings = %+v, want confirmed test-infra finding", got.Findings)
	}
}

func TestSynthesizeRuntimeRefutationDowngradesBehavioralFinding(t *testing.T) {
	got := Synthesize(SynthesisInput{
		Baseline:      TestRun{Classification: ClassificationPassed},
		ReviewVerdict: ReviewVerdictChangesRequested,
		Findings: []ReviewFinding{{
			ID:         "finding-1",
			Severity:   SeverityHigh,
			Title:      "route 500s",
			Claim:      "route fails at runtime",
			Behavioral: true,
		}},
		Evidence: []TestEvidence{{
			FindingID: "finding-1",
			Outcome:   EvidenceOutcomeRefuted,
			Summary:   "targeted repro returned 200",
		}},
	})

	if got.Blocking || got.Outcome != FusedOutcomeApproved {
		t.Fatalf("outcome = %+v, want non-blocking approved", got)
	}
	if len(got.Findings) != 1 || got.Findings[0].Source != EvidenceSourceTestInfra || got.Findings[0].Blocking {
		t.Fatalf("findings = %+v, want non-blocking runtime-refuted finding", got.Findings)
	}
}
