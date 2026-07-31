package qwen

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func invocation(t *testing.T) ports.ReviewInvocation {
	t.Helper()
	root := t.TempDir()
	prompts := filepath.Join(root, "prompts")
	if err := os.MkdirAll(prompts, 0o700); err != nil {
		t.Fatal(err)
	}
	task := filepath.Join(prompts, "task.md")
	system := filepath.Join(prompts, "system.md")
	if err := os.WriteFile(task, []byte("task"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(system, []byte("review read-only"), 0o600); err != nil {
		t.Fatal(err)
	}
	return ports.ReviewInvocation{
		ReviewerID: "review-worker-1", RunID: "run-1", WorkerSessionID: "worker-1",
		PRURL: "https://github.com/acme/widgets/pull/42", TargetSHA: "0123456789abcdef",
		WorkspacePath: filepath.Join(root, "checkout"), Prompt: "Read the hidden task file.",
		SystemPromptFile: system, TaskPromptFile: task, TaskPromptRoot: prompts,
	}
}

func TestInteractiveCommandSpecIsPermanentTUIInNeutralGatewayEnvironment(t *testing.T) {
	reviewer := New(t.TempDir())
	reviewer.resolveBinary = func(context.Context) (string, error) { return "/opt/qwen/bin/qwen", nil }
	inv := invocation(t)

	spec, err := reviewer.interactiveCommandSpec(context.Background(), inv)
	if err != nil {
		t.Fatal(err)
	}
	wantPrefix := []string{
		"/opt/qwen/bin/qwen", "--bare", "--approval-mode", "plan", "--chat-recording=false",
		"--mcp-config", `{"mcpServers":{}}`, "--append-system-prompt", "review read-only",
		"--prompt-interactive", "Read the hidden task file.",
	}
	if !reflect.DeepEqual(spec.Argv, wantPrefix) {
		t.Fatalf("argv = %#v", spec.Argv)
	}
	joined := strings.Join(spec.Argv, " ")
	for _, forbidden := range []string{" -p ", "--prompt ", "--output-format", "--json-schema", "--acp", " serve", "--yolo"} {
		if strings.Contains(" "+joined+" ", forbidden) {
			t.Fatalf("interactive command contains forbidden mode %q: %q", forbidden, joined)
		}
	}
	if spec.WorkingDirectory == inv.WorkspacePath || !strings.HasPrefix(spec.WorkingDirectory, reviewer.dataDir+string(filepath.Separator)) {
		t.Fatalf("working directory = %q", spec.WorkingDirectory)
	}
	if spec.Env["HOME"] == "" || spec.Env["TMPDIR"] == "" || spec.Env["AO_REVIEW_GATEWAY_MANIFEST"] == "" {
		t.Fatalf("neutral environment = %#v", spec.Env)
	}
	if strings.HasPrefix(spec.Env["HOME"], inv.WorkspacePath) {
		t.Fatalf("HOME points into checkout: %q", spec.Env["HOME"])
	}
	if _, err := os.Stat(spec.Env["AO_REVIEW_GATEWAY_MANIFEST"]); err != nil {
		t.Fatalf("gateway manifest: %v", err)
	}
}

func TestReviewCommandFailsClosedBeforeRuntimeLaunch(t *testing.T) {
	reviewer := New(t.TempDir())
	if _, err := reviewer.ReviewCommand(context.Background(), invocation(t)); !errors.Is(err, ErrIsolationUnavailable) {
		t.Fatalf("ReviewCommand err = %v, want isolation blocker", err)
	}
}

func TestInteractiveCommandSpecRejectsRelativeBinary(t *testing.T) {
	reviewer := New(t.TempDir())
	reviewer.resolveBinary = func(context.Context) (string, error) { return "qwen", nil }
	if _, err := reviewer.interactiveCommandSpec(context.Background(), invocation(t)); err == nil {
		t.Fatal("relative executable accepted")
	}
}

func TestReviewMessageReusesPaneInjection(t *testing.T) {
	reviewer := New(t.TempDir())
	inv := invocation(t)
	inv.Prompt = "Read /ao/task.md"
	message, err := reviewer.ReviewMessage(context.Background(), inv)
	if err != nil || !strings.HasPrefix(message, "Read /ao/task.md\nAO review gateway manifest: `") {
		t.Fatalf("message = %q, %v", message, err)
	}
	manifest := strings.TrimSuffix(strings.TrimPrefix(message, "Read /ao/task.md\nAO review gateway manifest: `"), "`.")
	if _, err := os.Stat(manifest); err != nil {
		t.Fatalf("follow-up manifest: %v", err)
	}
}

func TestReviewCancelUsesOneCtrlC(t *testing.T) {
	reviewer := New(t.TempDir())
	spec, err := reviewer.ReviewCancel(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if spec.Mode != ports.ReviewCancelInterrupt || spec.Interrupts != 1 {
		t.Fatalf("cancel spec = %+v", spec)
	}
}

func TestQwenReviewerIdentityIsReservedButDisabled(t *testing.T) {
	if New(t.TempDir()).Harness() != domain.ReviewerQwen {
		t.Fatal("wrong harness")
	}
	if domain.ReviewerQwen.IsKnown() {
		t.Fatal("Qwen must remain outside the enabled reviewer vocabulary")
	}
}
