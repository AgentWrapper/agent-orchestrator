package sessionmanager

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fixedBrowserCapability string

func (f fixedBrowserCapability) Token(_ domain.SessionID) string { return string(f) }

func TestSpawnEnvProjectVarsCannotOverrideInternal(t *testing.T) {
	env := spawnEnv("mer-1", "mer", "issue-9", "/data", map[string]string{
		"FOO":        "bar",
		EnvSessionID: "hacked", // a project must not override AO-internal vars
		EnvProjectID: "hacked",
	}, nil)
	if env["FOO"] != "bar" {
		t.Fatalf("FOO = %q, want bar", env["FOO"])
	}
	if env[EnvSessionID] != "mer-1" {
		t.Fatalf("AO_SESSION_ID = %q, want mer-1 (internal wins)", env[EnvSessionID])
	}
	if env[EnvProjectID] != "mer" {
		t.Fatalf("AO_PROJECT_ID = %q, want mer (internal wins)", env[EnvProjectID])
	}
}

func TestSpawnEnvSpawnConfigWinsOverProject(t *testing.T) {
	env := spawnEnv("mer-1", "mer", "issue-9", "/data", map[string]string{
		"FOO":        "project",
		"BAR":        "project-only",
		"AO_RUN_ID":  "project-hijack",
		EnvSessionID: "hacked",
	}, map[string]string{
		"FOO":        "spawn",
		"AO_RUN_ID":  "r1",
		EnvSessionID: "hacked-by-spawn", // AO-internal vars still win over everything
	})
	if env["FOO"] != "spawn" {
		t.Fatalf("FOO = %q, want spawn (spawn config wins over project env)", env["FOO"])
	}
	if env["AO_RUN_ID"] != "r1" {
		t.Fatalf("AO_RUN_ID = %q, want r1", env["AO_RUN_ID"])
	}
	if env["BAR"] != "project-only" {
		t.Fatalf("BAR = %q, want project-only", env["BAR"])
	}
	if env[EnvSessionID] != "mer-1" {
		t.Fatalf("AO_SESSION_ID = %q, want mer-1 (internal wins)", env[EnvSessionID])
	}
}

func TestSpawnEnvNilExtraChangesNothing(t *testing.T) {
	projectEnv := map[string]string{"FOO": "bar"}
	base := spawnEnv("mer-1", "mer", "issue-9", "/data", projectEnv, nil)
	empty := spawnEnv("mer-1", "mer", "issue-9", "/data", projectEnv, map[string]string{})
	if len(base) != len(empty) {
		t.Fatalf("nil vs empty extra env differ: %v vs %v", base, empty)
	}
	for k, v := range base {
		if empty[k] != v {
			t.Fatalf("env[%q] = %q, want %q", k, empty[k], v)
		}
	}
	if base["FOO"] != "bar" || base[EnvSessionID] != "mer-1" || base[EnvProjectID] != "mer" || base[EnvDataDir] != "/data" {
		t.Fatalf("nil extra env changed the base env: %v", base)
	}
}

func TestSpawn_ConfigEnvReachesRuntime(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{
		Env: map[string]string{"FOO": "project", "BAR": "project-only"},
	}}
	rt := &fakeRuntime{}
	m := New(Deps{Runtime: rt, Agents: singleAgent{agent: &recordingAgent{}}, Workspace: &fakeWorkspace{}, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: func(string) (string, error) { return "/bin/true", nil }})

	if _, _, _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker, Harness: domain.HarnessClaudeCode,
		Env: map[string]string{"AO_RUN_ID": "r1", "FOO": "spawn"}}); err != nil {
		t.Fatal(err)
	}
	if got := rt.lastCfg.Env["AO_RUN_ID"]; got != "r1" {
		t.Fatalf("runtime env AO_RUN_ID = %q, want r1", got)
	}
	if got := rt.lastCfg.Env["FOO"]; got != "spawn" {
		t.Fatalf("runtime env FOO = %q, want spawn (spawn config wins over project env)", got)
	}
	if got := rt.lastCfg.Env["BAR"]; got != "project-only" {
		t.Fatalf("runtime env BAR = %q, want project-only", got)
	}
	if rt.lastCfg.Env[EnvSessionID] == "" {
		t.Fatal("runtime env missing AO_SESSION_ID")
	}
}

func TestRuntimeEnvInjectsBrowserCapability(t *testing.T) {
	manager := &Manager{
		dataDir:             "/data",
		browserCapabilities: fixedBrowserCapability("capability-1"),
		executable:          func() (string, error) { return filepath.Join("/opt", "aod", "ao"), nil },
		logger:              slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	env := manager.runtimeEnv("mer-1", "mer", "", nil, nil)
	if env[EnvBrowserCapability] != "capability-1" {
		t.Fatalf("%s = %q", EnvBrowserCapability, env[EnvBrowserCapability])
	}
}

func TestHookPATH(t *testing.T) {
	sep := string(os.PathListSeparator)
	daemonExe := filepath.Join("/opt", "aod", "ao")
	daemonDir := filepath.Dir(daemonExe)
	exeOK := func() (string, error) { return daemonExe, nil }

	cases := []struct {
		name       string
		executable func() (string, error)
		daemonPATH string
		projectEnv map[string]string
		want       string
		wantErr    bool
	}{
		{
			name:       "prepends daemon dir to inherited PATH",
			executable: exeOK,
			daemonPATH: "/usr/bin" + sep + "/bin",
			want:       daemonDir + sep + "/usr/bin" + sep + "/bin",
		},
		{
			name:       "project PATH override is the base",
			executable: exeOK,
			daemonPATH: "/usr/bin",
			projectEnv: map[string]string{"PATH": "/proj/bin"},
			want:       daemonDir + sep + "/proj/bin",
		},
		{
			name:       "empty base PATH yields the daemon dir alone",
			executable: exeOK,
			want:       daemonDir,
		},
		{
			name:       "unresolvable executable fails",
			executable: func() (string, error) { return "", errors.New("no exe") },
			daemonPATH: "/usr/bin",
			wantErr:    true,
		},
		{
			// A daemon binary not named "ao" cannot anchor `ao` resolution by
			// having its directory prepended, so the pin must be refused.
			name:       "executable not named ao fails",
			executable: func() (string, error) { return filepath.Join("/opt", "aod", "ao-daemon"), nil },
			daemonPATH: "/usr/bin",
			wantErr:    true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			getenv := func(key string) string {
				if key == "PATH" {
					return tc.daemonPATH
				}
				return ""
			}
			got, err := HookPATH(tc.executable, getenv, tc.projectEnv)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("HookPATH = %q, want error", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("HookPATH: %v", err)
			}
			if got != tc.want {
				t.Fatalf("HookPATH = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestEffectiveHarnessAndAgentConfig(t *testing.T) {
	cfg := domain.ProjectConfig{
		AgentConfig:  domain.AgentConfig{Model: "base", Permissions: domain.PermissionModeAuto},
		Worker:       domain.RoleOverride{Harness: domain.HarnessCodex, AgentConfig: domain.AgentConfig{Model: "worker"}},
		Orchestrator: domain.RoleOverride{Harness: domain.HarnessClaudeCode},
	}

	// Explicit harness always wins.
	if h := effectiveHarness(domain.HarnessAider, domain.KindWorker, cfg); h != domain.HarnessAider {
		t.Fatalf("explicit harness = %q, want aider", h)
	}
	// Empty harness falls back to the role override per kind.
	if h := effectiveHarness("", domain.KindWorker, cfg); h != domain.HarnessCodex {
		t.Fatalf("worker harness = %q, want codex", h)
	}
	if h := effectiveHarness("", domain.KindOrchestrator, cfg); h != domain.HarnessClaudeCode {
		t.Fatalf("orchestrator harness = %q, want claude-code", h)
	}

	// Role override merges over the base agent config (set fields win; unset keep base).
	got := effectiveAgentConfig(domain.KindWorker, cfg)
	if got.Model != "worker" || got.Permissions != domain.PermissionModeAuto {
		t.Fatalf("merged worker config = %#v, want model=worker permissions=auto", got)
	}
	// Orchestrator has no agent-config override, so the base config is used as-is.
	if got := effectiveAgentConfig(domain.KindOrchestrator, cfg); got.Model != "base" {
		t.Fatalf("orchestrator config = %#v, want base", got)
	}
}

func TestApplySymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows symlink creation requires a host privilege outside this unit test")
	}
	project := t.TempDir()
	workspace := t.TempDir()
	if err := os.WriteFile(filepath.Join(project, ".env"), []byte("X=1"), 0o644); err != nil {
		t.Fatal(err)
	}

	// A present source is linked; a missing source is skipped, not an error.
	if err := applySymlinks(project, workspace, []string{".env", "missing.txt"}); err != nil {
		t.Fatalf("applySymlinks: %v", err)
	}
	target := filepath.Join(workspace, ".env")
	if data, err := os.ReadFile(target); err != nil || string(data) != "X=1" {
		t.Fatalf("symlinked .env = %q err=%v", data, err)
	}
	if _, err := os.Lstat(filepath.Join(workspace, "missing.txt")); !os.IsNotExist(err) {
		t.Fatal("missing source should not have been linked")
	}
}

func TestApplySymlinksRejectsParentTraversal(t *testing.T) {
	project := t.TempDir()
	workspace := t.TempDir()
	// A "..", "/" or "../" segment escapes the project tree and must be refused
	// before any stat/link runs, so a project config cannot link in arbitrary
	// host files.
	for _, bad := range []string{"../escape", "/etc/passwd", "a/../../b", ".."} {
		if err := applySymlinks(project, workspace, []string{bad}); err == nil {
			t.Fatalf("applySymlinks(%q) accepted an unsafe path", bad)
		}
	}
}

func TestRunPostCreate(t *testing.T) {
	workspace := t.TempDir()
	if err := runPostCreate(context.Background(), workspace, []string{"echo hi > out.txt"}); err != nil {
		t.Fatalf("runPostCreate: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workspace, "out.txt")); err != nil {
		t.Fatalf("post-create command did not run in workspace: %v", err)
	}
	// A failing command surfaces an error.
	if err := runPostCreate(context.Background(), workspace, []string{"exit 3"}); err == nil {
		t.Fatal("expected error from failing post-create command")
	}
}
