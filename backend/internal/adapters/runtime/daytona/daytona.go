// Package daytona implements AO's runtime and workspace ports against
// Daytona (daytona.io) cloud sandboxes: one sandbox per session, running the
// same tmux semantics the local tmux adapter provides, driven through
// Daytona's toolbox exec API. Terminal attach streams over Daytona's PTY
// WebSocket — outbound connections only, no inbound port on the sandbox.
// Design doc: docs/cloud/daytona-runtime.md.
package daytona

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	// LabelSession is the sandbox label carrying the AO runtime handle id. The
	// adapter finds a session's sandbox by this label instead of an in-memory
	// map, so a daemon restart re-adopts cloud sessions the same way boot
	// reconcile re-adopts tmux ones.
	LabelSession = "ao/session"
	// LabelProject carries the AO project id for operator-facing inventory.
	LabelProject = "ao/project"

	defaultExecTimeout   = 30 * time.Second
	defaultChunkBytes    = 16 * 1024
	defaultEnterDelay    = 300 * time.Millisecond
	defaultStartTimeout  = 2 * time.Minute
	defaultCreateTimeout = 5 * time.Minute
	statePollInterval    = 2 * time.Second
	resizeTimeout        = 10 * time.Second
)

// Options configures the Daytona Runtime (and are shared by the Workspace
// adapter, which is built from the same values via NewWorkspace).
type Options struct {
	// Client talks to Daytona. Required (build one with NewClient).
	Client Client
	// ExecTimeout bounds one toolbox exec round-trip; default 30s (network,
	// unlike the tmux adapter's local 5s).
	ExecTimeout time.Duration
	// ChunkSize bounds one send-keys literal chunk; default 16 KiB.
	ChunkSize int
	// EnterDelay is the pause between pasting a non-empty message and the
	// trailing Enter (issue #2342); default 300ms.
	EnterDelay time.Duration
	// StartTimeout bounds waiting for a sandbox to reach started when waking a
	// stopped/archived one; default 2m.
	StartTimeout time.Duration
}

func (o Options) withDefaults() Options {
	if o.ExecTimeout <= 0 {
		o.ExecTimeout = defaultExecTimeout
	}
	if o.ChunkSize <= 0 {
		o.ChunkSize = defaultChunkBytes
	}
	if o.EnterDelay <= 0 {
		o.EnterDelay = defaultEnterDelay
	}
	if o.StartTimeout <= 0 {
		o.StartTimeout = defaultStartTimeout
	}
	return o
}

// core holds the client plus the sandbox lookup/wake/exec helpers shared by
// the Runtime and Workspace adapters (both drive the same per-session
// sandbox).
type core struct {
	client       Client
	execTimeout  time.Duration
	startTimeout time.Duration
}

// Runtime runs agent sessions inside tmux within a per-session Daytona
// sandbox. It implements ports.Runtime plus the optional capabilities the
// daemon wires (Attacher, RuntimeRestarter, SupervisedProcessInspector) and
// the runtimeselect union methods (SendMessage, Interrupt, GetOutput).
type Runtime struct {
	core
	chunkSize  int
	enterDelay time.Duration
}

var (
	_ ports.Runtime                    = (*Runtime)(nil)
	_ ports.Attacher                   = (*Runtime)(nil)
	_ ports.RuntimeRestarter           = (*Runtime)(nil)
	_ ports.SupervisedProcessInspector = (*Runtime)(nil)
)

// New builds a Daytona Runtime. Options.Client is required.
func New(opts Options) (*Runtime, error) {
	if opts.Client == nil {
		return nil, errors.New("daytona runtime: client is required")
	}
	opts = opts.withDefaults()
	return &Runtime{
		core: core{
			client:       opts.Client,
			execTimeout:  opts.ExecTimeout,
			startTimeout: opts.StartTimeout,
		},
		chunkSize:  opts.ChunkSize,
		enterDelay: opts.EnterDelay,
	}, nil
}

// sandboxForHandle finds the session's sandbox by label. found=false with a
// nil error is definitive "no sandbox" (deleted); an error is an inconclusive
// probe failure.
func (r *core) sandboxForHandle(ctx context.Context, id string) (Sandbox, bool, error) {
	list, err := r.client.ListSandboxes(ctx, map[string]string{LabelSession: id})
	if err != nil {
		return Sandbox{}, false, fmt.Errorf("daytona runtime: list sandboxes for %s: %w", id, err)
	}
	for _, sb := range list {
		if sb.State != StateDestroyed && sb.State != StateDestroying {
			return sb, true, nil
		}
	}
	return Sandbox{}, false, nil
}

// ensureStarted wakes a stopped/archived sandbox and waits for started.
// Already-running sandboxes return immediately.
//
// A transitional state settles FIRST, then the steady state is acted on. This
// ordering is load-bearing (caught live): the list endpoint lags GetSandbox,
// so a freshly-parked sandbox can still read `stopping` here — waiting for
// `started` on that would spin until timeout without ever issuing the start,
// because stopping settles into stopped.
func (r *core) ensureStarted(ctx context.Context, sb Sandbox) (Sandbox, error) {
	if sb.State.Transitional() {
		var err error
		if sb, err = r.waitForSettled(ctx, sb.ID, r.startTimeout); err != nil {
			return sb, err
		}
	}
	switch sb.State {
	case StateStarted:
		return sb, nil
	case StateStopped, StateArchived:
		if err := r.client.StartSandbox(ctx, sb.ID); err != nil {
			return sb, fmt.Errorf("daytona runtime: start sandbox %s: %w", sb.ID, err)
		}
		// Tolerate still seeing the pre-start steady state: Daytona applies
		// state transitions asynchronously, so the first polls after
		// StartSandbox can still report stopped/archived.
		return r.waitForState(ctx, sb.ID, StateStarted, r.startTimeout, StateStopped, StateArchived)
	case StateError, StateBuildFailed:
		return sb, fmt.Errorf("daytona runtime: sandbox %s is in state %s: %s", sb.ID, sb.State, sb.ErrorReason)
	default:
		return sb, fmt.Errorf("daytona runtime: sandbox %s cannot be started from state %s", sb.ID, sb.State)
	}
}

// deleteAndWait deletes a sandbox and waits until Daytona stops reporting it
// (deletion is async: the API 200s while the sandbox is still listed). AO's
// teardown paths treat a returned destroy as "gone", so the adapter owns the
// wait rather than every caller re-discovering the lag.
func (r *core) deleteAndWait(ctx context.Context, sandboxID string) error {
	if err := r.client.DeleteSandbox(ctx, sandboxID); err != nil {
		if errors.Is(err, ErrSandboxNotFound) {
			return nil
		}
		return err
	}
	deadline := time.Now().Add(r.startTimeout)
	for {
		sb, err := r.client.GetSandbox(ctx, sandboxID)
		switch {
		case errors.Is(err, ErrSandboxNotFound):
			return nil
		case err != nil:
			return fmt.Errorf("daytona: confirm delete of sandbox %s: %w", sandboxID, err)
		case sb.State == StateDestroyed:
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("daytona: sandbox %s still %s after delete", sandboxID, sb.State)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(statePollInterval):
		}
	}
}

// waitForSettled polls until the sandbox leaves every transitional state,
// whatever it settles into.
func (r *core) waitForSettled(ctx context.Context, sandboxID string, timeout time.Duration) (Sandbox, error) {
	deadline := time.Now().Add(timeout)
	for {
		sb, err := r.client.GetSandbox(ctx, sandboxID)
		if err != nil {
			return Sandbox{}, fmt.Errorf("daytona runtime: poll sandbox %s: %w", sandboxID, err)
		}
		if !sb.State.Transitional() {
			return sb, nil
		}
		if time.Now().After(deadline) {
			return sb, fmt.Errorf("daytona runtime: sandbox %s stuck in transitional state %s after %s", sandboxID, sb.State, timeout)
		}
		select {
		case <-ctx.Done():
			return sb, ctx.Err()
		case <-time.After(statePollInterval):
		}
	}
}

// waitForState polls until the sandbox reaches want, a terminal error state,
// or the timeout elapses. States listed in tolerate are treated like
// transitional ones — kept polling through — for the window where an async
// state change was requested but the sandbox still reports its origin state.
func (r *core) waitForState(ctx context.Context, sandboxID string, want SandboxState, timeout time.Duration, tolerate ...SandboxState) (Sandbox, error) {
	tolerated := func(s SandboxState) bool {
		for _, t := range tolerate {
			if s == t {
				return true
			}
		}
		return false
	}
	deadline := time.Now().Add(timeout)
	for {
		sb, err := r.client.GetSandbox(ctx, sandboxID)
		if err != nil {
			return Sandbox{}, fmt.Errorf("daytona runtime: poll sandbox %s: %w", sandboxID, err)
		}
		switch {
		case sb.State == want:
			return sb, nil
		case sb.State == StateError || sb.State == StateBuildFailed:
			return sb, fmt.Errorf("daytona runtime: sandbox %s entered state %s: %s", sandboxID, sb.State, sb.ErrorReason)
		case !sb.State.Transitional() && !tolerated(sb.State):
			return sb, fmt.Errorf("daytona runtime: sandbox %s settled in state %s, want %s", sandboxID, sb.State, want)
		}
		if time.Now().After(deadline) {
			return sb, fmt.Errorf("daytona runtime: sandbox %s did not reach %s within %s (state %s)", sandboxID, want, timeout, sb.State)
		}
		select {
		case <-ctx.Done():
			return sb, ctx.Err()
		case <-time.After(statePollInterval):
		}
	}
}

// exec runs one shell command in the sandbox with the adapter's timeout.
// A non-zero exit is returned as (result, execError) so callers can inspect
// output; transport failures come back unwrapped from the client.
func (r *core) exec(ctx context.Context, sandboxID, command string) (ExecResult, error) {
	return r.execWithTimeout(ctx, sandboxID, command, r.execTimeout)
}

func (r *core) execWithTimeout(ctx context.Context, sandboxID, command string, timeout time.Duration) (ExecResult, error) {
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	res, err := r.client.Exec(execCtx, sandboxID, ExecRequest{
		Command:        command,
		TimeoutSeconds: int(timeout / time.Second),
	})
	if err != nil {
		return ExecResult{}, err
	}
	if res.ExitCode != 0 {
		return res, &execError{command: command, exitCode: res.ExitCode, output: res.Result}
	}
	return res, nil
}

// execError is a command that ran in the sandbox and exited non-zero — a
// definitive command failure, distinct from transport errors.
type execError struct {
	command  string
	exitCode int
	output   string
}

func (e *execError) Error() string {
	out := strings.TrimSpace(e.output)
	if len(out) > 512 {
		out = out[:512] + "…"
	}
	return fmt.Sprintf("command exited %d: %s", e.exitCode, out)
}

// Create launches the agent inside the session's sandbox: the sandbox must
// already exist (Workspace.Create provisions it); Create wakes it if parked,
// then starts a tmux session running the launch command with the caller's env
// exported — including the control-plane-injected agent credentials.
func (r *Runtime) Create(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	id, err := sessionName(cfg.SessionID)
	if err != nil {
		return ports.RuntimeHandle{}, err
	}
	if cfg.WorkspacePath == "" {
		return ports.RuntimeHandle{}, errors.New("daytona runtime: workspace path is required")
	}
	if len(cfg.Argv) == 0 {
		return ports.RuntimeHandle{}, errors.New("daytona runtime: launch command is required")
	}
	if err := validateEnvKeys(cfg.Env); err != nil {
		return ports.RuntimeHandle{}, err
	}
	sb, found, err := r.sandboxForHandle(ctx, id)
	if err != nil {
		return ports.RuntimeHandle{}, err
	}
	if !found {
		return ports.RuntimeHandle{}, fmt.Errorf("daytona runtime: no sandbox for session %s (workspace not provisioned?)", id)
	}
	sb, err = r.ensureStarted(ctx, sb)
	if err != nil {
		return ports.RuntimeHandle{}, err
	}

	launchCmd := buildLaunchCommand(cfg)
	if _, err := r.exec(ctx, sb.ID, newSessionCommand(id, cfg.WorkspacePath, launchCmd)); err != nil {
		return ports.RuntimeHandle{}, fmt.Errorf("daytona runtime: create session %s: %w", id, err)
	}

	handle := ports.RuntimeHandle{ID: id}
	alive, err := r.IsAlive(ctx, handle)
	if err != nil {
		_ = r.Destroy(context.WithoutCancel(ctx), handle)
		return ports.RuntimeHandle{}, fmt.Errorf("daytona runtime: verify session %s: %w", id, err)
	}
	if !alive {
		_ = r.Destroy(context.WithoutCancel(ctx), handle)
		return ports.RuntimeHandle{}, fmt.Errorf("daytona runtime: session %s exited before ready", id)
	}
	return handle, nil
}

// Restart replaces the agent process inside the existing sandbox tmux session,
// preserving the terminal identity. It also transparently wakes a parked
// sandbox: when the stop killed tmux, the session is recreated instead of
// respawned — same handle either way.
func (r *Runtime) Restart(ctx context.Context, handle ports.RuntimeHandle, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	id, err := handleID(handle)
	if err != nil {
		return ports.RuntimeHandle{}, err
	}
	expected, err := sessionName(cfg.SessionID)
	if err != nil {
		return ports.RuntimeHandle{}, err
	}
	if expected != id {
		return ports.RuntimeHandle{}, fmt.Errorf("daytona runtime: restart handle %s does not match session %s", id, cfg.SessionID)
	}
	if cfg.WorkspacePath == "" {
		return ports.RuntimeHandle{}, errors.New("daytona runtime: workspace path is required")
	}
	if len(cfg.Argv) == 0 {
		return ports.RuntimeHandle{}, errors.New("daytona runtime: launch command is required")
	}
	if err := validateEnvKeys(cfg.Env); err != nil {
		return ports.RuntimeHandle{}, err
	}
	sb, found, err := r.sandboxForHandle(ctx, id)
	if err != nil {
		return ports.RuntimeHandle{}, err
	}
	if !found {
		return ports.RuntimeHandle{}, fmt.Errorf("daytona runtime: no sandbox for session %s", id)
	}
	sb, err = r.ensureStarted(ctx, sb)
	if err != nil {
		return ports.RuntimeHandle{}, err
	}

	launchCmd := buildLaunchCommand(cfg)
	if _, err := r.exec(ctx, sb.ID, respawnPaneCommand(id, cfg.WorkspacePath, launchCmd)); err != nil {
		var execErr *execError
		if !errors.As(err, &execErr) {
			return ports.RuntimeHandle{}, fmt.Errorf("daytona runtime: restart session %s: %w", id, err)
		}
		// The tmux session died with a sandbox stop; recreate it in place.
		if _, err := r.exec(ctx, sb.ID, newSessionCommand(id, cfg.WorkspacePath, launchCmd)); err != nil {
			return ports.RuntimeHandle{}, fmt.Errorf("daytona runtime: restart session %s: %w", id, err)
		}
	}
	alive, err := r.IsAlive(ctx, handle)
	if err != nil {
		return ports.RuntimeHandle{}, fmt.Errorf("daytona runtime: verify restarted session %s: %w", id, err)
	}
	if !alive {
		return ports.RuntimeHandle{}, fmt.Errorf("daytona runtime: session %s exited during restart", id)
	}
	return handle, nil
}

// Destroy kills the sandbox's tmux session. The sandbox itself is torn down by
// Workspace.Destroy (it holds the checkout); a missing sandbox or an
// already-gone tmux session is success (idempotent double-kill). A parked
// (stopped) sandbox has no processes to kill, so it is also success.
func (r *Runtime) Destroy(ctx context.Context, handle ports.RuntimeHandle) error {
	id, err := handleID(handle)
	if err != nil {
		return err
	}
	sb, found, err := r.sandboxForHandle(ctx, id)
	if err != nil {
		return err
	}
	if !found || sb.State != StateStarted {
		return nil
	}
	if _, err := r.exec(ctx, sb.ID, killSessionCommand(id)); err != nil {
		var execErr *execError
		if errors.As(err, &execErr) && sessionMissingOutput(execErr.output) {
			return nil
		}
		return fmt.Errorf("daytona runtime: destroy session %s: %w", id, err)
	}
	return nil
}

// IsAlive reports whether the session's terminal still exists. A parked
// (stopped/archived) sandbox reports alive: the terminal identity is
// restorable in place via Restart, and reporting dead would let the reaper
// terminate every idle-parked cloud session. The agent-process question is
// separate (IsSupervisedProcessAlive), matching issue #2802's split. Probe
// failures return an error, never proof of death.
func (r *Runtime) IsAlive(ctx context.Context, handle ports.RuntimeHandle) (bool, error) {
	id, err := handleID(handle)
	if err != nil {
		return false, err
	}
	sb, found, err := r.sandboxForHandle(ctx, id)
	if err != nil {
		return false, err
	}
	if !found {
		return false, nil
	}
	switch sb.State {
	case StateStopped, StateArchived, StateStopping, StateArchiving:
		return true, nil // parked: fs (and terminal identity) preserved
	case StateError, StateBuildFailed:
		return false, nil
	case StateStarted:
		// fall through to the tmux probe
	default:
		if sb.State.Transitional() {
			return true, nil
		}
		return false, nil
	}
	if _, err := r.exec(ctx, sb.ID, hasSessionCommand(id)); err != nil {
		// Only output that definitively says "session/server missing" is proof
		// of death; any other failure (tmux absent, shell OOM, transport) is an
		// inconclusive probe so the reaper never kills on a transient error.
		var execErr *execError
		if errors.As(err, &execErr) && sessionMissingOutput(execErr.output) {
			return false, nil
		}
		// A sandbox observed `started` can be mid-stop by the time the exec
		// lands (Daytona stop is async; the toolbox proxy 502s during it —
		// seen live). Re-read the state: if it left `started`, answer from the
		// fresh state instead of surfacing a probe error for a healthy park.
		if fresh, freshErr := r.client.GetSandbox(ctx, sb.ID); freshErr == nil && fresh.State != StateStarted {
			switch fresh.State {
			case StateStopped, StateArchived, StateStopping, StateArchiving:
				return true, nil // parked mid-probe
			case StateError, StateBuildFailed, StateDestroyed, StateDestroying:
				return false, nil
			default:
				if fresh.State.Transitional() {
					return true, nil
				}
			}
		}
		return false, fmt.Errorf("daytona runtime: probe session %s: %w", id, err)
	}
	return true, nil
}

// IsSupervisedProcessAlive reports whether the managed agent workload for ref
// is still running inside the sandbox, using the same pane-descendant walk as
// the tmux adapter (issue #2802: pane-exists != agent-alive). A parked sandbox
// reports false with no error — Daytona stop killed the processes, which is
// exactly the "agent exited, session restorable" state.
func (r *Runtime) IsSupervisedProcessAlive(ctx context.Context, handle ports.RuntimeHandle, ref ports.SupervisedProcessRef) (bool, error) {
	id, err := handleID(handle)
	if err != nil {
		return false, err
	}
	sb, found, err := r.sandboxForHandle(ctx, id)
	if err != nil {
		return false, err
	}
	if !found {
		return false, nil
	}
	if sb.State == StateStopped || sb.State == StateArchived {
		return false, nil
	}
	if sb.State != StateStarted {
		return false, fmt.Errorf("daytona runtime: sandbox %s in transitional state %s", sb.ID, sb.State)
	}
	paneOut, err := r.exec(ctx, sb.ID, panePIDCommand(id))
	if err != nil {
		return false, fmt.Errorf("daytona runtime: inspect pane pid %s: %w", id, err)
	}
	panePID, err := strconv.Atoi(strings.TrimSpace(paneOut.Result))
	if err != nil || panePID <= 0 {
		return false, fmt.Errorf("daytona runtime: invalid pane pid %q", strings.TrimSpace(paneOut.Result))
	}
	tableOut, err := r.exec(ctx, sb.ID, processTableCommand())
	if err != nil {
		return false, fmt.Errorf("daytona runtime: inspect process tree %s: %w", id, err)
	}
	entries, err := parseProcessTable(tableOut.Result)
	if err != nil {
		return false, fmt.Errorf("daytona runtime: parse process tree %s: %w", id, err)
	}
	return containsManagedWorkload(entries, panePID, string(ref.SessionID), ref.LaunchID), nil
}

// SendMessage sends literal text to the session then presses Enter to submit;
// an empty message presses Enter alone (the ports.AgentMessenger nudge
// contract). Chunking and the pre-Enter delay mirror the tmux adapter
// (issue #2342).
func (r *Runtime) SendMessage(ctx context.Context, handle ports.RuntimeHandle, message string) error {
	id, err := handleID(handle)
	if err != nil {
		return err
	}
	sb, found, err := r.sandboxForHandle(ctx, id)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("daytona runtime: no sandbox for session %s", id)
	}
	enterCtx := ctx
	if message != "" {
		for _, chunk := range chunks(message, r.chunkSize) {
			if _, err := r.exec(ctx, sb.ID, sendKeysLiteralCommand(id, chunk)); err != nil {
				return fmt.Errorf("daytona runtime: send message %s: %w", id, err)
			}
		}
		// The chunks are already in the pane: detach the pause + Enter from the
		// caller's cancellation so an abandoned send can't strand an
		// unsubmitted draft (see tmux adapter).
		var cancel context.CancelFunc
		enterCtx, cancel = context.WithTimeout(context.WithoutCancel(ctx), r.enterDelay+r.execTimeout)
		defer cancel()
		if r.enterDelay > 0 {
			select {
			case <-enterCtx.Done():
				return enterCtx.Err()
			case <-time.After(r.enterDelay):
			}
		}
	}
	if _, err := r.exec(enterCtx, sb.ID, sendEnterCommand(id)); err != nil {
		return fmt.Errorf("daytona runtime: send enter %s: %w", id, err)
	}
	return nil
}

// Interrupt sends Ctrl-C to the foreground process without destroying the
// terminal session.
func (r *Runtime) Interrupt(ctx context.Context, handle ports.RuntimeHandle) error {
	id, err := handleID(handle)
	if err != nil {
		return err
	}
	sb, found, err := r.sandboxForHandle(ctx, id)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("daytona runtime: no sandbox for session %s", id)
	}
	if _, err := r.exec(ctx, sb.ID, sendInterruptCommand(id)); err != nil {
		return fmt.Errorf("daytona runtime: interrupt session %s: %w", id, err)
	}
	return nil
}

// GetOutput returns the last `lines` lines of the session's terminal
// scrollback via capture-pane. A parked sandbox has no tmux server, so its
// scrollback is unavailable until the session is restarted.
func (r *Runtime) GetOutput(ctx context.Context, handle ports.RuntimeHandle, lines int) (string, error) {
	id, err := handleID(handle)
	if err != nil {
		return "", err
	}
	if lines <= 0 {
		return "", errors.New("daytona runtime: lines must be positive")
	}
	sb, found, err := r.sandboxForHandle(ctx, id)
	if err != nil {
		return "", err
	}
	if !found {
		return "", fmt.Errorf("daytona runtime: no sandbox for session %s", id)
	}
	if sb.State != StateStarted {
		return "", fmt.Errorf("daytona runtime: sandbox for session %s is %s; scrollback unavailable while parked", id, sb.State)
	}
	out, err := r.exec(ctx, sb.ID, capturePaneCommand(id, lines))
	if err != nil {
		return "", fmt.Errorf("daytona runtime: capture output %s: %w", id, err)
	}
	return tailLines(trimTrailingBlankLines(out.Result), lines), nil
}
