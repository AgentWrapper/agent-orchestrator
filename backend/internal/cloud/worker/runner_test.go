package worker

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	shareddomain "github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestPrepareClaudeCloudExperienceSkipsFirstRunPrompts(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(home, ".claude.json"),
		[]byte(`{"custom":"preserved"}`),
		0o600,
	); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if err := prepareClaudeCloudExperience(home); err != nil {
		t.Fatalf("prepareClaudeCloudExperience() error = %v", err)
	}

	root := readJSONObject(t, filepath.Join(home, ".claude.json"))
	if root["hasCompletedOnboarding"] != true ||
		root["theme"] != "dark" ||
		root["custom"] != "preserved" {
		t.Fatalf("Claude root config = %#v", root)
	}
	settings := readJSONObject(t, filepath.Join(home, ".claude", "settings.json"))
	permissions, _ := settings["permissions"].(map[string]any)
	if settings["theme"] != "dark" ||
		settings["skipDangerousModePermissionPrompt"] != true ||
		permissions["defaultMode"] != "bypassPermissions" {
		t.Fatalf("Claude settings = %#v", settings)
	}
}

func TestPrepareClaudeCloudExperienceUsesConfiguredDirectory(t *testing.T) {
	home := t.TempDir()
	configDir := filepath.Join(home, "persistent-claude")
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)

	if err := prepareClaudeCloudExperience(home); err != nil {
		t.Fatalf("prepareClaudeCloudExperience() error = %v", err)
	}
	root := readJSONObject(t, filepath.Join(configDir, ".claude.json"))
	settings := readJSONObject(t, filepath.Join(configDir, "settings.json"))
	if root["hasCompletedOnboarding"] != true || root["theme"] != "dark" {
		t.Fatalf("configured Claude root = %#v", root)
	}
	if settings["skipDangerousModePermissionPrompt"] != true {
		t.Fatalf("configured Claude settings = %#v", settings)
	}
}

func TestClaudeTranscriptExistsUsesPersistentConfigDirectory(t *testing.T) {
	configDir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)
	transcriptDir := filepath.Join(configDir, "projects", "-workspace-repository")
	if err := os.MkdirAll(transcriptDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(transcriptDir, "native-session.jsonl"),
		[]byte("{}\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if !claudeTranscriptExists("native-session") {
		t.Fatal("claudeTranscriptExists() = false, want true")
	}
	if claudeTranscriptExists("missing-session") {
		t.Fatal("claudeTranscriptExists(missing) = true")
	}
}

func TestRegressionRestartedClaudeSessionRequiresPersistedTranscript(t *testing.T) {
	configDir := t.TempDir()
	dataDir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)
	if err := os.WriteFile(
		filepath.Join(dataDir, "agent-session-initialized"),
		[]byte("initialized\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	session := clouddomain.Session{
		ID:             "session-one",
		Harness:        "claude-code",
		AgentSessionID: "native-session",
	}
	restore, err := shouldRestoreAgentSession(session, dataDir)
	if err != nil {
		t.Fatalf("shouldRestoreAgentSession() error = %v", err)
	}
	if restore {
		t.Fatal("shouldRestoreAgentSession() = true without transcript")
	}

	transcriptDir := filepath.Join(configDir, "projects", "-workspace-repository")
	if err := os.MkdirAll(transcriptDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(transcriptDir, "native-session.jsonl"),
		[]byte("{}\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	restore, err = shouldRestoreAgentSession(session, dataDir)
	if err != nil {
		t.Fatalf("shouldRestoreAgentSession() error = %v", err)
	}
	if !restore {
		t.Fatal("shouldRestoreAgentSession() = false with durable marker and transcript")
	}
}

func TestOrchestratorSystemPromptRequiresDurableAOWorkers(t *testing.T) {
	prompt := systemPrompt("orchestrator", "project-one", "https://github.com/acme/repo", "main", "ao/orchestrator", "delegate carefully")
	for _, required := range []string{
		`ao spawn --name`,
		`Never use Claude's Agent tool`,
		`ao status`,
		`ao session get <worker>`,
		`ao wait <worker>`,
		`ao result <worker>`,
		`ao send --session`,
		`ao session merge-pr <worker>`,
		`Project-Specific Orchestrator Rules`,
	} {
		if !strings.Contains(prompt, required) {
			t.Fatalf("orchestrator prompt does not contain %q", required)
		}
	}
	workerPrompt := systemPrompt("worker", "project-one", "https://github.com/acme/repo", "main", "ao/worker", "run focused tests")
	for _, required := range []string{
		`AO Worker Role`,
		`ao blocker --message`,
		`Work on this session branch: ao/worker`,
		`Pull Requests for This Session`,
		`Project Rules`,
	} {
		if !strings.Contains(workerPrompt, required) {
			t.Fatalf("worker prompt does not contain %q", required)
		}
	}
}

func TestRestrictOrchestratorToolsRemovesClaudeAgentTool(t *testing.T) {
	got := restrictOrchestratorTools(
		[]string{"claude", "--permission-mode", "bypassPermissions", "--", "delegate this"},
		"orchestrator",
		"claude-code",
	)
	want := []string{
		"claude",
		"--permission-mode", "bypassPermissions",
		"--tools", "Bash,Read,Glob,Grep,WebFetch,WebSearch",
		"--", "delegate this",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("restricted argv = %#v, want %#v", got, want)
	}

	worker := []string{"claude", "--", "work"}
	if got := restrictOrchestratorTools(worker, "worker", "claude-code"); !reflect.DeepEqual(got, worker) {
		t.Fatalf("worker argv = %#v, want %#v", got, worker)
	}
}

func TestRegressionSpawnedClaudePromptIsSubmittedAfterComposerUpdate(t *testing.T) {
	terminal := &recordingWriter{}
	var writeMu sync.Mutex
	if err := submitInteractivePrompt(
		context.Background(),
		terminal,
		&writeMu,
		[]byte("Read the README"),
		0,
	); err != nil {
		t.Fatalf("submitInteractivePrompt() error = %v", err)
	}
	want := [][]byte{[]byte("Read the README"), {'\r'}}
	if !reflect.DeepEqual(terminal.writes, want) {
		t.Fatalf("terminal writes = %#v, want %#v", terminal.writes, want)
	}
}

func TestStreamOutputRetriesWithoutStoppingPTYDrain(t *testing.T) {
	calls := 0
	runner := &Runner{
		outputRetryDelay: -1,
		outputEvent: func(_ context.Context, eventType string, payload any) error {
			calls++
			if eventType != "terminal.output" {
				t.Fatalf("event type = %q", eventType)
			}
			if calls < 3 {
				return errors.New("temporary delivery failure")
			}
			values, _ := payload.(map[string]any)
			if values["data"] != base64.StdEncoding.EncodeToString([]byte("agent output")) {
				t.Fatalf("payload = %#v", payload)
			}
			return nil
		},
	}

	err := runner.streamOutput(
		context.Background(),
		strings.NewReader("agent output"),
		"terminal.output",
	)
	if !errors.Is(err, io.EOF) {
		t.Fatalf("streamOutput() error = %v, want EOF", err)
	}
	if calls != 3 {
		t.Fatalf("delivery calls = %d, want 3", calls)
	}
}

func TestStreamOutputFailsAfterBoundedDeliveryAttempts(t *testing.T) {
	calls := 0
	runner := &Runner{
		outputRetryDelay: -1,
		outputEvent: func(context.Context, string, any) error {
			calls++
			return errors.New("delivery unavailable")
		},
	}

	err := runner.streamOutput(
		context.Background(),
		strings.NewReader("agent output"),
		"terminal.output",
	)
	if err == nil || !strings.Contains(err.Error(), "after 5 attempts") {
		t.Fatalf("streamOutput() error = %v", err)
	}
	if calls != terminalOutputMaxAttempts {
		t.Fatalf("delivery calls = %d, want %d", calls, terminalOutputMaxAttempts)
	}
}

func TestStreamOutputCancelsDeliveryWhenBoundedQueueFills(t *testing.T) {
	runner := &Runner{
		outputRetryDelay: -1,
		outputEvent: func(ctx context.Context, _ string, _ any) error {
			<-ctx.Done()
			return ctx.Err()
		},
	}
	output := bytes.NewReader(
		make([]byte, terminalOutputChunkBytes*(terminalOutputQueueDepth+2)),
	)

	err := runner.streamOutput(context.Background(), output, "terminal.output")
	if !errors.Is(err, errTerminalOutputQueueFull) {
		t.Fatalf("streamOutput() error = %v", err)
	}
}

func TestLocalGitHubCredentialPersistsAndConfiguresGit(t *testing.T) {
	workspaceDir := filepath.Join(t.TempDir(), "repository")
	if err := os.MkdirAll(workspaceDir, 0o700); err != nil {
		t.Fatal(err)
	}
	runGitTestCommand(t, workspaceDir, nil, "init")
	runGitTestCommand(t, workspaceDir, nil, "remote", "add", "origin", "https://example.invalid/old.git")

	runner := &Runner{
		workspaceDir: workspaceDir,
		dataDir:      t.TempDir(),
		bootstrap: BootstrapResponse{
			LocalGitHubToken: "github-token",
			Launch: cloudpostgres.WorkerLaunchSpec{
				RepositoryURL: "https://github.com/example/repository",
			},
		},
	}
	tokenPath, err := runner.persistLocalGitHubToken()
	if err != nil {
		t.Fatalf("persistLocalGitHubToken() error = %v", err)
	}
	if runner.bootstrap.LocalGitHubToken != "" {
		t.Fatal("bootstrap retained local GitHub token")
	}
	info, err := os.Stat(tokenPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("token mode = %o, want 600", info.Mode().Perm())
	}
	if err := runner.configureLocalGitHubCredential(context.Background(), tokenPath); err != nil {
		t.Fatalf("configureLocalGitHubCredential() error = %v", err)
	}
	remote := strings.TrimSpace(string(runGitTestCommand(t, workspaceDir, nil, "remote", "get-url", "origin")))
	if remote != runner.bootstrap.Launch.RepositoryURL {
		t.Fatalf("origin = %q, want %q", remote, runner.bootstrap.Launch.RepositoryURL)
	}
	credentialInput := []byte("protocol=https\nhost=github.com\n\n")
	credential := string(runGitTestCommand(t, workspaceDir, credentialInput, "credential", "fill"))
	if !strings.Contains(credential, "username=x-access-token") ||
		!strings.Contains(credential, "password=github-token") {
		t.Fatalf("credential output = %q", credential)
	}
}

func runGitTestCommand(
	t *testing.T,
	dir string,
	stdin []byte,
	arguments ...string,
) []byte {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", dir}, arguments...)...)
	command.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	command.Stdin = bytes.NewReader(stdin)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", arguments, err, output)
	}
	return output
}

func TestRegressionRestartedClaudeSessionUsesRestoreCommand(t *testing.T) {
	agent := &recordingCloudAgentLauncher{
		launch:    []string{"agent", "new"},
		restore:   []string{"agent", "resume", "native-session"},
		restoreOK: true,
	}
	got, err := cloudAgentCommand(
		context.Background(),
		agent,
		ports.LaunchConfig{
			DataDir:       "/workspace/.ao/worker",
			Kind:          shareddomain.KindWorker,
			Permissions:   ports.PermissionModeBypassPermissions,
			SystemPrompt:  "standing instructions",
			WorkspacePath: "/workspace/repository",
		},
		clouddomain.Session{
			ID:             "session-one",
			AgentSessionID: "native-session",
		},
		true,
	)
	if err != nil {
		t.Fatalf("cloudAgentCommand() error = %v", err)
	}
	if !reflect.DeepEqual(got, agent.restore) {
		t.Fatalf("cloudAgentCommand() = %#v, want %#v", got, agent.restore)
	}
	if agent.restoreConfig.Session.Metadata[ports.MetadataKeyAgentSessionID] != "native-session" ||
		agent.restoreConfig.Session.WorkspacePath != "/workspace/repository" ||
		agent.restoreConfig.SystemPrompt != "standing instructions" {
		t.Fatalf("restore config = %#v", agent.restoreConfig)
	}
	if agent.launchCalls != 0 {
		t.Fatalf("GetLaunchCommand() calls = %d, want 0", agent.launchCalls)
	}
}

type recordingCloudAgentLauncher struct {
	launch        []string
	restore       []string
	restoreOK     bool
	launchCalls   int
	restoreConfig ports.RestoreConfig
}

func (a *recordingCloudAgentLauncher) GetLaunchCommand(
	context.Context,
	ports.LaunchConfig,
) ([]string, error) {
	a.launchCalls++
	return a.launch, nil
}

func (a *recordingCloudAgentLauncher) GetRestoreCommand(
	_ context.Context,
	config ports.RestoreConfig,
) ([]string, bool, error) {
	a.restoreConfig = config
	return a.restore, a.restoreOK, nil
}

type recordingWriter struct {
	writes [][]byte
}

func (w *recordingWriter) Write(data []byte) (int, error) {
	w.writes = append(w.writes, append([]byte(nil), data...))
	return len(data), nil
}

func readJSONObject(t *testing.T, path string) map[string]any {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%q) error = %v", path, err)
	}
	var object map[string]any
	if err := json.Unmarshal(contents, &object); err != nil {
		t.Fatalf("Unmarshal(%q) error = %v", path, err)
	}
	return object
}

func TestPrepareAgentCredentialEnvironment(t *testing.T) {
	tests := []struct {
		name           string
		harness        string
		credentialType string
		environmentKey string
	}{
		{
			name:           "Claude OAuth token",
			harness:        "claude-code",
			credentialType: "oauth_token",
			environmentKey: "CLAUDE_CODE_OAUTH_TOKEN",
		},
		{
			name:           "Claude API key",
			harness:        "claude-code",
			credentialType: "api_key",
			environmentKey: "ANTHROPIC_API_KEY",
		},
		{
			name:           "Cursor API key",
			harness:        "cursor",
			credentialType: "api_key",
			environmentKey: "CURSOR_API_KEY",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			credential := &AgentCredential{
				Provider:       test.harness,
				CredentialType: test.credentialType,
				Secret:         "test-secret",
			}
			runner := runnerWithCredential(test.harness, credential)
			environment := map[string]string{}

			name, err := runner.prepareAgentCredential(context.Background(), environment)
			if err != nil {
				t.Fatalf("prepareAgentCredential() error = %v", err)
			}
			if name != test.environmentKey {
				t.Fatalf("environment name = %q, want %q", name, test.environmentKey)
			}
			if environment[test.environmentKey] != "test-secret" {
				t.Fatalf("credential environment was not populated")
			}
			if credential.Secret != "" {
				t.Fatalf("credential secret was not cleared")
			}
		})
	}
}

func TestPrepareAgentCredentialCodexLoginUsesStdin(t *testing.T) {
	for _, credentialType := range []string{"api_key", "access_token"} {
		t.Run(credentialType, func(t *testing.T) {
			credential := &AgentCredential{
				Provider:       "codex",
				CredentialType: credentialType,
				Secret:         "codex-secret",
			}
			runner := runnerWithCredential("codex", credential)
			var gotName string
			var gotArguments []string
			var gotStdin string
			runner.credentialCommand = func(
				_ context.Context,
				name string,
				arguments []string,
				stdin io.Reader,
			) error {
				gotName = name
				gotArguments = append([]string(nil), arguments...)
				encoded, err := io.ReadAll(stdin)
				if err != nil {
					return err
				}
				gotStdin = string(encoded)
				return nil
			}
			environment := map[string]string{}

			name, err := runner.prepareAgentCredential(context.Background(), environment)
			if err != nil {
				t.Fatalf("prepareAgentCredential() error = %v", err)
			}
			wantOption := "--with-api-key"
			if credentialType == "access_token" {
				wantOption = "--with-access-token"
			}
			if gotName != "codex" || !reflect.DeepEqual(gotArguments, []string{"login", wantOption}) {
				t.Fatalf("command = %q %#v, want codex login %s", gotName, gotArguments, wantOption)
			}
			if gotStdin != "codex-secret" {
				t.Fatalf("stdin = %q, want credential", gotStdin)
			}
			if name != "" || len(environment) != 0 {
				t.Fatalf("Codex credential leaked into environment: name=%q env=%#v", name, environment)
			}
			if credential.Secret != "" {
				t.Fatalf("credential secret was not cleared")
			}
		})
	}
}

func TestPrepareAgentCredentialCodexLoginFailure(t *testing.T) {
	credential := &AgentCredential{
		Provider:       "codex",
		CredentialType: "api_key",
		Secret:         "codex-secret",
	}
	runner := runnerWithCredential("codex", credential)
	runner.credentialCommand = func(context.Context, string, []string, io.Reader) error {
		return errors.New("codex login failed")
	}

	if _, err := runner.prepareAgentCredential(context.Background(), map[string]string{}); err == nil {
		t.Fatal("prepareAgentCredential() error = nil, want login failure")
	}
	if credential.Secret != "" {
		t.Fatalf("credential secret was not cleared after failure")
	}
}

func TestPrepareWorkerHomeCreatesConfiguredDirectories(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	codexHome := filepath.Join(home, ".codex")
	claudeConfig := filepath.Join(home, ".claude")
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("CLAUDE_CONFIG_DIR", claudeConfig)

	if err := prepareWorkerHome(); err != nil {
		t.Fatalf("prepareWorkerHome() error = %v", err)
	}
	for _, path := range []string{home, codexHome, claudeConfig} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("Stat(%q) error = %v", path, err)
		}
		if !info.IsDir() {
			t.Fatalf("%q is not a directory", path)
		}
	}
}

func runnerWithCredential(harness string, credential *AgentCredential) *Runner {
	return &Runner{
		bootstrap: BootstrapResponse{
			Launch: cloudpostgres.WorkerLaunchSpec{
				Session: clouddomain.Session{Harness: harness},
			},
			AgentCredential: credential,
		},
	}
}
