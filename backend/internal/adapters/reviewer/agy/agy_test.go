package agy

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func testReviewer(help, version string, isolation error) *Reviewer {
	return &Reviewer{
		resolveBinary: func(context.Context) (string, error) { return "agy", nil },
		run: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			if slices.Equal(args, []string{"--help"}) {
				return []byte(help), nil
			}
			return []byte(version), nil
		},
		isolationPreflight: func(context.Context) error { return isolation },
	}
}

func TestReviewCommandPreflightShapeOnlyResolvesBinary(t *testing.T) {
	spec, err := testReviewer("", "", ErrIsolationUnavailable).ReviewCommand(context.Background(), ports.ReviewInvocation{WorkspacePath: "/worker"})
	if err != nil {
		t.Fatalf("ReviewCommand: %v", err)
	}
	if !slices.Equal(spec.Argv, []string{"agy"}) || spec.WorkingDirectory != "" || len(spec.Env) != 0 {
		t.Fatalf("preflight spec = %+v", spec)
	}
}

func TestReviewCommandFailsClosedBeforeRuntimeLaunch(t *testing.T) {
	_, err := testReviewer("", "", ErrIsolationUnavailable).ReviewCommand(context.Background(), ports.ReviewInvocation{
		TaskPromptRoot: "/ao/prompts/worker/reviewer",
		WorkspacePath:  "/worker",
		Prompt:         "Read and follow `/ao/task.md`.",
	})
	if !errors.Is(err, ErrIsolationUnavailable) {
		t.Fatalf("ReviewCommand err = %v, want isolation blocker", err)
	}

	// Even a future sandbox probe is insufficient until the structured gateway
	// has an Agy-consumable transport.
	_, err = testReviewer("", "", nil).ReviewCommand(context.Background(), ports.ReviewInvocation{TaskPromptRoot: "/ao/prompts"})
	if !errors.Is(err, ErrIsolationUnavailable) {
		t.Fatalf("ReviewCommand with isolation probe err = %v", err)
	}
}

func TestInteractiveArgvIsPermanentTUIOnly(t *testing.T) {
	argv := interactiveArgv("agy", "ao-reviewer", "Read and follow `/ao/task.md`.")
	want := []string{"agy", "--agent", "ao-reviewer", "--sandbox", "--prompt-interactive", "Read and follow `/ao/task.md`."}
	if !slices.Equal(argv, want) {
		t.Fatalf("argv = %#v, want %#v", argv, want)
	}
	for _, forbidden := range []string{"--print", "-p", "--prompt", "--output-format", "json", "stream-json", "rpc"} {
		if slices.Contains(argv, forbidden) {
			t.Fatalf("interactive argv contains forbidden %q: %#v", forbidden, argv)
		}
	}
	if slices.Contains(argv, "--add-dir") {
		t.Fatalf("interactive argv exposes worker checkout: %#v", argv)
	}
}

func TestReviewPreflightRequiresCurrentInteractiveSurface(t *testing.T) {
	help := strings.Join(requiredFlags, "\n")
	r := testReviewer(help, "1.1.9", nil)
	if err := r.ReviewPreflight(context.Background(), "/worker"); err != nil {
		t.Fatalf("ReviewPreflight: %v", err)
	}

	missing := testReviewer(strings.Replace(help, "--prompt-interactive", "", 1), "1.1.9", nil)
	if err := missing.ReviewPreflight(context.Background(), "/worker"); err == nil || !strings.Contains(err.Error(), "--prompt-interactive") {
		t.Fatalf("missing flag err = %v", err)
	}
	old := testReviewer(help, "1.1.5", nil)
	if err := old.ReviewPreflight(context.Background(), "/worker"); err == nil || !strings.Contains(err.Error(), minimumVersion) {
		t.Fatalf("old version err = %v", err)
	}
}

func TestProductionPreflightReportsIsolationBlocker(t *testing.T) {
	help := strings.Join(requiredFlags, "\n")
	err := testReviewer(help, "1.1.9", ErrIsolationUnavailable).ReviewPreflight(context.Background(), "/worker")
	if !errors.Is(err, ErrIsolationUnavailable) {
		t.Fatalf("ReviewPreflight err = %v", err)
	}
}

func TestReviewMessageAndSingleInterruptCancel(t *testing.T) {
	r := testReviewer("", "", ErrIsolationUnavailable)
	message, err := r.ReviewMessage(context.Background(), ports.ReviewInvocation{Prompt: "next task"})
	if err != nil || message != "next task" {
		t.Fatalf("ReviewMessage = %q, %v", message, err)
	}
	cancel, err := r.ReviewCancel(context.Background())
	if err != nil || cancel.Mode != ports.ReviewCancelInterrupt || cancel.Interrupts != 1 {
		t.Fatalf("ReviewCancel = %+v, %v", cancel, err)
	}
}

func TestVersionAtLeast(t *testing.T) {
	for _, tc := range []struct {
		got  string
		want bool
	}{{"1.1.6", true}, {"v1.1.9", true}, {"1.2.0", true}, {"2.0.0", true}, {"1.1.5", false}, {"invalid", false}} {
		if got := versionAtLeast(tc.got, minimumVersion); got != tc.want {
			t.Errorf("versionAtLeast(%q) = %v, want %v", tc.got, got, tc.want)
		}
	}
}
