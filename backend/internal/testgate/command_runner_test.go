package testgate

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestCommandRunnerUsesFinalVerdictDespiteNonZeroExit(t *testing.T) {
	runner := helperCommandRunner(t, "verdict")

	got, err := runner.Run(context.Background(), RunRequest{
		Kind:          RunKindBaseline,
		WorkspacePath: t.TempDir(),
		ReviewRun: domain.ReviewRun{
			ID:        "review-run-1",
			SessionID: "mer-1",
			PRURL:     "https://example/pr/1",
			TargetSHA: "sha1",
		},
	})
	if err != nil {
		t.Fatalf("Run err = %v", err)
	}
	if got.Run.Classification != ClassificationAppFailed || got.Run.Summary != "final" {
		t.Fatalf("run = %+v", got.Run)
	}
	if len(got.Evidence) != 1 || got.Evidence[0].Outcome != EvidenceOutcomeConfirmed {
		t.Fatalf("evidence = %+v", got.Evidence)
	}
}

func TestCommandRunnerSendsRequestOnStdinAndEnv(t *testing.T) {
	runner := helperCommandRunner(t, "request")

	got, err := runner.Run(context.Background(), RunRequest{
		Kind:          RunKindTargeted,
		WorkspacePath: t.TempDir(),
		ReviewRun: domain.ReviewRun{
			ID:        "review-run-2",
			SessionID: "mer-2",
			PRURL:     "https://example/pr/2",
			TargetSHA: "sha2",
		},
		Findings: []ReviewFinding{{ID: "finding-1", Title: "route fails", Behavioral: true}},
	})
	if err != nil {
		t.Fatalf("Run err = %v", err)
	}
	if got.Run.Classification != ClassificationPassed {
		t.Fatalf("run = %+v", got.Run)
	}
}

func TestCommandRunnerNoVerdictIsInfra(t *testing.T) {
	runner := helperCommandRunner(t, "no-verdict")

	got, err := runner.Run(context.Background(), RunRequest{Kind: RunKindBaseline, WorkspacePath: t.TempDir()})
	if err != nil {
		t.Fatalf("Run err = %v", err)
	}
	if got.Run.Classification != ClassificationInfra {
		t.Fatalf("classification = %q, want %q", got.Run.Classification, ClassificationInfra)
	}
}

func helperCommandRunner(t *testing.T, mode string) *CommandRunner {
	t.Helper()
	return NewCommandRunner(CommandRunnerOptions{
		Command: os.Args[0],
		Args:    []string{"-test.run=TestCommandRunnerHelper", "--"},
		Env: map[string]string{
			"AO_TEST_GATE_HELPER":      "1",
			"AO_TEST_GATE_HELPER_MODE": mode,
		},
		Timeout: 10 * time.Second,
	})
}

func TestCommandRunnerHelper(t *testing.T) {
	if os.Getenv("AO_TEST_GATE_HELPER") != "1" {
		return
	}
	switch os.Getenv("AO_TEST_GATE_HELPER_MODE") {
	case "verdict":
		fmt.Println(`AO_VERDICT {"classification":"passed","summary":"early"}`)
		fmt.Fprintln(os.Stderr, `AO_VERDICT {"classification":"app_failed","summary":"final","evidence":[{"findingId":"finding-1","outcome":"confirmed","summary":"reproduced"}]}`)
		os.Exit(7)
	case "request":
		raw, _ := io.ReadAll(os.Stdin)
		body := string(raw)
		if os.Getenv("AO_TEST_GATE_KIND") != string(RunKindTargeted) ||
			os.Getenv("AO_TEST_GATE_REVIEW_RUN_ID") != "review-run-2" ||
			os.Getenv("AO_TEST_GATE_SESSION_ID") != "mer-2" ||
			!strings.Contains(body, `"workspacePath"`) ||
			!strings.Contains(body, `"findings"`) {
			fmt.Println(`AO_VERDICT {"classification":"infra","summary":"missing request context"}`)
			os.Exit(0)
		}
		fmt.Println(`AO_VERDICT {"classification":"passed","summary":"request ok"}`)
		os.Exit(0)
	case "no-verdict":
		fmt.Println("finished without a machine-readable verdict")
		os.Exit(0)
	default:
		fmt.Println(`AO_VERDICT {"classification":"infra","summary":"unknown helper mode"}`)
		os.Exit(0)
	}
}
