// Package testgate owns the runtime-verification contract used to combine
// reviewer findings with pod execution evidence.
package testgate

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const verdictPrefix = "AO_VERDICT "

type Classification string

const (
	ClassificationPassed        Classification = "passed"
	ClassificationAppFailed     Classification = "app_failed"
	ClassificationInfra         Classification = "infra"
	ClassificationNotConfigured Classification = "not_configured"
)

type EvidenceSource string

const (
	EvidenceSourceStatic    EvidenceSource = "static"
	EvidenceSourceTestInfra EvidenceSource = "test-infra"
)

type EvidenceOutcome string

const (
	EvidenceOutcomeUntested  EvidenceOutcome = "not_tested"
	EvidenceOutcomeConfirmed EvidenceOutcome = "confirmed"
	EvidenceOutcomeRefuted   EvidenceOutcome = "refuted"
)

type Severity string

const (
	SeverityLow      Severity = "low"
	SeverityMedium   Severity = "medium"
	SeverityHigh     Severity = "high"
	SeverityCritical Severity = "critical"
)

type ReviewVerdict string

const (
	ReviewVerdictApproved         ReviewVerdict = "approved"
	ReviewVerdictChangesRequested ReviewVerdict = "changes_requested"
)

type FusedOutcome string

const (
	FusedOutcomeApproved         FusedOutcome = "approved"
	FusedOutcomeChangesRequested FusedOutcome = "changes_requested"
	FusedOutcomeAppFailed        FusedOutcome = "app_failed"
	FusedOutcomeNeutral          FusedOutcome = "neutral"
)

type TestRun struct {
	ID             string         `json:"id,omitempty"`
	SessionID      string         `json:"sessionId,omitempty"`
	ReviewRunID    string         `json:"reviewRunId,omitempty"`
	PRURL          string         `json:"prUrl,omitempty"`
	TargetSHA      string         `json:"targetSha,omitempty"`
	Kind           RunKind        `json:"kind,omitempty"`
	Classification Classification `json:"classification"`
	Summary        string         `json:"summary,omitempty"`
	Artifacts      []string       `json:"artifacts,omitempty"`
	PodHandleID    string         `json:"podHandleId,omitempty"`
	CreatedAt      time.Time      `json:"createdAt,omitempty"`
}

type verdictPayload struct {
	TestRun
	Evidence     []TestEvidence `json:"evidence,omitempty"`
	Passed       *bool          `json:"passed,omitempty"`
	Infra        bool           `json:"infra,omitempty"`
	ArtifactsURL string         `json:"artifactsUrl,omitempty"`
}

type RunKind string

const (
	RunKindBaseline RunKind = "baseline"
	RunKindTargeted RunKind = "targeted"
)

type ReviewFinding struct {
	ID              string    `json:"id"`
	RunID           string    `json:"runId,omitempty"`
	File            string    `json:"file,omitempty"`
	Line            int       `json:"line,omitempty"`
	Severity        Severity  `json:"severity,omitempty" enum:"low,medium,high,critical"`
	Title           string    `json:"title"`
	Claim           string    `json:"claim,omitempty"`
	FailureScenario string    `json:"failureScenario,omitempty"`
	Behavioral      bool      `json:"behavioral"`
	CreatedAt       time.Time `json:"createdAt,omitempty"`
}

type TestEvidence struct {
	ID        string          `json:"id,omitempty"`
	TestRunID string          `json:"testRunId,omitempty"`
	FindingID string          `json:"findingId,omitempty"`
	Source    EvidenceSource  `json:"source,omitempty" enum:"static,test-infra"`
	Outcome   EvidenceOutcome `json:"outcome" enum:"not_tested,confirmed,refuted"`
	Summary   string          `json:"summary,omitempty"`
	Artifacts []string        `json:"artifacts,omitempty"`
	CreatedAt time.Time       `json:"createdAt,omitempty"`
}

type SynthesisInput struct {
	Baseline      TestRun
	ReviewVerdict ReviewVerdict
	Findings      []ReviewFinding
	Evidence      []TestEvidence
}

type FusedFinding struct {
	FindingID      string          `json:"findingId,omitempty"`
	Source         EvidenceSource  `json:"source" enum:"static,test-infra"`
	RuntimeOutcome EvidenceOutcome `json:"runtimeOutcome,omitempty" enum:"not_tested,confirmed,refuted"`
	Severity       Severity        `json:"severity,omitempty" enum:"low,medium,high,critical"`
	Title          string          `json:"title"`
	Claim          string          `json:"claim,omitempty"`
	Summary        string          `json:"summary,omitempty"`
	Blocking       bool            `json:"blocking"`
}

type FusedVerdict struct {
	ID          string         `json:"id,omitempty"`
	SessionID   string         `json:"sessionId,omitempty"`
	ReviewRunID string         `json:"reviewRunId,omitempty"`
	TestRunID   string         `json:"testRunId,omitempty"`
	PRURL       string         `json:"prUrl,omitempty"`
	TargetSHA   string         `json:"targetSha,omitempty"`
	Outcome     FusedOutcome   `json:"outcome" enum:"approved,changes_requested,app_failed,neutral"`
	Blocking    bool           `json:"blocking"`
	Summary     string         `json:"summary,omitempty"`
	Findings    []FusedFinding `json:"findings"`
	CreatedAt   time.Time      `json:"createdAt,omitempty"`
}

func ParseVerdictLine(line string) (TestRun, bool, error) {
	result, ok, err := ParseRunResultLine(line)
	if err != nil || !ok {
		return TestRun{}, ok, err
	}
	return result.Run, true, nil
}

func ParseRunResultLine(line string) (RunResult, bool, error) {
	idx := strings.Index(line, verdictPrefix)
	if idx < 0 {
		return RunResult{}, false, nil
	}
	raw := strings.TrimSpace(line[idx+len(verdictPrefix):])
	if raw == "" {
		return RunResult{}, true, fmt.Errorf("testgate: empty AO_VERDICT payload")
	}
	var payload verdictPayload
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return RunResult{}, true, fmt.Errorf("testgate: decode AO_VERDICT: %w", err)
	}
	run := payload.TestRun
	if !run.Classification.Valid() && payload.Passed != nil {
		switch {
		case payload.Infra:
			run.Classification = ClassificationInfra
		case *payload.Passed:
			run.Classification = ClassificationPassed
		default:
			run.Classification = ClassificationAppFailed
		}
	}
	if payload.ArtifactsURL != "" && len(run.Artifacts) == 0 {
		run.Artifacts = []string{payload.ArtifactsURL}
	}
	if !run.Classification.Valid() {
		return RunResult{}, true, fmt.Errorf("testgate: invalid classification %q", run.Classification)
	}
	for i, evidence := range payload.Evidence {
		if strings.TrimSpace(evidence.FindingID) == "" {
			return RunResult{}, true, fmt.Errorf("testgate: evidence %d missing findingId", i)
		}
		if evidence.Source != "" && !evidence.Source.Valid() {
			return RunResult{}, true, fmt.Errorf("testgate: evidence %d invalid source %q", i, evidence.Source)
		}
		if !evidence.Outcome.Valid() {
			return RunResult{}, true, fmt.Errorf("testgate: evidence %d invalid outcome %q", i, evidence.Outcome)
		}
	}
	return RunResult{Run: run, Evidence: payload.Evidence}, true, nil
}

func ParseRunResultOutput(output string) (RunResult, bool, error) {
	var last string
	for _, line := range strings.Split(output, "\n") {
		if strings.Contains(line, verdictPrefix) {
			last = line
		}
	}
	if last == "" {
		return RunResult{}, false, nil
	}
	return ParseRunResultLine(last)
}

func (c Classification) Valid() bool {
	switch c {
	case ClassificationPassed, ClassificationAppFailed, ClassificationInfra, ClassificationNotConfigured:
		return true
	default:
		return false
	}
}

func (s EvidenceSource) Valid() bool {
	switch s {
	case EvidenceSourceStatic, EvidenceSourceTestInfra:
		return true
	default:
		return false
	}
}

func (o EvidenceOutcome) Valid() bool {
	switch o {
	case EvidenceOutcomeUntested, EvidenceOutcomeConfirmed, EvidenceOutcomeRefuted:
		return true
	default:
		return false
	}
}

func Synthesize(in SynthesisInput) FusedVerdict {
	switch in.Baseline.Classification {
	case ClassificationAppFailed:
		return FusedVerdict{
			Outcome:  FusedOutcomeAppFailed,
			Blocking: true,
			Summary:  in.Baseline.Summary,
			Findings: []FusedFinding{{
				Source:   EvidenceSourceTestInfra,
				Title:    firstNonEmpty(in.Baseline.Summary, "Runtime verification failed"),
				Summary:  in.Baseline.Summary,
				Blocking: true,
			}},
		}
	case ClassificationInfra, ClassificationNotConfigured:
		return FusedVerdict{Outcome: FusedOutcomeNeutral, Summary: in.Baseline.Summary}
	}
	if len(in.Findings) == 0 {
		if in.ReviewVerdict == ReviewVerdictApproved {
			return FusedVerdict{Outcome: FusedOutcomeApproved}
		}
		return FusedVerdict{Outcome: FusedOutcomeNeutral}
	}

	evidenceByFinding := map[string]TestEvidence{}
	for _, ev := range in.Evidence {
		if ev.FindingID == "" {
			continue
		}
		evidenceByFinding[ev.FindingID] = ev
	}

	out := FusedVerdict{Outcome: FusedOutcomeApproved}
	for _, finding := range in.Findings {
		fused := FusedFinding{
			FindingID: finding.ID,
			Source:    EvidenceSourceStatic,
			Severity:  finding.Severity,
			Title:     finding.Title,
			Claim:     finding.Claim,
			Summary:   finding.FailureScenario,
			Blocking:  in.ReviewVerdict == ReviewVerdictChangesRequested,
		}
		if ev, ok := evidenceByFinding[finding.ID]; ok {
			fused.Source = EvidenceSourceTestInfra
			fused.RuntimeOutcome = ev.Outcome
			if ev.Summary != "" {
				fused.Summary = ev.Summary
			}
			switch ev.Outcome {
			case EvidenceOutcomeConfirmed:
				fused.Blocking = true
			case EvidenceOutcomeRefuted:
				if finding.Behavioral {
					fused.Blocking = false
				}
			}
		}
		if fused.Blocking {
			out.Blocking = true
			out.Outcome = FusedOutcomeChangesRequested
		}
		out.Findings = append(out.Findings, fused)
	}
	return out
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
