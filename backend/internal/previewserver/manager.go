// Package previewserver owns deterministic, session-scoped development server
// processes used by the desktop preview. It deliberately does not scan global
// localhost ports: a server is started from an explicit project configuration,
// so its worker, command, working directory, and URL are known.
package previewserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

const (
	// ConfigPath is the workspace-relative managed preview configuration file.
	ConfigPath              = ".ao/launch.json"
	defaultReadyTimeout     = 30 * time.Second
	maxReadyTimeout         = 55 * time.Second
	probeInterval           = 150 * time.Millisecond
	probeTimeout            = time.Second
	maxRedirects            = 5
	statusLogLines          = 40
	maxBufferedLogLines     = 200
	maxBufferedPartialBytes = 16 * 1024
)

// State is the lifecycle state of a managed preview process.
type State string

const (
	// StateStopped indicates that no preview process is running.
	StateStopped State = "stopped"
	// StateStarting indicates that the preview process is waiting to become ready.
	StateStarting State = "starting"
	// StateReady indicates that the configured preview URL is responding.
	StateReady State = "ready"
	// StateStopping indicates that AO is terminating the preview process.
	StateStopping State = "stopping"
	// StateFailed indicates that the preview process could not start, become ready, or stop.
	StateFailed State = "failed"
)

// TargetKind distinguishes browser applications from non-browser API servers.
type TargetKind string

const (
	// TargetApp is a preview that should open in the Browser panel.
	TargetApp TargetKind = "app"
	// TargetAPI is a server that should run without replacing the Browser panel.
	TargetAPI TargetKind = "api"
)

// Error is a stable service error that the HTTP controller can map without
// parsing platform-specific process errors.
type Error struct {
	Code    string
	Message string
}

func (e Error) Error() string { return e.Message }

// Status is the public state for one session's managed preview server.
type Status struct {
	SessionID     domain.SessionID `json:"sessionId"`
	State         State            `json:"state"`
	Configuration string           `json:"configuration,omitempty"`
	TargetKind    TargetKind       `json:"targetKind,omitempty"`
	URL           string           `json:"url,omitempty"`
	Port          int              `json:"port,omitempty"`
	StartedAt     time.Time        `json:"startedAt,omitempty"`
	Error         string           `json:"error,omitempty"`
	Logs          []string         `json:"logs"`
}

type launchFile struct {
	Version        int             `json:"version"`
	Configurations []Configuration `json:"configurations"`
}

// Configuration is one named server entry in .ao/launch.json. ${PORT} is
// expanded in runtimeArgs, url, and env values after AO chooses the port.
type Configuration struct {
	Name               string            `json:"name"`
	RuntimeExecutable  string            `json:"runtimeExecutable"`
	RuntimeArgs        []string          `json:"runtimeArgs,omitempty"`
	Cwd                string            `json:"cwd,omitempty"`
	Port               int               `json:"port,omitempty"`
	AutoPort           bool              `json:"autoPort,omitempty"`
	URL                string            `json:"url,omitempty"`
	Env                map[string]string `json:"env,omitempty"`
	TargetKind         TargetKind        `json:"targetKind,omitempty"`
	ReadyTimeoutMillis int               `json:"readyTimeoutMs,omitempty"`
}

type serverRun struct {
	status   Status
	cmd      *exec.Cmd
	done     chan struct{}
	logs     *lineBuffer
	stopping bool
}

// Manager supervises at most one managed preview server per AO session.
type Manager struct {
	log    *slog.Logger
	client *http.Client

	mu   sync.Mutex
	runs map[domain.SessionID]*serverRun

	operationsMu sync.Mutex
	operations   map[domain.SessionID]*sync.Mutex
}

// New creates a managed preview-server supervisor.
func New(log *slog.Logger) *Manager {
	if log == nil {
		log = slog.Default()
	}
	transport := &http.Transport{}
	if defaultTransport, ok := http.DefaultTransport.(*http.Transport); ok {
		transport = defaultTransport.Clone()
	}
	transport.Proxy = nil
	manager := &Manager{
		log:        log,
		runs:       make(map[domain.SessionID]*serverRun),
		operations: make(map[domain.SessionID]*sync.Mutex),
	}
	manager.client = &http.Client{
		Transport: transport,
		Timeout:   probeTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return errors.New("too many preview readiness redirects")
			}
			if !isLoopbackHost(req.URL.Hostname()) {
				return errors.New("preview readiness redirected away from loopback")
			}
			return nil
		},
	}
	return manager
}

// Start loads a named configuration, replaces any existing managed server for
// the session, and waits until the configured loopback URL responds.
func (m *Manager) Start(
	ctx context.Context,
	sessionID domain.SessionID,
	workspacePath string,
	configurationName string,
) (Status, error) {
	operation := m.operationLock(sessionID)
	operation.Lock()
	operationLocked := true
	defer func() {
		if operationLocked {
			operation.Unlock()
		}
	}()

	cfg, err := loadConfiguration(workspacePath, configurationName)
	if err != nil {
		return stoppedStatus(sessionID), err
	}
	if _, err := m.stop(context.Background(), sessionID); err != nil {
		return stoppedStatus(sessionID), err
	}

	port, err := selectPort(cfg.Port, cfg.AutoPort)
	if err != nil {
		return stoppedStatus(sessionID), serviceError("PREVIEW_PORT_UNAVAILABLE", err.Error())
	}
	workingDir, err := resolveWorkingDirectory(workspacePath, cfg.Cwd)
	if err != nil {
		return stoppedStatus(sessionID), err
	}
	targetURL, err := resolveTargetURL(cfg.URL, port)
	if err != nil {
		return stoppedStatus(sessionID), err
	}
	executable := interpolatePort(cfg.RuntimeExecutable, port)
	if strings.ContainsAny(executable, `/\`) && !filepath.IsAbs(executable) {
		executable = filepath.Join(workingDir, executable)
	}
	args := make([]string, len(cfg.RuntimeArgs))
	for i, arg := range cfg.RuntimeArgs {
		args[i] = interpolatePort(arg, port)
	}

	cmd := previewCommand(executable, args...)
	cmd.Dir = workingDir
	cmd.Env = previewEnvironment(os.Environ(), cfg.Env, sessionID, port)
	logs := newLineBuffer(maxBufferedLogLines)
	cmd.Stdout = logs
	cmd.Stderr = logs

	run := &serverRun{
		status: Status{
			SessionID:     sessionID,
			State:         StateStarting,
			Configuration: cfg.Name,
			TargetKind:    cfg.TargetKind,
			URL:           targetURL,
			Port:          port,
			StartedAt:     time.Now().UTC(),
			Logs:          []string{},
		},
		cmd:  cmd,
		done: make(chan struct{}),
		logs: logs,
	}
	if err := cmd.Start(); err != nil {
		run.cmd = nil
		run.status.State = StateFailed
		run.status.Error = fmt.Sprintf("start preview server: %v", err)
		m.mu.Lock()
		m.runs[sessionID] = run
		m.mu.Unlock()
		return m.statusFor(run), serviceError("PREVIEW_START_FAILED", run.status.Error)
	}

	m.mu.Lock()
	m.runs[sessionID] = run
	m.mu.Unlock()
	go m.waitForExit(sessionID, run)
	operation.Unlock()
	operationLocked = false

	timeout := readyTimeout(cfg.ReadyTimeoutMillis)
	deadline := time.Now().Add(timeout)
	for {
		if err := m.probe(ctx, targetURL); err == nil {
			m.mu.Lock()
			ready := false
			if m.runs[sessionID] == run && run.cmd != nil && !run.stopping {
				run.status.State = StateReady
				run.status.Error = ""
				ready = true
			}
			status := m.statusForLocked(run)
			m.mu.Unlock()
			if !ready {
				return status, serviceError("PREVIEW_START_CANCELED", "preview server was stopped before becoming ready")
			}
			m.log.Info("preview server ready", "session", sessionID, "configuration", cfg.Name, "url", targetURL)
			return status, nil
		}

		select {
		case <-ctx.Done():
			message := "preview start canceled: " + ctx.Err().Error()
			return m.failAndStop(sessionID, run, "PREVIEW_START_CANCELED", message)
		case <-run.done:
			status := m.statusFor(run)
			if status.Error == "" {
				status.Error = "preview server exited before becoming ready"
			}
			return status, serviceError("PREVIEW_EXITED", status.Error)
		default:
		}
		if time.Now().After(deadline) {
			message := fmt.Sprintf("preview server was not ready at %s within %s", targetURL, timeout)
			return m.failAndStop(sessionID, run, "PREVIEW_NOT_READY", message)
		}
		timer := time.NewTimer(probeInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			message := "preview start canceled: " + ctx.Err().Error()
			return m.failAndStop(sessionID, run, "PREVIEW_START_CANCELED", message)
		case <-run.done:
			timer.Stop()
			status := m.statusFor(run)
			if status.Error == "" {
				status.Error = "preview server exited before becoming ready"
			}
			return status, serviceError("PREVIEW_EXITED", status.Error)
		case <-timer.C:
		}
	}
}

// Stop terminates the exact process tree AO launched for the session.
func (m *Manager) Stop(ctx context.Context, sessionID domain.SessionID) (Status, error) {
	operation := m.operationLock(sessionID)
	operation.Lock()
	defer operation.Unlock()
	return m.stop(ctx, sessionID)
}

func (m *Manager) stop(ctx context.Context, sessionID domain.SessionID) (Status, error) {
	m.mu.Lock()
	run := m.runs[sessionID]
	if run == nil {
		m.mu.Unlock()
		return stoppedStatus(sessionID), nil
	}
	if run.cmd == nil {
		run.status.State = StateStopped
		run.status.Error = ""
		status := m.statusForLocked(run)
		m.mu.Unlock()
		return status, nil
	}
	run.stopping = true
	run.status.State = StateStopping
	cmd := run.cmd
	done := run.done
	m.mu.Unlock()

	if err := terminatePreviewProcess(cmd); err != nil {
		m.log.Warn("stop preview process tree", "session", sessionID, "err", err)
	}
	select {
	case <-done:
	case <-ctx.Done():
		return m.Status(sessionID), ctx.Err()
	case <-time.After(5 * time.Second):
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		select {
		case <-done:
		case <-ctx.Done():
			return m.Status(sessionID), ctx.Err()
		case <-time.After(time.Second):
			message := "preview server process did not exit after it was killed"
			m.mu.Lock()
			if m.runs[sessionID] == run {
				run.status.State = StateFailed
				run.status.Error = message
			}
			status := m.statusForLocked(run)
			m.mu.Unlock()
			return status, serviceError("PREVIEW_STOP_FAILED", message)
		}
	}

	m.mu.Lock()
	if m.runs[sessionID] == run {
		run.status.State = StateStopped
		run.status.Error = ""
	}
	status := m.statusForLocked(run)
	m.mu.Unlock()
	return status, nil
}

func (m *Manager) operationLock(sessionID domain.SessionID) *sync.Mutex {
	m.operationsMu.Lock()
	defer m.operationsMu.Unlock()
	operation := m.operations[sessionID]
	if operation == nil {
		operation = &sync.Mutex{}
		m.operations[sessionID] = operation
	}
	return operation
}

// Status returns the latest managed preview state for a session.
func (m *Manager) Status(sessionID domain.SessionID) Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	run := m.runs[sessionID]
	if run == nil {
		return stoppedStatus(sessionID)
	}
	return m.statusForLocked(run)
}

// StopSession implements ports.SessionPreviewLifecycle without exposing status
// to lifecycle callers that only need best-effort teardown.
func (m *Manager) StopSession(ctx context.Context, sessionID domain.SessionID) error {
	_, err := m.Stop(ctx, sessionID)
	return err
}

// Close stops every server owned by the daemon. It is safe to call repeatedly.
func (m *Manager) Close() {
	m.mu.Lock()
	ids := make([]domain.SessionID, 0, len(m.runs))
	for id := range m.runs {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
		_, _ = m.Stop(ctx, id)
		cancel()
	}
}

func (m *Manager) waitForExit(sessionID domain.SessionID, run *serverRun) {
	err := run.cmd.Wait()
	m.mu.Lock()
	if m.runs[sessionID] == run {
		run.cmd = nil
		if run.stopping {
			if run.status.State != StateFailed {
				run.status.State = StateStopped
				run.status.Error = ""
			}
		} else {
			run.status.State = StateFailed
			if err != nil {
				run.status.Error = fmt.Sprintf("preview server exited: %v", err)
			} else {
				run.status.Error = "preview server exited"
			}
		}
	}
	m.mu.Unlock()
	close(run.done)
}

func (m *Manager) failAndStop(
	sessionID domain.SessionID,
	run *serverRun,
	code string,
	message string,
) (Status, error) {
	m.mu.Lock()
	if m.runs[sessionID] == run {
		run.status.State = StateFailed
		run.status.Error = message
		run.stopping = true
	}
	cmd := run.cmd
	m.mu.Unlock()
	if cmd != nil {
		_ = terminatePreviewProcess(cmd)
		select {
		case <-run.done:
		case <-time.After(3 * time.Second):
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
		}
	}
	return m.statusFor(run), serviceError(code, message)
}

func (m *Manager) probe(ctx context.Context, target string) error {
	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, target, http.NoBody)
	if err != nil {
		return err
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.CopyN(io.Discard, resp.Body, 1024)
	if resp.StatusCode >= http.StatusInternalServerError {
		return fmt.Errorf("preview returned %s", resp.Status)
	}
	return nil
}

func (m *Manager) statusFor(run *serverRun) Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.statusForLocked(run)
}

func (m *Manager) statusForLocked(run *serverRun) Status {
	status := run.status
	status.Logs = run.logs.Last(statusLogLines)
	if status.Logs == nil {
		status.Logs = []string{}
	}
	return status
}

func loadConfiguration(workspacePath, requestedName string) (Configuration, error) {
	if strings.TrimSpace(workspacePath) == "" {
		return Configuration{}, serviceError("PREVIEW_WORKSPACE_MISSING", "session workspace is unavailable")
	}
	configPath := filepath.Join(workspacePath, filepath.FromSlash(ConfigPath))
	data, err := os.ReadFile(configPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Configuration{}, serviceError(
				"PREVIEW_CONFIG_NOT_FOUND",
				fmt.Sprintf("preview configuration not found at %s", ConfigPath),
			)
		}
		return Configuration{}, serviceError("PREVIEW_CONFIG_INVALID", fmt.Sprintf("read %s: %v", ConfigPath, err))
	}
	var file launchFile
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&file); err != nil {
		return Configuration{}, serviceError("PREVIEW_CONFIG_INVALID", fmt.Sprintf("decode %s: %v", ConfigPath, err))
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("unexpected trailing JSON value")
		}
		return Configuration{}, serviceError("PREVIEW_CONFIG_INVALID", fmt.Sprintf("decode %s: %v", ConfigPath, err))
	}
	if file.Version != 1 {
		return Configuration{}, serviceError("PREVIEW_CONFIG_INVALID", "preview configuration version must be 1")
	}
	if len(file.Configurations) == 0 {
		return Configuration{}, serviceError("PREVIEW_CONFIG_INVALID", "preview configuration has no configurations")
	}
	requestedName = strings.TrimSpace(requestedName)
	if requestedName == "" && len(file.Configurations) > 1 {
		return Configuration{}, serviceError(
			"PREVIEW_CONFIGURATION_REQUIRED",
			"multiple preview configurations exist; specify one by name",
		)
	}
	seen := make(map[string]struct{}, len(file.Configurations))
	var selected *Configuration
	for i := range file.Configurations {
		cfg := file.Configurations[i]
		cfg.Name = strings.TrimSpace(cfg.Name)
		if cfg.Name == "" {
			return Configuration{}, serviceError("PREVIEW_CONFIG_INVALID", "preview configuration name is required")
		}
		if _, duplicate := seen[cfg.Name]; duplicate {
			return Configuration{}, serviceError(
				"PREVIEW_CONFIG_INVALID",
				fmt.Sprintf("duplicate preview configuration name %q", cfg.Name),
			)
		}
		seen[cfg.Name] = struct{}{}
		if err := validateConfiguration(&cfg); err != nil {
			return Configuration{}, err
		}
		if requestedName == "" || cfg.Name == requestedName {
			candidate := cfg
			selected = &candidate
		}
	}
	if selected != nil {
		return *selected, nil
	}
	return Configuration{}, serviceError(
		"PREVIEW_CONFIGURATION_NOT_FOUND",
		fmt.Sprintf("preview configuration %q was not found", requestedName),
	)
}

func validateConfiguration(cfg *Configuration) error {
	cfg.RuntimeExecutable = strings.TrimSpace(cfg.RuntimeExecutable)
	if cfg.RuntimeExecutable == "" {
		return serviceError(
			"PREVIEW_CONFIG_INVALID",
			fmt.Sprintf("preview configuration %q requires runtimeExecutable", cfg.Name),
		)
	}
	if cfg.Port < 0 || cfg.Port > 65535 || (!cfg.AutoPort && cfg.Port == 0) {
		return serviceError(
			"PREVIEW_CONFIG_INVALID",
			fmt.Sprintf("preview configuration %q has an invalid port", cfg.Name),
		)
	}
	if cfg.TargetKind == "" {
		cfg.TargetKind = TargetApp
	}
	if cfg.TargetKind != TargetApp && cfg.TargetKind != TargetAPI {
		return serviceError(
			"PREVIEW_CONFIG_INVALID",
			fmt.Sprintf("preview configuration %q targetKind must be app or api", cfg.Name),
		)
	}
	if cfg.ReadyTimeoutMillis < 0 || time.Duration(cfg.ReadyTimeoutMillis)*time.Millisecond > maxReadyTimeout {
		return serviceError(
			"PREVIEW_CONFIG_INVALID",
			fmt.Sprintf("preview configuration %q readyTimeoutMs must be between 0 and %d", cfg.Name, maxReadyTimeout.Milliseconds()),
		)
	}
	for key := range cfg.Env {
		if strings.TrimSpace(key) == "" || strings.ContainsAny(key, "=\x00") {
			return serviceError(
				"PREVIEW_CONFIG_INVALID",
				fmt.Sprintf("preview configuration %q has an invalid env key %q", cfg.Name, key),
			)
		}
	}
	return nil
}

func resolveWorkingDirectory(workspacePath, relative string) (string, error) {
	workspaceAbs, err := filepath.Abs(workspacePath)
	if err != nil {
		return "", serviceError("PREVIEW_CONFIG_INVALID", "resolve session workspace: "+err.Error())
	}
	relative = strings.TrimSpace(relative)
	if filepath.IsAbs(relative) {
		return "", serviceError("PREVIEW_CONFIG_INVALID", "preview cwd must be relative to the session workspace")
	}
	target := filepath.Clean(filepath.Join(workspaceAbs, relative))
	rel, err := filepath.Rel(workspaceAbs, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", serviceError("PREVIEW_CONFIG_INVALID", "preview cwd escapes the session workspace")
	}
	info, err := os.Stat(target)
	if err != nil || !info.IsDir() {
		return "", serviceError("PREVIEW_CONFIG_INVALID", fmt.Sprintf("preview cwd %q is not a directory", relative))
	}
	// Reject symlinked descendants instead of resolving them. This prevents a
	// configured cwd from escaping the worker workspace while avoiding
	// platform-specific canonicalization of trusted workspace ancestors.
	current := workspaceAbs
	if rel != "." {
		for _, part := range strings.Split(rel, string(filepath.Separator)) {
			current = filepath.Join(current, part)
			entry, err := os.Lstat(current)
			if err != nil {
				return "", serviceError("PREVIEW_CONFIG_INVALID", fmt.Sprintf("inspect preview cwd %q: %v", relative, err))
			}
			if entry.Mode()&os.ModeSymlink != 0 {
				return "", serviceError("PREVIEW_CONFIG_INVALID", "preview cwd cannot contain symlinks")
			}
		}
	}
	return target, nil
}

func resolveTargetURL(raw string, port int) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		raw = "http://127.0.0.1:${PORT}/"
	}
	parsed, err := url.Parse(interpolatePort(raw, port))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", serviceError("PREVIEW_CONFIG_INVALID", "preview url must be an http(s) loopback URL")
	}
	if !isLoopbackHost(parsed.Hostname()) {
		return "", serviceError("PREVIEW_CONFIG_INVALID", "preview url must use localhost or a loopback address")
	}
	return parsed.String(), nil
}

func selectPort(preferred int, auto bool) (int, error) {
	if !auto {
		return preferred, nil
	}
	address := "127.0.0.1:0"
	if preferred > 0 {
		address = net.JoinHostPort("127.0.0.1", strconv.Itoa(preferred))
	}
	listener, err := net.Listen("tcp", address)
	if err != nil && preferred > 0 {
		listener, err = net.Listen("tcp", "127.0.0.1:0")
	}
	if err != nil {
		return 0, fmt.Errorf("select preview port: %w", err)
	}
	tcpAddress, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		_ = listener.Close()
		return 0, errors.New("selected preview listener did not return a TCP address")
	}
	port := tcpAddress.Port
	if err := listener.Close(); err != nil {
		return 0, fmt.Errorf("release selected preview port: %w", err)
	}
	return port, nil
}

func previewEnvironment(
	base []string,
	configured map[string]string,
	sessionID domain.SessionID,
	port int,
) []string {
	env := append([]string{}, base...)
	for key, value := range configured {
		env = append(env, key+"="+interpolatePort(value, port))
	}
	env = append(env,
		"PORT="+strconv.Itoa(port),
		"AO_PREVIEW_PORT="+strconv.Itoa(port),
		"AO_SESSION_ID="+string(sessionID),
	)
	return env
}

func interpolatePort(value string, port int) string {
	return strings.ReplaceAll(value, "${PORT}", strconv.Itoa(port))
}

func readyTimeout(milliseconds int) time.Duration {
	if milliseconds <= 0 {
		return defaultReadyTimeout
	}
	return time.Duration(milliseconds) * time.Millisecond
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(strings.TrimSpace(host), "localhost") {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

func stoppedStatus(sessionID domain.SessionID) Status {
	return Status{SessionID: sessionID, State: StateStopped, Logs: []string{}}
}

func serviceError(code, message string) Error {
	return Error{Code: code, Message: message}
}

type lineBuffer struct {
	mu      sync.Mutex
	max     int
	lines   []string
	partial string
}

func newLineBuffer(capacity int) *lineBuffer {
	return &lineBuffer{max: capacity}
}

func (b *lineBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	text := b.partial + string(data)
	parts := strings.Split(text, "\n")
	b.partial = parts[len(parts)-1]
	if len(b.partial) > maxBufferedPartialBytes {
		b.partial = b.partial[len(b.partial)-maxBufferedPartialBytes:]
	}
	for _, line := range parts[:len(parts)-1] {
		b.appendLocked(strings.TrimSuffix(line, "\r"))
	}
	return len(data), nil
}

func (b *lineBuffer) Last(limit int) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	lines := append([]string{}, b.lines...)
	if b.partial != "" {
		lines = append(lines, b.partial)
	}
	if len(lines) > limit {
		lines = lines[len(lines)-limit:]
	}
	return lines
}

func (b *lineBuffer) appendLocked(line string) {
	b.lines = append(b.lines, line)
	if len(b.lines) > b.max {
		b.lines = append([]string{}, b.lines[len(b.lines)-b.max:]...)
	}
}
