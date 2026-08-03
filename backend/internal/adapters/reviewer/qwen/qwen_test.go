package qwen

import (
	"context"
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
	if err := os.WriteFile(task, []byte("secret task contents"), 0o600); err != nil {
		t.Fatal(err)
	}
	return ports.ReviewInvocation{
		ReviewerID: "review-worker-1", RunID: "run-1", WorkerSessionID: "worker-1",
		PRURL: "https://github.com/acme/widgets/pull/42", TargetSHA: "0123456789abcdef",
		WorkspacePath: filepath.Join(root, "checkout"), DataDir: filepath.Join(root, "ao-data"),
		Prompt: "Read the AO review task reference.", SystemPrompt: "secret system contents",
		TaskPromptFile: task, TaskPromptRoot: prompts,
	}
}

func TestReviewCommandIsExactPermanentTUIWithPostReadinessReference(t *testing.T) {
	reviewer := New()
	reviewer.resolveBinary = func(context.Context) (string, error) { return "/opt/qwen/bin/qwen", nil }
	inv := invocation(t)

	spec, err := reviewer.ReviewCommand(context.Background(), inv)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"/opt/qwen/bin/qwen", "--bare", "--approval-mode", "plan"}
	if !reflect.DeepEqual(spec.Argv, want) {
		t.Fatalf("argv = %#v, want %#v", spec.Argv, want)
	}
	if spec.InitialMessage != inv.Prompt {
		t.Fatalf("initial message = %q, want short reference %q", spec.InitialMessage, inv.Prompt)
	}
	joined := strings.Join(spec.Argv, " ")
	for _, forbidden := range []string{
		inv.Prompt, inv.SystemPrompt, inv.TaskPromptFile, "secret task contents",
		"--prompt", "--prompt-interactive", " -p ", " -i ", "--output-format",
		"--json", "--json-schema", "--acp", "serve", "--yolo", "--resume",
		"--continue", "--worktree",
	} {
		if strings.Contains(" "+joined+" ", forbidden) {
			t.Fatalf("interactive command contains forbidden value %q: %q", forbidden, joined)
		}
	}
	if spec.WorkingDirectory == inv.WorkspacePath || !strings.HasPrefix(spec.WorkingDirectory, inv.DataDir+string(filepath.Separator)) {
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

func TestReviewCommandRequiresAODataDir(t *testing.T) {
	inv := invocation(t)
	inv.DataDir = ""
	reviewer := New()
	reviewer.resolveBinary = func(context.Context) (string, error) { return "/opt/qwen/bin/qwen", nil }
	if _, err := reviewer.ReviewCommand(context.Background(), inv); err == nil || !strings.Contains(err.Error(), "AO data directory is required") {
		t.Fatalf("ReviewCommand error = %v", err)
	}
}

func TestReviewCommandPreflightShapeNeedsNoRequestData(t *testing.T) {
	reviewer := New()
	reviewer.resolveBinary = func(context.Context) (string, error) { return "/opt/qwen/bin/qwen", nil }
	spec, err := reviewer.ReviewCommand(context.Background(), ports.ReviewInvocation{WorkspacePath: "/ws"})
	if err != nil {
		t.Fatalf("ReviewCommand: %v", err)
	}
	if !reflect.DeepEqual(spec.Argv, []string{"/opt/qwen/bin/qwen"}) {
		t.Fatalf("argv = %#v", spec.Argv)
	}
}

func TestReviewCommandRejectsRelativeBinary(t *testing.T) {
	reviewer := New()
	reviewer.resolveBinary = func(context.Context) (string, error) { return "qwen", nil }
	if _, err := reviewer.ReviewCommand(context.Background(), invocation(t)); err == nil {
		t.Fatal("relative executable accepted")
	}
}

func TestReviewMessageReusesPaneInjectionWithoutAddingAuthority(t *testing.T) {
	inv := invocation(t)
	inv.Prompt = "Read /ao/task.md"
	message, err := New().ReviewMessage(context.Background(), inv)
	if err != nil || message != inv.Prompt {
		t.Fatalf("message = %q, %v", message, err)
	}
}

func TestReviewProcessIsNotReusableBecauseManifestIsLaunchScoped(t *testing.T) {
	if New().ReviewProcessReusable() {
		t.Fatal("Qwen reviewer must launch a fresh process for each task so AO_REVIEW_GATEWAY_MANIFEST cannot go stale")
	}
}

func TestReviewCancelUsesOneEscapeAndNeverCtrlC(t *testing.T) {
	spec, err := New().ReviewCancel(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if spec.Mode != ports.ReviewCancelEscape || spec.Interrupts != 1 {
		t.Fatalf("cancel spec = %+v, want one Escape", spec)
	}
}

func TestQwenReviewerIdentityAndHostTrustWarning(t *testing.T) {
	if New().Harness() != domain.ReviewerQwen {
		t.Fatal("wrong harness")
	}
	for _, phrase := range []string{"host-trusted", "no OS isolation", "! shell"} {
		if !strings.Contains(HostTrustWarning, phrase) {
			t.Fatalf("warning %q does not contain %q", HostTrustWarning, phrase)
		}
	}
}
