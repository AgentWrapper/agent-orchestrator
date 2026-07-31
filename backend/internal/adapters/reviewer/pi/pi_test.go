package pi

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func testReviewer(help string) *Reviewer {
	return &Reviewer{
		resolveBinary: func(context.Context) (string, error) { return "pi", nil },
		runHelp:       func(context.Context, string) ([]byte, error) { return []byte(help), nil },
	}
}

func TestExtensionRejectsCommandInjectionSurfaces(t *testing.T) {
	text := string(extensionSource)
	// The model never supplies a command line: the sole process helper receives
	// only fixed executable names, and every subprocess receives an argv array.
	runCall := regexp.MustCompile(`run\(pi,\s*([^,]+),`)
	for _, match := range runCall.FindAllStringSubmatch(text, -1) {
		if match[1] != `"git"` && match[1] != `"gh"` && match[1] != `"ao"` {
			t.Fatalf("extension has non-constant executable in %q", match[0])
		}
	}
	for _, want := range []string{
		`ref.startsWith("-")`,
		`!/^[A-Za-z0-9._/@{}~^+-]+$/.test(ref)`,
		`args.push("--", params.path)`,
		`normalized.split("/").includes("..")`,
		`if (!tasks.includes(params.prUrl))`,
		`if (!tasks.includes(`,
		`writeFile(input, JSON.stringify`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("extension missing injection guard %q", want)
		}
	}
	for _, unsafe := range []string{"shell: true", "sh -c", "bash -c", "execSync", "spawn("} {
		if strings.Contains(text, unsafe) {
			t.Fatalf("extension contains unsafe command surface %q", unsafe)
		}
	}
}

func TestReviewCommandIsInteractiveAndIsolated(t *testing.T) {
	root := t.TempDir()
	r := testReviewer("")
	spec, err := r.ReviewCommand(context.Background(), ports.ReviewInvocation{
		WorkerSessionID:  "worker-1",
		WorkspacePath:    filepath.Join(t.TempDir(), "worktree"),
		Prompt:           "Read and follow the AO review task in `/ao/task.md`.",
		SystemPromptFile: filepath.Join(root, "system.md"),
		TaskPromptRoot:   root,
	})
	if err != nil {
		t.Fatalf("ReviewCommand: %v", err)
	}
	joined := strings.Join(spec.Argv, "\n")
	for _, forbidden := range []string{"--print", "-p", "--mode", "json", "rpc"} {
		if slices.Contains(spec.Argv, forbidden) {
			t.Fatalf("interactive reviewer argv contains forbidden %q: %#v", forbidden, spec.Argv)
		}
	}
	for _, required := range append(requiredFlags, "--append-system-prompt") {
		if !strings.Contains(joined, required) {
			t.Fatalf("argv missing %q: %#v", required, spec.Argv)
		}
	}
	if !strings.Contains(joined, "ao_read,ao_search,git_inspect,github_post_review,ao_review_submit") {
		t.Fatalf("argv missing exact tool allowlist: %#v", spec.Argv)
	}
	if got := spec.Argv[len(spec.Argv)-1]; got != "Read and follow the AO review task in `/ao/task.md`." {
		t.Fatalf("terminal-visible prompt = %q", got)
	}
	if spec.Env["AO_PI_REVIEW_SESSION"] != "worker-1" || spec.Env["AO_PI_REVIEW_PROMPT_ROOT"] != root {
		t.Fatalf("env = %#v", spec.Env)
	}
	extensionPath := filepath.Join(root, extensionFilename)
	data, err := os.ReadFile(extensionPath)
	if err != nil {
		t.Fatalf("read materialized extension: %v", err)
	}
	text := string(data)
	for _, want := range []string{"--no-pager", "--no-ext-diff", "github_post_review", "ao_review_submit"} {
		if !strings.Contains(text, want) {
			t.Fatalf("extension missing %q", want)
		}
	}
	for _, forbidden := range []string{"createBashTool", `name: "bash"`, "git commit", "git push"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("extension contains forbidden unrestricted surface %q", forbidden)
		}
	}
}

func TestReviewCommandPreflightShapeNeedsNoPromptRoot(t *testing.T) {
	spec, err := testReviewer("").ReviewCommand(context.Background(), ports.ReviewInvocation{WorkspacePath: "/ws"})
	if err != nil {
		t.Fatalf("ReviewCommand: %v", err)
	}
	if !slices.Equal(spec.Argv, []string{"pi"}) {
		t.Fatalf("argv = %#v", spec.Argv)
	}
}

func TestReviewPreflightRequiresIsolationFlags(t *testing.T) {
	help := strings.Join(requiredFlags, "\n")
	if err := testReviewer(help).ReviewPreflight(context.Background(), "/ws"); err != nil {
		t.Fatalf("ReviewPreflight: %v", err)
	}
	missing := testReviewer(strings.Replace(help, "--no-builtin-tools", "", 1))
	if err := missing.ReviewPreflight(context.Background(), "/ws"); err == nil || !strings.Contains(err.Error(), "--no-builtin-tools") {
		t.Fatalf("missing flag error = %v", err)
	}
}

func TestReviewMessageAndEscapeCancel(t *testing.T) {
	r := testReviewer("")
	message, err := r.ReviewMessage(context.Background(), ports.ReviewInvocation{Prompt: "next task"})
	if err != nil || message != "next task" {
		t.Fatalf("ReviewMessage = %q, %v", message, err)
	}
	cancel, err := r.ReviewCancel(context.Background())
	if err != nil || cancel.Mode != ports.ReviewCancelEscape || cancel.Interrupts != 1 {
		t.Fatalf("ReviewCancel = %+v, %v", cancel, err)
	}
}
