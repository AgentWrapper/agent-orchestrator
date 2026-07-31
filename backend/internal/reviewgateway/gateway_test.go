package reviewgateway

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type fakeExecutor struct {
	commands []Command
	outputs  [][]byte
	err      error
}

func (f *fakeExecutor) Execute(_ context.Context, command Command) ([]byte, error) {
	f.commands = append(f.commands, command)
	if f.err != nil {
		return nil, f.err
	}
	if len(f.outputs) == 0 {
		return nil, nil
	}
	out := f.outputs[0]
	f.outputs = f.outputs[1:]
	return out, nil
}

func testManifest(t *testing.T) Manifest {
	t.Helper()
	root := t.TempDir()
	promptRoot := filepath.Join(root, "prompts")
	if err := os.Mkdir(promptRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	return Manifest{
		ReviewerID:      "reviewer-1",
		WorkerSessionID: "worker-1",
		WorkspacePath:   filepath.Join(root, "source"),
		TaskPromptRoot:  promptRoot,
		Tasks: []Task{{
			RunID: "run-1", PRURL: "https://github.com/acme/widgets/pull/42",
			TargetSHA: "0123456789abcdef", BaseSHA: "abcdef0123456789",
			TaskPromptFile: filepath.Join(promptRoot, "run-1.md"),
		}},
	}
}

func openTestGateway(t *testing.T, executor Executor) (*Gateway, Environment) {
	t.Helper()
	env, err := PrepareEnvironment(t.TempDir(), testManifest(t))
	if err != nil {
		t.Fatal(err)
	}
	gateway, err := Open(env, executor, "/usr/bin/git", "/usr/bin/gh", "/usr/bin/ao")
	if err != nil {
		t.Fatal(err)
	}
	return gateway, env
}

func TestPrepareEnvironmentUsesPrivateAOOwnedDirectoriesAndImmutableManifest(t *testing.T) {
	dataDir := t.TempDir()
	manifest := testManifest(t)
	env, err := PrepareEnvironment(dataDir, manifest)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{env.Root, env.WorkingDirectory, env.ConfigRoot, env.StateRoot, env.CacheRoot, env.TempRoot} {
		rel, err := filepath.Rel(dataDir, path)
		if err != nil || strings.HasPrefix(rel, "..") {
			t.Fatalf("path %q is outside data dir %q", path, dataDir)
		}
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0o700 {
			t.Fatalf("directory %q mode = %v, err = %v", path, info.Mode().Perm(), err)
		}
	}
	if got := env.TUIEnvironment(); got["HOME"] != env.ConfigRoot || got["TMPDIR"] != env.TempRoot || got["XDG_CACHE_HOME"] != env.CacheRoot {
		t.Fatalf("TUI environment = %#v", got)
	}
	info, err := os.Stat(env.ManifestPath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("manifest mode = %v, err = %v", info.Mode().Perm(), err)
	}

	again, err := PrepareEnvironment(dataDir, manifest)
	if err != nil || again.ManifestPath != env.ManifestPath {
		t.Fatalf("idempotent prepare = %+v, %v", again, err)
	}
	manifest.Tasks[0].TargetSHA = "1111111111111111"
	changed, err := PrepareEnvironment(dataDir, manifest)
	if err != nil || changed.ManifestPath == env.ManifestPath {
		t.Fatalf("changed authority must create a new immutable manifest: %+v, %v", changed, err)
	}
}

func TestPrepareEnvironmentRejectsTraversalAndInvalidAuthorization(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Manifest)
	}{
		{"reviewer traversal", func(m *Manifest) { m.ReviewerID = "../escape" }},
		{"duplicate run", func(m *Manifest) { m.Tasks = append(m.Tasks, m.Tasks[0]) }},
		{"ref injection", func(m *Manifest) { m.Tasks[0].TargetSHA = "--help" }},
		{"non github PR", func(m *Manifest) { m.Tasks[0].PRURL = "https://evil.invalid/acme/widgets/pull/42" }},
		{"prompt escape", func(m *Manifest) { m.Tasks[0].TaskPromptFile = filepath.Join(m.TaskPromptRoot, "..", "escape") }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			manifest := testManifest(t)
			tt.mutate(&manifest)
			if _, err := PrepareEnvironment(t.TempDir(), manifest); err == nil {
				t.Fatal("expected rejection")
			}
		})
	}
}

func TestPrepareEnvironmentRequiresAbsoluteDataDir(t *testing.T) {
	if _, err := PrepareEnvironment("relative", testManifest(t)); err == nil {
		t.Fatal("relative AO data directory was accepted")
	}
}

func TestOpenRequiresAOSelectedAbsoluteExecutables(t *testing.T) {
	env, err := PrepareEnvironment(t.TempDir(), testManifest(t))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Open(env, &fakeExecutor{}, "git", "/usr/bin/gh", "/usr/bin/ao"); err == nil {
		t.Fatal("relative executable must be rejected")
	}
	tampered := env
	tampered.WorkingDirectory = testManifest(t).WorkspacePath
	if _, err := Open(tampered, &fakeExecutor{}, "/usr/bin/git", "/usr/bin/gh", "/usr/bin/ao"); err == nil {
		t.Fatal("project working directory was accepted")
	}
}

func TestOpenRejectsManifestTampering(t *testing.T) {
	env, err := PrepareEnvironment(t.TempDir(), testManifest(t))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(env.ManifestPath)
	if err != nil {
		t.Fatal(err)
	}
	raw = []byte(strings.Replace(string(raw), "run-1", "run-x", 1))
	if err := os.WriteFile(env.ManifestPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(env, &fakeExecutor{}, "/usr/bin/git", "/usr/bin/gh", "/usr/bin/ao"); err == nil {
		t.Fatal("tampered content-addressed manifest was accepted")
	}
}

func TestReadFileUsesObjectLookupAndNeverRevPathSyntax(t *testing.T) {
	executor := &fakeExecutor{outputs: [][]byte{
		[]byte("100644 blob 1234567890abcdef\tinternal/safe.go\x00"),
		[]byte("package safe\n"),
	}}
	gateway, _ := openTestGateway(t, executor)
	out, err := gateway.ReadFile(context.Background(), "run-1", "internal/safe.go")
	if err != nil || string(out) != "package safe\n" {
		t.Fatalf("ReadFile = %q, %v", out, err)
	}
	if len(executor.commands) != 2 {
		t.Fatalf("commands = %d", len(executor.commands))
	}
	lookup := executor.commands[0]
	wantSuffix := []string{"ls-tree", "-z", "0123456789abcdef", "--", "internal/safe.go"}
	if !reflect.DeepEqual(lookup.Args[len(lookup.Args)-len(wantSuffix):], wantSuffix) {
		t.Fatalf("lookup argv = %#v", lookup.Args)
	}
	if strings.Contains(strings.Join(lookup.Args, " "), "0123456789abcdef:internal") {
		t.Fatal("rev:path syntax must not be used")
	}
	if got := executor.commands[1].Args[len(executor.commands[1].Args)-3:]; !reflect.DeepEqual(got, []string{"cat-file", "blob", "1234567890abcdef"}) {
		t.Fatalf("cat-file argv = %#v", got)
	}
	for _, bad := range []string{"../secret", "/etc/passwd", "-config", "a\nb"} {
		if _, err := gateway.ReadFile(context.Background(), "run-1", bad); err == nil {
			t.Fatalf("path %q was accepted", bad)
		}
	}
}

func TestDiffDisablesHooksExternalDiffAndTextconv(t *testing.T) {
	executor := &fakeExecutor{}
	gateway, env := openTestGateway(t, executor)
	if _, err := gateway.Diff(context.Background(), "run-1"); err != nil {
		t.Fatal(err)
	}
	command := executor.commands[0]
	joined := strings.Join(command.Args, " ")
	for _, required := range []string{
		"core.hooksPath=" + filepath.Join(env.Root, "disabled-git-hooks"),
		"core.fsmonitor=false", "diff.external=", "--no-ext-diff", "--no-textconv",
		"abcdef0123456789 0123456789abcdef --",
	} {
		if !strings.Contains(joined, required) {
			t.Fatalf("argv %q missing %q", joined, required)
		}
	}
	if command.Path != "/usr/bin/git" || command.Dir == env.WorkingDirectory {
		t.Fatalf("git command = %+v", command)
	}
	if strings.Contains(command.Path, "sh") {
		t.Fatalf("unexpected shell executable: %q", command.Path)
	}
	if strings.Join(command.Env, " ") != strings.Join(gateway.baseEnv(), " ") {
		t.Fatalf("environment was not fixed: %#v", command.Env)
	}
}

func TestSearchIsLiteralBoundedAndUsesPinnedBlobs(t *testing.T) {
	executor := &fakeExecutor{outputs: [][]byte{
		[]byte("a.go\x00b.go\x00"),
		[]byte("100644 blob 1111111111111111\ta.go\x00"), []byte("needle one\nneedle two\n"),
		[]byte("100644 blob 2222222222222222\tb.go\x00"), []byte("needle three\n"),
	}}
	gateway, _ := openTestGateway(t, executor)
	matches, err := gateway.Search(context.Background(), "run-1", "needle", 2)
	if err != nil {
		t.Fatal(err)
	}
	want := []Match{{Path: "a.go", Line: 1, Text: "needle one"}, {Path: "a.go", Line: 2, Text: "needle two"}}
	if !reflect.DeepEqual(matches, want) {
		t.Fatalf("matches = %#v", matches)
	}
	if len(executor.commands) != 3 {
		t.Fatalf("bounded search executed %d commands, want 3", len(executor.commands))
	}
	if _, err := gateway.Search(context.Background(), "run-1", "", 2); err == nil {
		t.Fatal("empty search accepted")
	}
	if _, err := gateway.Search(context.Background(), "run-1", "needle", 201); err == nil {
		t.Fatal("unbounded result count accepted")
	}
}

func TestReadTaskPromptRejectsSymlinkEscape(t *testing.T) {
	manifest := testManifest(t)
	if err := os.WriteFile(manifest.Tasks[0].TaskPromptFile, []byte("review this"), 0o600); err != nil {
		t.Fatal(err)
	}
	env, err := PrepareEnvironment(t.TempDir(), manifest)
	if err != nil {
		t.Fatal(err)
	}
	gateway, err := Open(env, &fakeExecutor{}, "/usr/bin/git", "/usr/bin/gh", "/usr/bin/ao")
	if err != nil {
		t.Fatal(err)
	}
	content, err := gateway.ReadTaskPrompt("run-1")
	if err != nil || string(content) != "review this" {
		t.Fatalf("prompt = %q, %v", content, err)
	}

	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(manifest.Tasks[0].TaskPromptFile); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, manifest.Tasks[0].TaskPromptFile); err != nil {
		t.Fatal(err)
	}
	if _, err := gateway.ReadTaskPrompt("run-1"); err == nil {
		t.Fatal("prompt symlink escape was accepted")
	}
}

func TestGatewayAuthorizesExactRunAndPRForPublishing(t *testing.T) {
	executor := &fakeExecutor{outputs: [][]byte{[]byte("987\n")}}
	gateway, env := openTestGateway(t, executor)
	if _, err := gateway.PostReview(context.Background(), "run-2", "https://github.com/acme/widgets/pull/42", "APPROVE", "ok"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("wrong run error = %v", err)
	}
	if _, err := gateway.PostReview(context.Background(), "run-1", "https://github.com/acme/widgets/pull/43", "APPROVE", "ok"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("wrong PR error = %v", err)
	}
	id, err := gateway.PostReview(context.Background(), "run-1", "https://github.com/acme/widgets/pull/42", "REQUEST_CHANGES", "fix it")
	if err != nil || id != "987" {
		t.Fatalf("PostReview = %q, %v", id, err)
	}
	command := executor.commands[0]
	want := []string{"api", "--method", "POST", "repos/acme/widgets/pulls/42/reviews", "--input", "-", "--jq", ".id"}
	if command.Path != "/usr/bin/gh" || command.Dir != env.WorkingDirectory || !reflect.DeepEqual(command.Args, want) {
		t.Fatalf("gh command = %+v", command)
	}
	var payload map[string]string
	if err := json.Unmarshal(command.Stdin, &payload); err != nil || payload["commit_id"] != "0123456789abcdef" || payload["event"] != "REQUEST_CHANGES" {
		t.Fatalf("payload = %#v, err = %v", payload, err)
	}
}

func TestSubmitUsesFixedAOArgvAndRejectsUnmanifestedResults(t *testing.T) {
	executor := &fakeExecutor{}
	gateway, env := openTestGateway(t, executor)
	if err := gateway.Submit(context.Background(), []Result{{RunID: "run-x", Verdict: domain.VerdictApproved}}); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("unknown run error = %v", err)
	}
	if err := gateway.Submit(context.Background(), []Result{{RunID: "run-1", Verdict: domain.VerdictChangesRequested}}); err == nil {
		t.Fatal("empty changes-requested body accepted")
	}
	result := Result{RunID: "run-1", Verdict: domain.VerdictApproved, Body: "looks good", GithubReviewID: "987"}
	if err := gateway.Submit(context.Background(), []Result{result}); err != nil {
		t.Fatal(err)
	}
	command := executor.commands[0]
	want := []string{"review", "submit", "worker-1", "--reviews", "-"}
	if command.Path != "/usr/bin/ao" || command.Dir != env.WorkingDirectory || !reflect.DeepEqual(command.Args, want) {
		t.Fatalf("ao command = %+v", command)
	}
	if strings.Contains(strings.Join(command.Args, " "), "&&") || strings.Contains(command.Path, "sh") {
		t.Fatalf("command permits shell syntax: %+v", command)
	}
}
