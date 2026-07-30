package worker

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/creack/pty"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/registry"
	cloudlocalgh "github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm/localgh"
	cloudworkerhub "github.com/aoagents/agent-orchestrator/backend/internal/cloud/workerhub"
	shareddomain "github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Runner prepares a cloud workspace and runs its configured agent.
type Runner struct {
	client            *Client
	bootstrap         BootstrapResponse
	workspaceDir      string
	dataDir           string
	credentialCommand func(context.Context, string, []string, io.Reader) error
}

// NewRunner creates a worker runner from bootstrap launch data.
func NewRunner(client *Client, bootstrap BootstrapResponse, workspaceDir, dataDir string) *Runner {
	return &Runner{
		client:            client,
		bootstrap:         bootstrap,
		workspaceDir:      workspaceDir,
		dataDir:           dataDir,
		credentialCommand: runCredentialCommand,
	}
}

// Run prepares the repository and launches the configured interactive or structured runtime.
func (r *Runner) Run(ctx context.Context) error {
	if err := os.MkdirAll(r.dataDir, 0o700); err != nil {
		return fmt.Errorf("create worker data dir: %w", err)
	}
	if err := r.prepareRepository(ctx); err != nil {
		_ = r.client.Event(ctx, "repository.failed", map[string]string{"error": err.Error()})
		return err
	}
	agent, err := resolveAgent(r.bootstrap.Launch.Session.Harness)
	if err != nil {
		return err
	}
	launchConfig := ports.LaunchConfig{
		DataDir:       r.dataDir,
		Kind:          shareddomain.SessionKind(r.bootstrap.Launch.Session.Kind),
		Permissions:   ports.PermissionModeBypassPermissions,
		Prompt:        r.bootstrap.Launch.Session.Prompt,
		SessionID:     string(r.bootstrap.Launch.Session.ID),
		SystemPrompt:  systemPrompt(r.bootstrap.Launch.Session.Kind),
		WorkspacePath: r.workspaceDir,
	}
	if r.bootstrap.Launch.Session.Harness == "claude-code" {
		home, err := os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("resolve Claude home: %w", err)
		}
		if err := prepareClaudeCloudExperience(home); err != nil {
			return err
		}
	}
	if preLaunch, ok := agent.(interface {
		PreLaunch(context.Context, ports.LaunchConfig) error
	}); ok {
		if err := preLaunch.PreLaunch(ctx, launchConfig); err != nil {
			return fmt.Errorf("prepare agent launch: %w", err)
		}
	}
	hookEnvironment := workerEnvironment(r.client.getToken())
	if augmenter, ok := agent.(interface {
		AugmentRuntimeEnv(map[string]string, string)
	}); ok {
		augmenter.AugmentRuntimeEnv(hookEnvironment, r.dataDir)
	}
	if err := agent.GetAgentHooks(ctx, ports.WorkspaceHookConfig{
		DataDir:       r.dataDir,
		Env:           hookEnvironment,
		SessionID:     string(r.bootstrap.Launch.Session.ID),
		SystemPrompt:  launchConfig.SystemPrompt,
		WorkspacePath: r.workspaceDir,
	}); err != nil {
		return fmt.Errorf("install agent hooks: %w", err)
	}
	argv, err := agent.GetLaunchCommand(ctx, launchConfig)
	if err != nil {
		return fmt.Errorf("build agent launch command: %w", err)
	}
	if len(argv) == 0 {
		return errors.New("agent launch command is empty")
	}
	strategy, err := agent.GetPromptDeliveryStrategy(ctx, launchConfig)
	if err != nil {
		return fmt.Errorf("resolve prompt delivery: %w", err)
	}
	credentialEnvironmentName, err := r.prepareAgentCredential(ctx, hookEnvironment)
	if err != nil {
		return err
	}
	runtimeEnvironment := append(os.Environ(), envList(hookEnvironment)...)
	clearEnvironmentSecret(hookEnvironment, credentialEnvironmentName)
	switch r.bootstrap.Launch.Session.Harness {
	case "claude-code":
		if structuredRuntimeEnabled("claude-code") {
			return r.runStructuredClaude(ctx, argv, runtimeEnvironment)
		}
	case "codex":
		if structuredRuntimeEnabled("codex") {
			return r.runStructuredCodex(ctx, argv, runtimeEnvironment)
		}
	case "cursor":
		if structuredRuntimeEnabled("cursor") {
			return r.runStructuredCursor(ctx, argv, runtimeEnvironment)
		}
	}
	return r.runInteractiveAgent(ctx, argv, launchConfig, strategy, runtimeEnvironment)
}

func (r *Runner) runInteractiveAgent(
	ctx context.Context,
	argv []string,
	launchConfig ports.LaunchConfig,
	strategy ports.PromptDeliveryStrategy,
	environment []string,
) error {
	command := exec.CommandContext(ctx, argv[0], argv[1:]...)
	command.Dir = r.workspaceDir
	command.Env = environment
	terminal, err := pty.Start(command)
	if err != nil {
		return fmt.Errorf("start agent PTY: %w", err)
	}
	defer func() { _ = terminal.Close() }()
	var terminalWriteMu sync.Mutex
	_ = r.client.Event(ctx, "agent.started", map[string]any{
		"harness": r.bootstrap.Launch.Session.Harness,
		"argv0":   filepath.Base(argv[0]),
	})

	if strategy == ports.PromptDeliveryAfterStart && strings.TrimSpace(launchConfig.Prompt) != "" {
		go func() {
			select {
			case <-ctx.Done():
			case <-time.After(1500 * time.Millisecond):
				terminalWriteMu.Lock()
				_, _ = terminal.WriteString(launchConfig.Prompt + "\r")
				terminalWriteMu.Unlock()
			}
		}()
	}
	heartbeatCtx, cancelHeartbeat := context.WithCancel(ctx)
	defer cancelHeartbeat()
	var heartbeatWG sync.WaitGroup
	heartbeatWG.Add(1)
	go func() {
		defer heartbeatWG.Done()
		r.heartbeatLoop(heartbeatCtx)
	}()
	commandCtx, cancelCommands := context.WithCancel(ctx)
	defer cancelCommands()
	var commandWG sync.WaitGroup
	commandWG.Add(1)
	go func() {
		defer commandWG.Done()
		r.commandLoop(commandCtx, terminal, &terminalWriteMu)
	}()

	readErr := r.streamOutput(ctx, terminal)
	waitErr := command.Wait()
	cancelHeartbeat()
	cancelCommands()
	heartbeatWG.Wait()
	commandWG.Wait()
	exitCode := 0
	if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else if ctx.Err() == nil {
			return fmt.Errorf("wait for agent: %w", waitErr)
		}
	}
	_ = r.client.Event(context.Background(), "agent.exited", map[string]any{"exitCode": exitCode})
	if readErr != nil && !errors.Is(readErr, io.EOF) && ctx.Err() == nil {
		return fmt.Errorf("read agent PTY: %w", readErr)
	}
	return nil
}

func (r *Runner) commandLoop(
	ctx context.Context,
	terminal *os.File,
	writeMu *sync.Mutex,
) {
	backoff := time.Second
	var highestPrompt atomic.Int64
	var acknowledgedPrompt int64
	for ctx.Err() == nil {
		if highest := highestPrompt.Load(); highest > acknowledgedPrompt {
			if err := r.acknowledgePrompt(ctx, highest); err != nil {
				if !waitForRetry(ctx, backoff) {
					return
				}
				if backoff < 8*time.Second {
					backoff *= 2
				}
				continue
			}
			acknowledgedPrompt = highest
		}
		connectionStartedAt := time.Now()
		err := r.client.RunCommandStream(ctx, highestPrompt.Load(), func(command cloudworkerhub.Command) error {
			switch command.Type {
			case "input":
				decoded, err := base64.StdEncoding.DecodeString(command.Data)
				if err != nil {
					return fmt.Errorf("decode terminal input: %w", err)
				}
				writeMu.Lock()
				_, err = terminal.Write(decoded)
				writeMu.Unlock()
				return err
			case "prompt":
				if command.Sequence > 0 && command.Sequence <= highestPrompt.Load() {
					return nil
				}
				decoded, err := base64.StdEncoding.DecodeString(command.Data)
				if err != nil {
					return fmt.Errorf("decode prompt: %w", err)
				}
				writeMu.Lock()
				_, err = terminal.Write(append(decoded, '\r'))
				writeMu.Unlock()
				if err == nil && command.Sequence > 0 {
					highestPrompt.Store(command.Sequence)
					if err := r.acknowledgePrompt(ctx, command.Sequence); err != nil {
						return err
					}
					acknowledgedPrompt = command.Sequence
				}
				return err
			case "resize":
				return pty.Setsize(terminal, &pty.Winsize{Rows: command.Rows, Cols: command.Cols})
			case "keepalive":
				return nil
			case "interrupt":
				writeMu.Lock()
				_, err := terminal.Write([]byte{3})
				writeMu.Unlock()
				if err != nil {
					return err
				}
				return r.reportTurnInterrupted(ctx, command.Sequence)
			default:
				return fmt.Errorf("unsupported worker command %q", command.Type)
			}
		})
		if ctx.Err() != nil {
			return
		}
		stableConnection := time.Since(connectionStartedAt) >= 10*time.Second
		if stableConnection {
			backoff = time.Second
		}
		_ = r.client.Event(ctx, "worker.command_stream_disconnected", map[string]string{"error": err.Error()})
		if !waitForRetry(ctx, backoff) {
			return
		}
		if !stableConnection && backoff < 8*time.Second {
			backoff *= 2
		}
	}
}

func (r *Runner) prepareRepository(ctx context.Context) error {
	_ = r.client.Event(ctx, "repository.cloning", map[string]string{
		"url": r.bootstrap.Launch.RepositoryURL,
	})
	if info, err := os.Stat(filepath.Join(r.workspaceDir, ".git")); err == nil && info.IsDir() {
		return r.checkoutBranch(ctx)
	}
	if err := os.MkdirAll(filepath.Dir(r.workspaceDir), 0o750); err != nil {
		return fmt.Errorf("create workspace parent: %w", err)
	}
	cloneURL, err := cloudlocalgh.ProxyURL(
		os.Getenv("AO_CLOUD_PUBLIC_URL"),
		r.bootstrap.Launch.RepositoryURL,
	)
	if err != nil {
		return err
	}
	// #nosec G702 -- repository URL and branch are passed as argv, never through a shell.
	command := exec.CommandContext(
		ctx,
		"git",
		"clone",
		"--branch",
		r.bootstrap.Launch.DefaultBranch,
		"--single-branch",
		cloneURL,
		r.workspaceDir,
	)
	command.Env = append(os.Environ(),
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0=http.extraHeader",
		"GIT_CONFIG_VALUE_0=Authorization: Worker "+r.client.getToken(),
	)
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("clone repository: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if err := r.checkoutBranch(ctx); err != nil {
		return err
	}
	_ = r.client.Event(ctx, "repository.ready", map[string]string{
		"branch": r.bootstrap.Launch.Session.Branch,
	})
	return nil
}

func (r *Runner) checkoutBranch(ctx context.Context) error {
	branch := r.bootstrap.Launch.Session.Branch
	command := exec.CommandContext(ctx, "git", "-C", r.workspaceDir, "checkout", "-B", branch)
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("checkout session branch: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func (r *Runner) streamOutput(ctx context.Context, terminal io.Reader) error {
	buffer := make([]byte, 32<<10)
	for {
		count, err := terminal.Read(buffer)
		if count > 0 {
			payload := map[string]any{
				"encoding": "base64",
				"data":     base64.StdEncoding.EncodeToString(buffer[:count]),
			}
			if eventErr := r.client.Event(ctx, "terminal.output", payload); eventErr != nil {
				return eventErr
			}
		}
		if err != nil {
			return err
		}
	}
}

func (r *Runner) heartbeatLoop(ctx context.Context) {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		if err := r.client.Heartbeat(ctx, Version, r.runtimeCapabilities()); err != nil && ctx.Err() == nil {
			_ = r.client.Event(ctx, "worker.heartbeat_failed", map[string]string{"error": err.Error()})
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (r *Runner) runtimeCapabilities() []string {
	capabilities := append([]string(nil), DefaultCapabilities...)
	if structuredRuntimeEnabled(r.bootstrap.Launch.Session.Harness) {
		capabilities = append(capabilities, "chat.stream-json.v1")
	} else {
		capabilities = append(capabilities, "runtime.pty.v1")
	}
	return capabilities
}

func structuredRuntimeEnabled(harness string) bool {
	switch harness {
	case "claude-code":
		return os.Getenv("AO_CLOUD_CLAUDE_PTY") != "1"
	case "codex":
		return os.Getenv("AO_CLOUD_CODEX_PTY") != "1"
	case "cursor":
		return os.Getenv("AO_CLOUD_CURSOR_PTY") != "1"
	default:
		return false
	}
}

func resolveAgent(harness string) (ports.Agent, error) {
	adapterRegistry, err := registry.Build()
	if err != nil {
		return nil, err
	}
	adapter, ok := adapterRegistry.Get(harness)
	if !ok {
		return nil, fmt.Errorf("agent adapter %q is not registered", harness)
	}
	agent, ok := adapter.(ports.Agent)
	if !ok {
		return nil, fmt.Errorf("adapter %q cannot launch an agent", harness)
	}
	return agent, nil
}

func (r *Runner) prepareAgentCredential(
	ctx context.Context,
	environment map[string]string,
) (string, error) {
	harness := r.bootstrap.Launch.Session.Harness
	credential := r.bootstrap.AgentCredential
	if credential == nil {
		switch harness {
		case "claude-code", "codex", "cursor":
			return "", fmt.Errorf("agent credential for %s is required", harness)
		default:
			return "", nil
		}
	}
	defer func() { credential.Secret = "" }()
	if credential.Provider != harness {
		return "", fmt.Errorf(
			"agent credential provider %q does not match session harness %q",
			credential.Provider,
			harness,
		)
	}
	if credential.Secret == "" {
		return "", fmt.Errorf("agent credential for %s is empty", harness)
	}
	switch harness {
	case "claude-code":
		switch credential.CredentialType {
		case "oauth_token":
			environment["CLAUDE_CODE_OAUTH_TOKEN"] = credential.Secret
			return "CLAUDE_CODE_OAUTH_TOKEN", nil
		case "api_key":
			environment["ANTHROPIC_API_KEY"] = credential.Secret
			return "ANTHROPIC_API_KEY", nil
		}
	case "cursor":
		if credential.CredentialType == "api_key" {
			environment["CURSOR_API_KEY"] = credential.Secret
			return "CURSOR_API_KEY", nil
		}
	case "codex":
		var option string
		switch credential.CredentialType {
		case "api_key":
			option = "--with-api-key"
		case "access_token":
			option = "--with-access-token"
		default:
			return "", fmt.Errorf(
				"credential type %q is not supported for %s",
				credential.CredentialType,
				harness,
			)
		}
		if err := r.credentialCommand(
			ctx,
			"codex",
			[]string{"login", option},
			strings.NewReader(credential.Secret),
		); err != nil {
			return "", err
		}
		return "", nil
	}
	return "", fmt.Errorf(
		"credential type %q is not supported for %s",
		credential.CredentialType,
		harness,
	)
}

func runCredentialCommand(
	ctx context.Context,
	name string,
	arguments []string,
	stdin io.Reader,
) error {
	command := exec.CommandContext(ctx, name, arguments...)
	command.Stdin = stdin
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Run(); err != nil {
		return fmt.Errorf("%s %s failed: %w", name, strings.Join(arguments, " "), err)
	}
	return nil
}

func clearEnvironmentSecret(environment map[string]string, name string) {
	if name == "" {
		return
	}
	environment[name] = ""
	delete(environment, name)
}

func prepareClaudeCloudExperience(home string) error {
	if err := updateJSONFile(filepath.Join(home, ".claude.json"), func(root map[string]any) {
		root["hasCompletedOnboarding"] = true
		root["theme"] = "dark"
	}); err != nil {
		return fmt.Errorf("prepare Claude onboarding: %w", err)
	}
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	if err := updateJSONFile(settingsPath, func(settings map[string]any) {
		settings["theme"] = "dark"
		settings["skipDangerousModePermissionPrompt"] = true
		permissions, _ := settings["permissions"].(map[string]any)
		if permissions == nil {
			permissions = map[string]any{}
			settings["permissions"] = permissions
		}
		permissions["defaultMode"] = "bypassPermissions"
	}); err != nil {
		return fmt.Errorf("prepare Claude settings: %w", err)
	}
	return nil
}

func updateJSONFile(path string, update func(map[string]any)) error {
	root := map[string]any{}
	contents, err := os.ReadFile(path)
	switch {
	case err == nil && len(contents) > 0:
		if err := json.Unmarshal(contents, &root); err != nil {
			return fmt.Errorf("parse %s: %w", path, err)
		}
	case err == nil || errors.Is(err, os.ErrNotExist):
	default:
		return fmt.Errorf("read %s: %w", path, err)
	}
	update(root)
	encoded, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", path, err)
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", dir, err)
	}
	temporary, err := os.CreateTemp(dir, ".ao-cloud-config-*")
	if err != nil {
		return fmt.Errorf("create temporary config: %w", err)
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("secure temporary config: %w", err)
	}
	if _, err := temporary.Write(encoded); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write temporary config: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close temporary config: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("replace %s: %w", path, err)
	}
	return nil
}

func workerEnvironment(token string) map[string]string {
	return map[string]string{
		"AO_CLOUD_PUBLIC_URL": os.Getenv("AO_CLOUD_PUBLIC_URL"),
		"AO_WORKER_TOKEN":     token,
		"AO_SESSION_ID":       os.Getenv("AO_CLOUD_SESSION_ID"),
		"AO_DATA_DIR":         os.Getenv("AO_DATA_DIR"),
	}
}

func envList(values map[string]string) []string {
	result := make([]string, 0, len(values))
	for name, value := range values {
		if value != "" {
			result = append(result, name+"="+value)
		}
	}
	return result
}

func systemPrompt(kind string) string {
	if kind != "orchestrator" {
		return ""
	}
	return `You are the AO project orchestrator. Coordinate work through normal AO commands such as ao spawn and ao send. Do not reason about sandbox providers, virtual machines, hosted databases, or worker routing; AO implements those details.`
}
