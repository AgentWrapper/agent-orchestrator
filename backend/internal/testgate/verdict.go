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

// Classification is the high-level result of a runtime verification run.
type Classification string

const (
	// ClassificationPassed means the pod run completed successfully.
	ClassificationPassed Classification = "passed"
	// ClassificationAppFailed means the app under test failed verification.
	ClassificationAppFailed Classification = "app_failed"
	// ClassificationInfra means the run failed for infrastructure reasons.
	ClassificationInfra Classification = "infra"
	// ClassificationNotConfigured means no pod runner is configured.
	ClassificationNotConfigured Classification = "not_configured"
)

// EvidenceSource identifies where finding evidence originated.
type EvidenceSource string

const (
	// EvidenceSourceStatic is reviewer-provided static evidence.
	EvidenceSourceStatic EvidenceSource = "static"
	// EvidenceSourceTestInfra is evidence produced by the runtime test gate.
	EvidenceSourceTestInfra EvidenceSource = "test-infra"
)

// EvidenceOutcome is how runtime verification treated a finding.
type EvidenceOutcome string

const (
	// EvidenceOutcomeUntested means the finding was not exercised.
	EvidenceOutcomeUntested EvidenceOutcome = "not_tested"
	// EvidenceOutcomeConfirmed means the finding was reproduced.
	EvidenceOutcomeConfirmed EvidenceOutcome = "confirmed"
	// EvidenceOutcomeRefuted means the finding was not reproduced.
	EvidenceOutcomeRefuted EvidenceOutcome = "refuted"
)

// Severity is the reviewer-reported impact of a finding.
type Severity string

const (
	// SeverityLow is a low-impact finding.
	SeverityLow Severity = "low"
	// SeverityMedium is a medium-impact finding.
	SeverityMedium Severity = "medium"
	// SeverityHigh is a high-impact finding.
	SeverityHigh Severity = "high"
	// SeverityCritical is a critical-impact finding.
	SeverityCritical Severity = "critical"
)

// Valid reports whether s is an empty or known severity value.
func (s Severity) Valid() bool {
	switch s {
	case "", SeverityLow, SeverityMedium, SeverityHigh, SeverityCritical:
		return true
	default:
		return false
	}
}

// ReviewVerdict is the reviewer's overall decision for a PR head.
type ReviewVerdict string

const (
	// ReviewVerdictApproved means the reviewer approved the head.
	ReviewVerdictApproved ReviewVerdict = "approved"
	// ReviewVerdictChangesRequested means the reviewer requested changes.
	ReviewVerdictChangesRequested ReviewVerdict = "changes_requested"
)

// FusedOutcome is the combined reviewer + runtime-verification decision.
type FusedOutcome string

const (
	// FusedOutcomeApproved means no blocking issues remain after fusion.
	FusedOutcomeApproved FusedOutcome = "approved"
	// FusedOutcomeChangesRequested means blocking findings remain.
	FusedOutcomeChangesRequested FusedOutcome = "changes_requested"
	// FusedOutcomeAppFailed means baseline runtime verification failed.
	FusedOutcomeAppFailed FusedOutcome = "app_failed"
	// FusedOutcomeNeutral means evidence was inconclusive or unavailable.
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

// RunKind distinguishes baseline pod runs from targeted finding verification.
type RunKind string

const (
	// RunKindBaseline is a full baseline verification for a PR head.
	RunKindBaseline RunKind = "baseline"
	// RunKindTargeted verifies specific reviewer findings.
	RunKindTargeted RunKind = "targeted"
)

// ReviewFinding is one durable reviewer finding eligible for runtime checks.
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

// TestEvidence links a runtime outcome to a specific finding.
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

// SynthesisInput is the reviewer + runtime inputs used to fuse a final verdict.
type SynthesisInput struct {
	Baseline      TestRun
	ReviewVerdict ReviewVerdict
	Findings      []ReviewFinding
	Evidence      []TestEvidence
}

// FusedFinding is one finding after reviewer and runtime evidence are combined.
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

// FusedVerdict is the durable fused decision shown in API/UI surfaces.
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

// ParseVerdictLine extracts a TestRun from a single AO_VERDICT line.
func ParseVerdictLine(line string) (TestRun, bool, error) {
	result, ok, err := ParseRunResultLine(line)
	if err != nil || !ok {
		return TestRun{}, ok, err
	}
	return result.Run, true, nil
}

// ParseRunResultLine extracts a RunResult from a single AO_VERDICT line.
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

// ParseRunResultOutput finds the last AO_VERDICT line in multi-line command output.
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

// Valid reports whether c is a known classification value.
func (c Classification) Valid() bool {
	switch c {
	case ClassificationPassed, ClassificationAppFailed, ClassificationInfra, ClassificationNotConfigured:
		return true
	default:
		return false
	}
}

// Valid reports whether s is a known evidence source.
func (s EvidenceSource) Valid() bool {
	switch s {
	case EvidenceSourceStatic, EvidenceSourceTestInfra:
		return true
	default:
		return false
	}
}

// Valid reports whether o is a known evidence outcome.
func (o EvidenceOutcome) Valid() bool {
	switch o {
	case EvidenceOutcomeUntested, EvidenceOutcomeConfirmed, EvidenceOutcomeRefuted:
		return true
	default:
		return false
	}
}

// Synthesize fuses baseline classification, reviewer verdict, findings, and
// runtime evidence into a single FusedVerdict.
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
