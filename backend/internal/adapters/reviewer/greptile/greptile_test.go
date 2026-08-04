package greptile

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestReviewCommandUsesJSONAndPRBaseBranch(t *testing.T) {
	command, err := New().ReviewCommand(context.Background(), ports.ReviewInvocation{
		ReviewQueue: []ports.ReviewTask{{TargetBranch: "develop"}},
		ReviewIndex: 0,
	})
	if err != nil {
		t.Fatalf("ReviewCommand: %v", err)
	}
	got := strings.Join(command.Argv, " ")
	if got != "greptile review --json --branch develop" {
		t.Fatalf("command = %q", got)
	}
}

func TestGreptileAuthStatusFromWhoamiOutput(t *testing.T) {
	tests := []struct {
		name   string
		output string
		want   ports.AgentAuthStatus
		known  bool
	}{
		{name: "signed in", output: "Signed in as reviewer@example.com", want: ports.AgentAuthStatusAuthorized, known: true},
		{name: "not signed in", output: "Not signed in. Run `greptile login`.", want: ports.AgentAuthStatusUnauthorized, known: true},
		{name: "invalid key", output: "error: API key invalid or revoked", want: ports.AgentAuthStatusUnauthorized, known: true},
		{name: "network failure", output: "error: request failed", want: ports.AgentAuthStatusUnknown, known: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, known := greptileAuthStatusFromOutput([]byte(tt.output))
			if got != tt.want || known != tt.known {
				t.Fatalf("greptileAuthStatusFromOutput(%q) = (%q, %v), want (%q, %v)", tt.output, got, known, tt.want, tt.known)
			}
		})
	}
}

func TestGreptileLocalAuthStatus(t *testing.T) {
	tests := []struct {
		name     string
		contents string
		apiKey   string
		want     ports.AgentAuthStatus
		known    bool
	}{
		{name: "missing", want: ports.AgentAuthStatusUnknown, known: false},
		{name: "oauth refresh token", contents: `{"method":"oauth","refreshToken":"refresh"}`, want: ports.AgentAuthStatusAuthorized, known: true},
		{name: "legacy oauth file", contents: `{"accessToken":"access"}`, want: ports.AgentAuthStatusAuthorized, known: true},
		{name: "api key file", contents: `{"method":"apikey","apiKey":"key"}`, want: ports.AgentAuthStatusAuthorized, known: true},
		{name: "environment api key", apiKey: "key", want: ports.AgentAuthStatusAuthorized, known: true},
		{name: "empty credentials", contents: `{"method":"oauth"}`, want: ports.AgentAuthStatusUnknown, known: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "auth.json")
			if tt.contents != "" {
				if err := os.WriteFile(path, []byte(tt.contents), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			got, known, err := greptileLocalAuthStatusAt(path, tt.apiKey)
			if err != nil {
				t.Fatalf("greptileLocalAuthStatusAt: %v", err)
			}
			if got != tt.want || known != tt.known {
				t.Fatalf("greptileLocalAuthStatusAt = (%q, %v), want (%q, %v)", got, known, tt.want, tt.known)
			}
		})
	}
}

func TestParseReviewResultWithFindings(t *testing.T) {
	result, err := New().ParseReviewResult([]byte(`{
		"summary":"Adds the reviewer integration.",
		"confidence":3,
		"confidenceReasoning":"One issue should be fixed.",
		"securitySummary":"No broad security concerns.",
		"comments":[{
			"path":"backend/reviewer.go",
			"startLine":41,
			"endLine":43,
			"severity":"P1",
			"securityIssue":true,
			"body":"Cancellation can race completion.",
			"suggestion":"Guard the active job id."
		}]
	}`))
	if err != nil {
		t.Fatalf("ParseReviewResult: %v", err)
	}
	if result.Verdict != domain.VerdictChangesRequested {
		t.Fatalf("verdict = %q", result.Verdict)
	}
	for _, want := range []string{
		"## Greptile review",
		"**Confidence:** 3/5",
		"P1 · Security · `backend/reviewer.go:41-43`",
		"Cancellation can race completion.",
		"> Guard the active job id.",
	} {
		if !strings.Contains(result.Body, want) {
			t.Errorf("body missing %q:\n%s", want, result.Body)
		}
	}
}

func TestParseReviewResultWithoutFindingsApproves(t *testing.T) {
	result, err := New().ParseReviewResult([]byte(`{"summary":"Looks good.","comments":[]}`))
	if err != nil {
		t.Fatalf("ParseReviewResult: %v", err)
	}
	if result.Verdict != domain.VerdictApproved {
		t.Fatalf("verdict = %q", result.Verdict)
	}
	if !strings.Contains(result.Body, "No actionable findings.") {
		t.Fatalf("body = %q", result.Body)
	}
}

func TestParseReviewResultRejectsNonJSONOutput(t *testing.T) {
	if _, err := New().ParseReviewResult([]byte("review failed")); err == nil {
		t.Fatal("expected malformed output error")
	}
}

func TestPrepareTerminalRequestWritesDisplayOnlyCommand(t *testing.T) {
	path := filepath.Join(t.TempDir(), "request.json")
	command, err := New().PrepareTerminalRequest(path, []ports.ReviewTask{{
		RunID: "run-1", PRURL: "https://github.com/acme/repo/pull/4", TargetSHA: "sha-1", TargetBranch: "main", WorkspacePath: t.TempDir(),
	}})
	if err != nil {
		t.Fatalf("PrepareTerminalRequest: %v", err)
	}
	aoExecutable, err := resolveAOExecutable()
	if err != nil {
		t.Fatalf("resolveAOExecutable: %v", err)
	}
	if strings.Join(command.Argv, " ") != aoExecutable+" review-terminal "+path {
		t.Fatalf("command = %#v", command.Argv)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read request: %v", err)
	}
	var request struct {
		ResultPath string `json:"resultPath"`
		Tasks      []struct {
			TargetBranch string `json:"targetBranch"`
		} `json:"tasks"`
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	if request.ResultPath != TerminalResultPath(path) || len(request.Tasks) != 1 || request.Tasks[0].TargetBranch != "main" {
		t.Fatalf("request = %+v", request)
	}
	if _, err := os.Stat(TerminalResultPath(path)); err != nil {
		t.Fatalf("initial result sidecar: %v", err)
	}
	recovered, err := New().ReadTerminalRequest(path)
	if err != nil {
		t.Fatalf("ReadTerminalRequest: %v", err)
	}
	if recovered.Version != terminalRequestVersion || recovered.WorkerID != "" || recovered.BatchID != "" || recovered.Harness != domain.ReviewerGreptile || recovered.DeadlineAt.IsZero() || len(recovered.Tasks) != 1 || recovered.Tasks[0].RunID != "run-1" {
		t.Fatalf("recovered request = %+v", recovered)
	}
}

func TestPrepareTerminalRequestRejectsDurablePathReuse(t *testing.T) {
	dataDir := t.TempDir()
	path := filepath.Join(dataDir, "reviews", "worker-1", "terminal", "batch-1", "run-1.json")
	task := ports.ReviewTask{RunID: "run-1", PRURL: "https://github.com/acme/repo/pull/4", TargetSHA: "sha-1", WorkspacePath: t.TempDir()}
	if _, err := New().PrepareTerminalRequest(path, []ports.ReviewTask{task}); err != nil {
		t.Fatalf("initial PrepareTerminalRequest: %v", err)
	}
	reused := task
	reused.RunID = "run-2"
	if _, err := New().PrepareTerminalRequest(path, []ports.ReviewTask{reused}); err == nil || !strings.Contains(err.Error(), "task list does not match") {
		t.Fatalf("reused durable request error = %v, want task identity mismatch", err)
	}
}

func TestCommandFailureClassifiesMissingAuthentication(t *testing.T) {
	err := commandFailure(errors.New("exit status 1"), "error: Not signed in. Run `greptile login`.")
	if got, want := err.Error(), "greptile CLI is not authenticated. Run greptile login and retry"; got != want {
		t.Fatalf("error = %q, want %q", got, want)
	}
}

func TestCommandFailureClassifiesMissingBinary(t *testing.T) {
	err := commandFailure(exec.ErrNotFound, "")
	if !errors.Is(err, ports.ErrAgentBinaryNotFound) {
		t.Fatalf("error = %v, want ErrAgentBinaryNotFound", err)
	}
	if !strings.Contains(err.Error(), "Install it") {
		t.Fatalf("error = %q, want install guidance", err)
	}
}

func TestCommandFailureBoundsAndRedactsDiagnostic(t *testing.T) {
	diagnostic := "GREPTILE_API_KEY=super-secret " + strings.Repeat("x", terminalStderrLimit+100)
	err := commandFailure(errors.New("exit status 1"), diagnostic)
	if strings.Contains(err.Error(), "super-secret") {
		t.Fatalf("error leaked credential: %q", err)
	}
	if len(err.Error()) > terminalStderrLimit+256 {
		t.Fatalf("error length = %d, want bounded", len(err.Error()))
	}
}

func TestTerminalSummaryTruthfullyReportsOutcomes(t *testing.T) {
	cases := []struct {
		succeeded, failed, total int
		want                     string
	}{
		{2, 0, 2, "Greptile review finished. AO will process the result and attempt to post any findings to GitHub."},
		{1, 1, 2, "Greptile review finished with 1 of 2 reviews failed. See the errors above."},
		{0, 2, 2, "Greptile review failed. No review result was posted."},
	}
	for _, tc := range cases {
		if got := terminalSummary(tc.succeeded, tc.failed, tc.total); got != tc.want {
			t.Errorf("terminalSummary(%d,%d,%d) = %q, want %q", tc.succeeded, tc.failed, tc.total, got, tc.want)
		}
	}
}

func TestParseTerminalResultPreservesInlineComments(t *testing.T) {
	result, err := New().ParseTerminalResult([]byte(`{"complete":true,"results":[{"runId":"run-1","prUrl":"https://github.com/acme/repo/pull/4","targetSha":"sha-1","verdict":"changes_requested","body":"fix it","comments":[{"path":"main.go","startLine":4,"endLine":5,"side":"RIGHT","body":"bug"}]}]}`))
	if err != nil {
		t.Fatalf("ParseTerminalResult: %v", err)
	}
	if !result.Complete || len(result.Results) != 1 || len(result.Results[0].Comments) != 1 {
		t.Fatalf("result = %+v", result)
	}
	comment := result.Results[0].Comments[0]
	if comment.Path != "main.go" || comment.StartLine != 4 || comment.EndLine != 5 || comment.Side != "RIGHT" {
		t.Fatalf("comment = %+v", comment)
	}
}
