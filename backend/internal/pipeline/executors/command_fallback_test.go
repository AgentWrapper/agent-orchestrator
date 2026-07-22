package executors

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// writeStageFindings drops a .ao/pipeline-findings.jsonl into a fresh temp
// workspace and returns the workspace root.
func writeStageFindings(t *testing.T, lines string) string {
	t.Helper()
	ws := t.TempDir()
	dir := filepath.Join(ws, ".ao")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, pipeline.FindingsFilename), []byte(lines), 0o644); err != nil {
		t.Fatalf("write findings: %v", err)
	}
	return ws
}

const validFindingLine = `{"kind":"finding","filePath":"a.go","startLine":1,"endLine":2,"title":"t","description":"d","category":"lint","severity":"warning","confidence":0.5}`

func TestInterpretExit_ExitCodeFallbackModeObservation(t *testing.T) {
	// Fallback (non-envelope) stdout carries a mode observation; envelope does not.
	fallback := interpretExit(commandExit{stageName: "lint", res: CommandResult{ExitCode: 0, Stdout: "ok"}})
	if fallback.Status != OutcomeCompleted || fallback.Verdict != pipeline.VerdictPass {
		t.Fatalf("fallback exit 0 should pass, got %s/%s", fallback.Status, fallback.Verdict)
	}
	if len(fallback.Observations) != 1 || fallback.Observations[0].Name != "command_stage_exit_mode" {
		t.Fatalf("fallback should emit a mode observation, got %+v", fallback.Observations)
	}
	if fallback.Observations[0].Data["mode"] != "exit-code" {
		t.Errorf("want mode=exit-code, got %v", fallback.Observations[0].Data["mode"])
	}

	env := interpretExit(commandExit{stageName: "lint", res: CommandResult{ExitCode: 0, Stdout: `{"outcome":"succeeded"}`}})
	for _, o := range env.Observations {
		if o.Name == "command_stage_exit_mode" {
			t.Errorf("envelope mode must NOT emit a mode observation, got %+v", env.Observations)
		}
	}
}

func TestInterpretExit_OutputCapturedBothModes(t *testing.T) {
	cases := []struct {
		name string
		res  CommandResult
	}{
		{"pass", CommandResult{ExitCode: 0, Stdout: "hello stdout", Stderr: "some stderr"}},
		{"fail", CommandResult{ExitCode: 1, Stdout: "hello stdout", Stderr: "boom"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := interpretExit(commandExit{stageName: "s", res: tc.res})
			if !strings.Contains(out.Output, "hello stdout") {
				t.Errorf("output should include stdout, got %q", out.Output)
			}
			if !strings.Contains(out.Output, tc.res.Stderr) {
				t.Errorf("output should include stderr, got %q", out.Output)
			}
		})
	}
}

func TestInterpretExit_OutputTailCapped(t *testing.T) {
	big := strings.Repeat("x", stageOutputTailCapBytes+4096)
	out := interpretExit(commandExit{stageName: "s", res: CommandResult{ExitCode: 0, Stdout: big}})
	if len(out.Output) != stageOutputTailCapBytes {
		t.Fatalf("output should be capped to %d, got %d", stageOutputTailCapBytes, len(out.Output))
	}
}

func TestInterpretExit_Timeout(t *testing.T) {
	out := interpretExit(commandExit{
		stageName: "test",
		res:       CommandResult{Signal: "terminated", Stderr: "still running"},
		timedOut:  true,
		timeoutMs: 1500,
	})
	if out.Status != OutcomeFailed {
		t.Fatalf("timeout should fail, got %s", out.Status)
	}
	if !strings.Contains(out.ErrorMessage, "timed out after 1500ms") {
		t.Errorf("want timeout reason, got %q", out.ErrorMessage)
	}
}

func TestInterpretExit_FindingsHarvest(t *testing.T) {
	t.Run("envelope plus findings", func(t *testing.T) {
		ws := writeStageFindings(t, validFindingLine+"\n")
		out := interpretExit(commandExit{
			stageName:    "review",
			res:          CommandResult{ExitCode: 0, Stdout: `{"outcome":"succeeded"}`},
			workspaceDir: ws,
		})
		if out.Status != OutcomeCompleted {
			t.Fatalf("want completed, got %s (%s)", out.Status, out.ErrorMessage)
		}
		if len(out.Artifacts) != 1 || out.Artifacts[0].FilePath != "a.go" {
			t.Fatalf("findings should be harvested, got %+v", out.Artifacts)
		}
	})

	t.Run("fallback plus findings", func(t *testing.T) {
		ws := writeStageFindings(t, validFindingLine+"\n")
		out := interpretExit(commandExit{
			stageName:    "review",
			res:          CommandResult{ExitCode: 0, Stdout: "no envelope here"},
			workspaceDir: ws,
		})
		if out.Status != OutcomeCompleted || out.Verdict != pipeline.VerdictPass {
			t.Fatalf("want completed/pass, got %s/%s", out.Status, out.Verdict)
		}
		if len(out.Artifacts) != 1 {
			t.Fatalf("findings should be harvested in fallback mode, got %+v", out.Artifacts)
		}
	})

	t.Run("malformed findings fails", func(t *testing.T) {
		ws := writeStageFindings(t, `{"kind":"finding","filePath":"a.go"}`+"\n")
		out := interpretExit(commandExit{
			stageName:    "review",
			res:          CommandResult{ExitCode: 0, Stdout: "ok"},
			workspaceDir: ws,
		})
		if out.Status != OutcomeFailed {
			t.Fatalf("malformed findings should fail the stage, got %s", out.Status)
		}
		if !strings.Contains(out.ErrorMessage, "unparseable findings") {
			t.Errorf("want unparseable-findings reason, got %q", out.ErrorMessage)
		}
	})

	t.Run("no findings file is fine", func(t *testing.T) {
		ws := t.TempDir()
		out := interpretExit(commandExit{
			stageName:    "review",
			res:          CommandResult{ExitCode: 0, Stdout: "ok"},
			workspaceDir: ws,
		})
		if out.Status != OutcomeCompleted || len(out.Artifacts) != 0 {
			t.Fatalf("no findings file should pass with no artifacts, got %s/%+v", out.Status, out.Artifacts)
		}
	})

	t.Run("findings not harvested when stage failed", func(t *testing.T) {
		ws := writeStageFindings(t, validFindingLine+"\n")
		out := interpretExit(commandExit{
			stageName:    "review",
			res:          CommandResult{ExitCode: 1, Stderr: "boom"},
			workspaceDir: ws,
		})
		if out.Status != OutcomeFailed || len(out.Artifacts) != 0 {
			t.Fatalf("failed stage should not harvest artifacts, got %s/%+v", out.Status, out.Artifacts)
		}
	})
}
