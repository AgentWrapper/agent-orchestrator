// Package tmux implements ports.Runtime using tmux sessions on Darwin/Linux.
package tmux

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/ptyexec"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	defaultTimeout    = 5 * time.Second
	defaultChunkBytes = 16 * 1024
	// defaultEnterDelay mirrors conpty's ptyInputEnterDelay: a pause after pasting
	// a non-empty message, before the trailing Enter, so a large multiline paste
	// does not absorb the Enter and leave the prompt unsubmitted (issue #2342).
	defaultEnterDelay = 300 * time.Millisecond
)

var sessionIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

var getenv = os.Getenv

// Options configures a tmux Runtime. Every field has a sensible default (see
// New), so the zero value is usable.
type Options struct {
	Binary     string        // default "tmux" (resolved via exec.LookPath)
	Shell      string        // default $SHELL else /bin/sh
	Timeout    time.Duration // default 5s
	ChunkSize  int           // default 16*1024
	EnterDelay time.Duration // pause after pasting a non-empty message before pressing Enter; default defaultEnterDelay. Conpty already does this (ptyInputEnterDelay); tmux lacked it, so a large multiline paste could absorb the trailing Enter and leave the prompt unsubmitted (issue #2342).
}

// Runtime runs agent sessions inside tmux sessions, driving them via the tmux
// CLI. It implements ports.Runtime.
type Runtime struct {
	binary     string
	shell      string
	timeout    time.Duration
	chunkSize  int
	enterDelay time.Duration
	runner     runner
}

var _ ports.Runtime = (*Runtime)(nil)
var _ ports.Attacher = (*Runtime)(nil)

type runner interface {
	Run(ctx context.Context, env []string, name string, args ...string) ([]byte, error)
}

type execRunner struct{}

func (execRunner) Run(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(append([]string(nil), os.Environ()...), env...)
	return cmd.CombinedOutput()
}

// New builds a tmux Runtime, filling unset Options with defaults: binary "tmux"
// (resolved via exec.LookPath), shell from $SHELL (else /bin/sh), and the
// default timeout and output chunk size.
func New(opts Options) *Runtime {
	binary := opts.Binary
	if binary == "" {
		if path, err := exec.LookPath("tmux"); err == nil {
			binary = path
		} else {
			binary = "tmux"
		}
	}
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = defaultTimeout
	}
	shellPath := opts.Shell
	if shellPath == "" {
		shellPath = getenv("SHELL")
	}
	if shellPath == "" {
		shellPath = "/bin/sh"
	}
	chunkSize := opts.ChunkSize
	if chunkSize <= 0 {
		chunkSize = defaultChunkBytes
	}
	enterDelay := opts.EnterDelay
	if enterDelay <= 0 {
		enterDelay = defaultEnterDelay
	}
	return &Runtime{
		binary:     binary,
		shell:      shellPath,
		timeout:    timeout,
		chunkSize:  chunkSize,
		enterDelay: enterDelay,
		runner:     execRunner{},
	}
}

// Create starts a new tmux session in the workspace, running the agent's
// launch command with a keep-alive shell, and returns a handle to it.
func (r *Runtime) Create(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	id, err := tmuxSessionName(cfg.SessionID)
	if err != nil {
		return ports.RuntimeHandle{}, err
	}
	if cfg.WorkspacePath == "" {
		return ports.RuntimeHandle{}, errors.New("tmux runtime: workspace path is required")
	}
	if len(cfg.Argv) == 0 {
		return ports.RuntimeHandle{}, errors.New("tmux runtime: launch command is required")
	}
	if err := validateEnvKeys(cfg.Env); err != nil {
		return ports.RuntimeHandle{}, err
	}

	launchCmd := buildLaunchCommand(cfg)
	args := newSessionArgs(id, cfg.WorkspacePath, r.shell, launchCmd)
	if _, err := r.run(ctx, args...); err != nil {
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: create session %s: %w", id, err)
	}

	// Hide the status bar in the embedded terminal: it clutters the view and
	// was not designed for the in-browser display context.
	if _, err := r.run(ctx, setStatusOffArgs(id)...); err != nil {
		_ = r.Destroy(context.Background(), ports.RuntimeHandle{ID: id})
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: set status %s: %w", id, err)
	}

	// Enable mouse mode so the embedded terminal's SGR wheel reports scroll the
	// pane (see setMouseOnArgs). Without it, wheel scrolling silently no-ops.
	if _, err := r.run(ctx, setMouseOnArgs(id)...); err != nil {
		_ = r.Destroy(context.Background(), ports.RuntimeHandle{ID: id})
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: set mouse %s: %w", id, err)
	}

	handle := ports.RuntimeHandle{ID: id}
	alive, err := r.IsAlive(ctx, handle)
	if err != nil {
		_ = r.Destroy(context.Background(), handle)
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: verify session %s: %w", id, err)
	}
	if !alive {
		_ = r.Destroy(context.Background(), handle)
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: session %s exited before ready", id)
	}
	return handle, nil
}

// Destroy kills the handle's tmux session. An already-gone session is treated
// as success (idempotent).
func (r *Runtime) Destroy(ctx context.Context, handle ports.RuntimeHandle) error {
	id, err := handleID(handle)
	if err != nil {
		return err
	}
	out, err := r.run(ctx, killSessionArgs(id)...)
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && killSessionMissingOutput(string(out)) {
			return nil
		}
		return fmt.Errorf("tmux runtime: destroy session %s: %w", id, err)
	}
	return nil
}

// IsAlive reports whether the handle's session still exists via `tmux
// has-session`. Exit 0 means alive. A non-zero exit with output indicating the
// session or server is missing is a definitive false, nil. Any other non-zero
// exit is a probe error (not proof of death) so callers (the reaper feeding
// the LCM) treat it as a failed probe and never kill a session on a transient
// error.
func (r *Runtime) IsAlive(ctx context.Context, handle ports.RuntimeHandle) (bool, error) {
	id, err := handleID(handle)
	if err != nil {
		return false, err
	}
	out, err := r.run(ctx, hasSessionArgs(id)...)
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && sessionMissingOutput(string(out)) {
			return false, nil
		}
		return false, fmt.Errorf("tmux runtime: probe session %s: %w", id, err)
	}
	return true, nil
}

// SendMessage sends literal text to the session (chunked via send-keys -l) then
// presses Enter to submit. An empty message presses Enter alone (the nudge
// contract on ports.AgentMessenger).
//
// ponytail: send-keys -l chunked is simpler than load-buffer/paste-buffer; the
// ceiling is very large messages may be slower, but chunk size defaults to 16 KB
// which is ample for agent prompts.
func (r *Runtime) SendMessage(ctx context.Context, handle ports.RuntimeHandle, message string) error {
	id, err := handleID(handle)
	if err != nil {
		return err
	}
	enterCtx := ctx
	if message != "" {
		for _, chunk := range chunks(message, r.chunkSize) {
			if _, err := r.run(ctx, sendKeysLiteralArgs(id, chunk)...); err != nil {
				return fmt.Errorf("tmux runtime: send message %s: %w", id, err)
			}
		}
		// Give the target TUI a moment to accept the pasted text before the
		// trailing Enter, mirroring conpty's ptyInputEnterDelay. Without it a
		// large multiline paste can absorb the Enter and leave the prompt
		// unsubmitted (issue #2342). Empty-message nudges skip this — there is
		// no paste ahead of a catch-up Enter.
		//
		// From here on the chunks are already in the pane, so the pause and
		// the Enter are detached from the caller's cancellation (bounded by
		// their own timeout instead): abandoning mid-pause would strand an
		// unsubmitted draft that a retried send would then double-paste.
		var cancel context.CancelFunc
		enterCtx, cancel = context.WithTimeout(context.WithoutCancel(ctx), r.enterDelay+5*time.Second)
		defer cancel()
		if r.enterDelay > 0 {
			select {
			case <-enterCtx.Done():
				return enterCtx.Err()
			case <-time.After(r.enterDelay):
			}
		}
	}
	if _, err := r.run(enterCtx, sendEnterArgs(id)...); err != nil {
		return fmt.Errorf("tmux runtime: send enter %s: %w", id, err)
	}
	return nil
}

// GetOutput returns the last `lines` lines of the session pane's captured
// output.
func (r *Runtime) GetOutput(ctx context.Context, handle ports.RuntimeHandle, lines int) (string, error) {
	id, err := handleID(handle)
	if err != nil {
		return "", err
	}
	if lines <= 0 {
		return "", errors.New("tmux runtime: lines must be positive")
	}
	out, err := r.run(ctx, capturePaneArgs(id, lines)...)
	if err != nil {
		return "", fmt.Errorf("tmux runtime: capture output %s: %w", id, err)
	}
	return tailLines(trimTrailingBlankLines(string(out)), lines), nil
}

// Attach opens a fresh attach Stream by spawning `tmux attach-session` on a
// local PTY, sized rows x cols from birth when known. ctx cancellation closes
// the PTY.
func (r *Runtime) Attach(ctx context.Context, handle ports.RuntimeHandle, rows, cols uint16) (ports.Stream, error) {
	argv, err := r.attachCommand(handle)
	if err != nil {
		return nil, err
	}
	return ptyexec.Spawn(ctx, argv, attachEnv(os.Environ()), rows, cols)
}

// attachCommand returns the argv to attach a terminal to the session.
// tmux needs no per-session env block.
func (r *Runtime) attachCommand(handle ports.RuntimeHandle) ([]string, error) {
	id, err := handleID(handle)
	if err != nil {
		return nil, err
	}
	return []string{r.binary, "attach-session", "-t", id}, nil
}

func attachEnv(base []string) []string {
	env := append([]string(nil), base...)
	for i, kv := range env {
		if strings.HasPrefix(kv, "TERM=") {
			env[i] = "TERM=xterm-256color"
			return env
		}
	}
	return append(env, "TERM=xterm-256color")
}

// run wraps runner.Run with a per-call timeout context.
func (r *Runtime) run(ctx context.Context, args ...string) ([]byte, error) {
	cmdCtx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()
	out, err := r.runner.Run(cmdCtx, nil, r.binary, args...)
	if cmdCtx.Err() != nil {
		return out, cmdCtx.Err()
	}
	if err != nil {
		return out, commandError{err: err, output: strings.TrimSpace(string(out))}
	}
	return out, nil
}

// -- session name helpers --

func tmuxSessionName(id domain.SessionID) (string, error) {
	raw := string(id)
	if raw == "" {
		return "", errors.New("tmux runtime: session id is required")
	}
	return SessionName(raw), nil
}

// SessionName returns the tmux session name the runtime registers for a given
// session id, applying the same sanitisation Create does. Callers that print an
// attach hint must use this rather than the raw id.
func SessionName(id string) string {
	if sessionIDPattern.MatchString(id) && len(id) <= 48 {
		return id
	}
	return sanitizedSessionName(id)
}

func sanitizedSessionName(raw string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range raw {
		valid := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-'
		if valid {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}
	base := strings.Trim(b.String(), "-")
	if base == "" {
		base = "session"
	}
	if len(base) > 32 {
		base = strings.TrimRight(base[:32], "-")
	}
	sum := sha256.Sum256([]byte(raw))
	return base + "-" + hex.EncodeToString(sum[:4])
}

func handleID(handle ports.RuntimeHandle) (string, error) {
	id := handle.ID
	if id == "" {
		return "", errors.New("tmux runtime: session id is required")
	}
	if !sessionIDPattern.MatchString(id) {
		return "", fmt.Errorf("tmux runtime: invalid handle id %q", id)
	}
	return id, nil
}

// -- output detection helpers --

// sessionMissingOutput reports whether a non-zero `tmux has-session` or
// `tmux kill-session` exit is definitively "session does not exist" rather
// than a transient probe failure.
func sessionMissingOutput(out string) bool {
	s := strings.ToLower(out)
	return strings.Contains(s, "can't find session") ||
		strings.Contains(s, "no server running") ||
		strings.Contains(s, "error connecting") ||
		strings.Contains(s, "session not found")
}

// killSessionMissingOutput reports whether a non-zero `tmux kill-session`
// failed because the session was already gone.
func killSessionMissingOutput(out string) bool {
	return sessionMissingOutput(out)
}

// -- text helpers --

func chunks(s string, maxBytes int) []string {
	if s == "" {
		return []string{""}
	}
	if maxBytes <= 0 || len(s) <= maxBytes {
		return []string{s}
	}
	parts := []string{}
	for s != "" {
		if len(s) <= maxBytes {
			parts = append(parts, s)
			break
		}
		end := maxBytes
		for end > 0 && !utf8.ValidString(s[:end]) {
			end--
		}
		if end == 0 {
			_, size := utf8.DecodeRuneInString(s)
			end = size
		}
		parts = append(parts, s[:end])
		s = s[end:]
	}
	return parts
}

func tailLines(s string, n int) string {
	if n <= 0 || s == "" {
		return ""
	}
	lines := strings.SplitAfter(s, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) <= n {
		return s
	}
	return strings.Join(lines[len(lines)-n:], "")
}

func trimTrailingBlankLines(s string) string {
	if s == "" {
		return ""
	}
	lines := strings.SplitAfter(s, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	for len(lines) > 0 && strings.TrimRight(lines[len(lines)-1], "\r\n") == "" {
		lines = lines[:len(lines)-1]
	}
	return strings.Join(lines, "")
}

// -- env / quoting helpers --

func validateEnvKeys(env map[string]string) error {
	for key := range env {
		if !validEnvKey(key) {
			return fmt.Errorf("tmux runtime: invalid env key %q", key)
		}
	}
	return nil
}

func validEnvKey(key string) bool {
	if key == "" {
		return false
	}
	for i, r := range key {
		if r == '_' || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') {
			continue
		}
		if i > 0 && r >= '0' && r <= '9' {
			continue
		}
		return false
	}
	return true
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

// buildLaunchCommand builds the shell command string passed to `sh -c`. It
// exports env vars, then runs argv, then execs a keep-alive interactive shell
// so the tmux session survives the agent exiting.
//
// PATH from cfg.Env is exported last, after all other keys, so an explicit
// override takes effect.
func buildLaunchCommand(cfg ports.RuntimeConfig) string {
	path := cfg.Env["PATH"]
	if path == "" {
		path = getenv("PATH")
	}

	var b strings.Builder
	for _, key := range sortedKeys(cfg.Env) {
		if key == "PATH" {
			continue
		}
		b.WriteString("export ")
		b.WriteString(key)
		b.WriteString("=")
		b.WriteString(shellQuote(cfg.Env[key]))
		b.WriteString("; ")
	}
	if path != "" {
		b.WriteString("export PATH=")
		b.WriteString(shellQuote(path))
		b.WriteString("; ")
	}
	// Quote each argv word so spaces inside a word are preserved.
	parts := make([]string, len(cfg.Argv))
	for i, a := range cfg.Argv {
		parts[i] = shellQuote(a)
	}
	b.WriteString(strings.Join(parts, " "))
	// Keep the tmux session alive after the agent exits so the operator can
	// inspect the terminal. The shell variable expansion picks up $SHELL from
	// the process env if set, otherwise falls back to /bin/sh.
	b.WriteString(`; exec "${SHELL:-/bin/sh}" -i`)
	return b.String()
}

// -- error type --

type commandError struct {
	err    error
	output string
}

func (e commandError) Error() string {
	if e.output == "" {
		return e.err.Error()
	}
	return e.err.Error() + ": " + e.output
}

func (e commandError) Unwrap() error { return e.err }
