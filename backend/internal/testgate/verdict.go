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

// Classification describes the outcome of a runtime verification run.
type Classification string

const (
	// ClassificationPassed means runtime verification completed without app failures.
	ClassificationPassed Classification = "passed"
	// ClassificationAppFailed means runtime verification found a product failure.
	ClassificationAppFailed Classification = "app_failed"
	// ClassificationInfra means runtime verification could not produce a product verdict.
	ClassificationInfra Classification = "infra"
	// ClassificationNotConfigured means no runtime verification runner is configured.
	ClassificationNotConfigured Classification = "not_configured"
)

// EvidenceSource identifies where a fused finding's evidence came from.
type EvidenceSource string

const (
	// EvidenceSourceStatic marks findings that only came from the reviewer.
	EvidenceSourceStatic EvidenceSource = "static"
	// EvidenceSourceTestInfra marks findings confirmed or refuted by runtime tests.
	EvidenceSourceTestInfra EvidenceSource = "test-infra"
)

// EvidenceOutcome describes how runtime evidence relates to a reviewer finding.
type EvidenceOutcome string

const (
	// EvidenceOutcomeUntested means the runtime runner did not test the finding.
	EvidenceOutcomeUntested EvidenceOutcome = "not_tested"
	// EvidenceOutcomeConfirmed means runtime evidence reproduced the finding.
	EvidenceOutcomeConfirmed EvidenceOutcome = "confirmed"
	// EvidenceOutcomeRefuted means runtime evidence did not reproduce the finding.
	EvidenceOutcomeRefuted EvidenceOutcome = "refuted"
)

// Severity ranks a reviewer finding's impact.
type Severity string

const (
	// SeverityLow marks a low-impact finding.
	SeverityLow Severity = "low"
	// SeverityMedium marks a medium-impact finding.
	SeverityMedium Severity = "medium"
	// SeverityHigh marks a high-impact finding.
	SeverityHigh Severity = "high"
	// SeverityCritical marks a critical finding.
	SeverityCritical Severity = "critical"
)

// Valid reports whether the severity is one AO accepts.
func (s Severity) Valid() bool {
	switch s {
	case "", SeverityLow, SeverityMedium, SeverityHigh, SeverityCritical:
		return true
	default:
		return false
	}
}

// ReviewVerdict is the reviewer agent's submitted PR verdict.
type ReviewVerdict string

const (
	// ReviewVerdictApproved means the reviewer accepted the PR changes.
	ReviewVerdictApproved ReviewVerdict = "approved"
	// ReviewVerdictChangesRequested means the reviewer found blocking issues.
	ReviewVerdictChangesRequested ReviewVerdict = "changes_requested"
)

// FusedOutcome is the combined reviewer and runtime-verification verdict.
type FusedOutcome string

const (
	// FusedOutcomeApproved means the fused gate accepts the PR changes.
	FusedOutcomeApproved FusedOutcome = "approved"
	// FusedOutcomeChangesRequested means the fused gate has blocking findings.
	FusedOutcomeChangesRequested FusedOutcome = "changes_requested"
	// FusedOutcomeAppFailed means baseline runtime verification failed.
	FusedOutcomeAppFailed FusedOutcome = "app_failed"
	// FusedOutcomeNeutral means the fused gate has no blocking product verdict.
	FusedOutcomeNeutral FusedOutcome = "neutral"
)

// TestRun is one baseline or targeted runtime-verification execution.
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

// RunKind identifies which runtime-verification phase produced a run.
type RunKind string

const (
	// RunKindBaseline verifies the PR before applying specific reviewer findings.
	RunKindBaseline RunKind = "baseline"
	// RunKindTargeted verifies behavioral reviewer findings.
	RunKindTargeted RunKind = "targeted"
)

// ReviewFinding is a structured reviewer finding that may be runtime-testable.
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

// TestEvidence records runtime evidence for one reviewer finding.
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

// SynthesisInput is the data required to fuse reviewer and runtime outcomes.
type SynthesisInput struct {
	Baseline      TestRun
	ReviewVerdict ReviewVerdict
	Findings      []ReviewFinding
	Evidence      []TestEvidence
}

// FusedFinding is one reviewer finding after runtime evidence is applied.
type FusedFinding struct {
	FindingID      string          `json:"findingId,omitempty"`
	File           string          `json:"file,omitempty"`
	Line           int             `json:"line,omitempty"`
	Source         EvidenceSource  `json:"source" enum:"static,test-infra"`
	RuntimeOutcome EvidenceOutcome `json:"runtimeOutcome,omitempty" enum:"not_tested,confirmed,refuted"`
	Severity       Severity        `json:"severity,omitempty" enum:"low,medium,high,critical"`
	Title          string          `json:"title"`
	Claim          string          `json:"claim,omitempty"`
	Summary        string          `json:"summary,omitempty"`
	Blocking       bool            `json:"blocking"`
}

// FusedVerdict is the durable combined verdict shown to the UI and API clients.
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

// ParseVerdictLine extracts the legacy test run payload from an AO_VERDICT line.
func ParseVerdictLine(line string) (TestRun, bool, error) {
	result, ok, err := ParseRunResultLine(line)
	if err != nil || !ok {
		return TestRun{}, ok, err
	}
	return result.Run, true, nil
}

// ParseRunResultLine extracts a test run and evidence payload from an AO_VERDICT line.
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

// ParseRunResultOutput extracts the last AO_VERDICT payload from command output.
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

// Valid reports whether the classification is one AO accepts.
func (c Classification) Valid() bool {
	switch c {
	case ClassificationPassed, ClassificationAppFailed, ClassificationInfra, ClassificationNotConfigured:
		return true
	default:
		return false
	}
}

// Valid reports whether the evidence source is one AO accepts.
func (s EvidenceSource) Valid() bool {
	switch s {
	case EvidenceSourceStatic, EvidenceSourceTestInfra:
		return true
	default:
		return false
	}
}

// Valid reports whether the evidence outcome is one AO accepts.
func (o EvidenceOutcome) Valid() bool {
	switch o {
	case EvidenceOutcomeUntested, EvidenceOutcomeConfirmed, EvidenceOutcomeRefuted:
		return true
	default:
		return false
	}
}

// Synthesize combines reviewer findings with runtime evidence into a fused verdict.
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

	evidenceByFinding := make(map[string]TestEvidence, len(in.Evidence))
	for _, ev := range in.Evidence {
		if ev.FindingID == "" {
			continue
		}
		evidenceByFinding[ev.FindingID] = ev
	}

	out := FusedVerdict{Outcome: FusedOutcomeApproved, Findings: make([]FusedFinding, 0, len(in.Findings))}
	for _, finding := range in.Findings {
		fused := FusedFinding{
			FindingID: finding.ID,
			File:      finding.File,
			Line:      finding.Line,
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
