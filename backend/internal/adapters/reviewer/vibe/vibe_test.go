package vibe

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func testReviewer(t *testing.T, version, help string, isolation error) *Reviewer {
	t.Helper()
	return &Reviewer{
		dataDir:       t.TempDir(),
		resolveBinary: func(context.Context) (string, error) { return "/opt/vibe/bin/vibe", nil },
		run: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			switch {
			case slices.Equal(args, []string{"--version"}):
				return []byte(version), nil
			case slices.Equal(args, []string{"--help"}):
				return []byte(help), nil
			default:
				return nil, errors.New("unexpected Vibe invocation")
			}
		},
		isolationPreflight: func(context.Context) error { return isolation },
	}
}

func invocation(t *testing.T) ports.ReviewInvocation {
	t.Helper()
	root := t.TempDir()
	return ports.ReviewInvocation{
		ReviewerID:      "review-worker-1",
		WorkerSessionID: "worker-1",
		WorkspacePath:   filepath.Join(root, "checkout"),
		TaskPromptRoot:  filepath.Join(root, "prompts"),
		TaskPromptFile:  filepath.Join(root, "prompts", "task.md"),
		Prompt:          "Open AO task capability `task-ref-7f18`.",
	}
}

func TestReviewCommandPreflightShapeOnlyResolvesBinary(t *testing.T) {
	r := testReviewer(t, "", "", ErrIsolationUnavailable)
	spec, err := r.ReviewCommand(context.Background(), ports.ReviewInvocation{WorkspacePath: "/worker"})
	if err != nil {
		t.Fatalf("ReviewCommand: %v", err)
	}
	if !reflect.DeepEqual(spec.Argv, []string{"/opt/vibe/bin/vibe"}) || spec.WorkingDirectory != "" || len(spec.Env) != 0 {
		t.Fatalf("preflight spec = %+v", spec)
	}
}

func TestReviewCommandFailsClosedBeforeRuntimeLaunch(t *testing.T) {
	inv := invocation(t)
	if _, err := testReviewer(t, "", "", ErrIsolationUnavailable).ReviewCommand(context.Background(), inv); !errors.Is(err, ErrIsolationUnavailable) {
		t.Fatalf("ReviewCommand err = %v, want isolation blocker", err)
	}
	// A future process sandbox alone must not enable Vibe before its model
	// broker and review-gateway MCP transports also exist.
	if _, err := testReviewer(t, "", "", nil).ReviewCommand(context.Background(), inv); !errors.Is(err, ErrIsolationUnavailable) {
		t.Fatalf("ReviewCommand with isolation probe err = %v", err)
	}
}

func TestContainedInteractiveSpecUsesExactTUIArgvAndPostReadinessTask(t *testing.T) {
	r := testReviewer(t, "", "", ErrIsolationUnavailable)
	inv := invocation(t)
	staged, err := r.containedInteractiveSpec(context.Background(), inv)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"/opt/vibe/bin/vibe", "--trust", "--workdir", staged.Command.WorkingDirectory, "--agent", "plan"}
	if !reflect.DeepEqual(staged.Command.Argv, want) {
		t.Fatalf("argv = %#v, want %#v", staged.Command.Argv, want)
	}
	for _, forbidden := range []string{"-p", "--prompt", "--auto-approve", "--yolo", "--add-dir", inv.Prompt, inv.WorkspacePath} {
		if slices.Contains(staged.Command.Argv, forbidden) {
			t.Fatalf("interactive argv contains forbidden %q: %#v", forbidden, staged.Command.Argv)
		}
	}
	if staged.Command.InitialMessage != inv.Prompt {
		t.Fatalf("initial message = %q, want opaque task reference", staged.Command.InitialMessage)
	}
	if staged.Command.WorkingDirectory == inv.WorkspacePath || !strings.HasPrefix(staged.Command.WorkingDirectory, r.dataDir+string(filepath.Separator)) {
		t.Fatalf("working directory = %q", staged.Command.WorkingDirectory)
	}
}

func TestContainedInteractiveSpecRequiresReplacementEnvironmentAndNeutralDiscovery(t *testing.T) {
	t.Setenv("VIBE_DEFAULT_AGENT", "auto-approve")
	t.Setenv("VIBE_MCP_SERVERS", `[{"name":"hostile"}]`)
	t.Setenv("EDITOR", "/tmp/hostile-editor")
	r := testReviewer(t, "", "", ErrIsolationUnavailable)
	staged, err := r.containedInteractiveSpec(context.Background(), invocation(t))
	if err != nil {
		t.Fatal(err)
	}
	if !staged.EnvironmentReplacement {
		t.Fatal("environment must replace, not overlay, the daemon environment")
	}
	wantKeys := []string{"HOME", "TEMP", "TMP", "TMPDIR", "VIBE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"}
	gotKeys := make([]string, 0, len(staged.Command.Env))
	for key := range staged.Command.Env {
		gotKeys = append(gotKeys, key)
	}
	slices.Sort(gotKeys)
	if !slices.Equal(gotKeys, wantKeys) {
		t.Fatalf("replacement env keys = %#v, want %#v", gotKeys, wantKeys)
	}
	for _, forbidden := range []string{"EDITOR", "VISUAL", "SHELL", "VIBE_DEFAULT_AGENT", "VIBE_MCP_SERVERS", "MISTRAL_API_KEY"} {
		if _, ok := staged.Command.Env[forbidden]; ok {
			t.Fatalf("replacement env inherited %s", forbidden)
		}
	}
	vibeHome := staged.Command.Env["VIBE_HOME"]
	if !strings.HasPrefix(vibeHome, r.dataDir+string(filepath.Separator)) {
		t.Fatalf("VIBE_HOME = %q", vibeHome)
	}
	config, err := os.ReadFile(filepath.Join(vibeHome, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	body := string(config)
	for _, required := range []string{
		`default_agent = "plan"`,
		`enabled_agents = ["plan"]`,
		`enabled_tools = ["grep", "read"]`,
		`disabled_skills = ["*"]`,
		`mcp_servers = []`,
	} {
		if !strings.Contains(body, required) {
			t.Fatalf("neutral config missing %q:\n%s", required, body)
		}
	}
	for _, forbidden := range []string{"bash", "edit", "write_file", "auto-approve", "accept-edits"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("neutral config enables risky surface %q:\n%s", forbidden, body)
		}
	}
}

func TestContainedInteractiveSpecModelsShellEditorAndApprovalToggleRisks(t *testing.T) {
	staged, err := testReviewer(t, "", "", ErrIsolationUnavailable).containedInteractiveSpec(context.Background(), invocation(t))
	if err != nil {
		t.Fatal(err)
	}
	// Vibe 2.17.1's `!` shell remains reachable from the interactive prompt,
	// regardless of the plan agent's tool policy. This is why the command may
	// never launch without OS containment.
	if !slices.Equal(staged.UncontainedRisks, []string{
		"terminal shell escape",
		"external editor",
		"approval-mode toggle",
		"layered config discovery",
	}) {
		t.Fatalf("uncontained risks = %#v", staged.UncontainedRisks)
	}
	// Ctrl+G launches an external editor and must be swallowed by the future
	// terminal-input filter. Shift+Tab is constrained separately by the single
	// enabled plan agent in the neutral config.
	if !slices.Equal(staged.BlockedInput, []string{"\x07"}) {
		t.Fatalf("blocked input = %#v, want one Ctrl+G", staged.BlockedInput)
	}
	if !slices.Contains(staged.Command.Argv, "plan") || slices.Contains(staged.Command.Argv, "auto-approve") {
		t.Fatalf("approval policy argv = %#v", staged.Command.Argv)
	}
}

func TestReviewPreflightPinsVibe2171AndInteractiveFlags(t *testing.T) {
	help := strings.Join(requiredFlags, "\n")
	if err := testReviewer(t, "vibe 2.17.1\n", help, nil).ReviewPreflight(context.Background(), "/worker"); err != nil {
		t.Fatalf("ReviewPreflight: %v", err)
	}
	for _, version := range []string{"vibe 2.17.0", "vibe 2.18.0", "vibe unknown"} {
		if err := testReviewer(t, version, help, nil).ReviewPreflight(context.Background(), "/worker"); err == nil || !strings.Contains(err.Error(), pinnedVersion) {
			t.Fatalf("version %q err = %v, want pinned-version rejection", version, err)
		}
	}
	missing := testReviewer(t, "vibe 2.17.1", strings.Replace(help, "--workdir", "", 1), nil)
	if err := missing.ReviewPreflight(context.Background(), "/worker"); err == nil || !strings.Contains(err.Error(), "--workdir") {
		t.Fatalf("missing flag err = %v", err)
	}
}

func TestProductionPreflightReportsIsolationBlocker(t *testing.T) {
	err := testReviewer(t, "vibe 2.17.1", strings.Join(requiredFlags, "\n"), ErrIsolationUnavailable).ReviewPreflight(context.Background(), "/worker")
	if !errors.Is(err, ErrIsolationUnavailable) {
		t.Fatalf("ReviewPreflight err = %v", err)
	}
}

func TestReviewMessageReusesLivePaneAndCancelUsesOneEscape(t *testing.T) {
	r := testReviewer(t, "", "", ErrIsolationUnavailable)
	message, err := r.ReviewMessage(context.Background(), ports.ReviewInvocation{Prompt: "task-ref-next"})
	if err != nil || message != "task-ref-next" {
		t.Fatalf("ReviewMessage = %q, %v", message, err)
	}
	cancel, err := r.ReviewCancel(context.Background())
	if err != nil || cancel.Mode != ports.ReviewCancelEscape || cancel.Interrupts != 1 || cancel.Input != "\x1b" {
		t.Fatalf("ReviewCancel = %+v, %v", cancel, err)
	}
}

func TestStagedHarnessIsNotDomainRegistered(t *testing.T) {
	if New(t.TempDir()).Harness() != HarnessID || HarnessID.IsKnown() {
		t.Fatal("Vibe reviewer must remain package-local and disabled")
	}
}

func TestContainedInteractiveSpecRejectsUnsafePaths(t *testing.T) {
	r := testReviewer(t, "", "", ErrIsolationUnavailable)
	r.resolveBinary = func(context.Context) (string, error) { return "vibe", nil }
	if _, err := r.containedInteractiveSpec(context.Background(), invocation(t)); err == nil {
		t.Fatal("relative executable accepted")
	}
	r.resolveBinary = func(context.Context) (string, error) { return "/opt/vibe/bin/vibe", nil }
	inv := invocation(t)
	inv.ReviewerID = "../escape"
	if _, err := r.containedInteractiveSpec(context.Background(), inv); err == nil {
		t.Fatal("unsafe reviewer id accepted")
	}
}
