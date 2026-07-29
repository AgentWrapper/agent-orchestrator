package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/runfile"
)

// Owner tags accepted by --owner and stamped as AO_OWNER on the spawned
// daemon's environment (see internal/httpd/server.go's runfile.Info.Owner,
// and internal/runfile.Info's doc comment for what each tag means).
const (
	ownerApp        = "app"
	ownerPersistent = "persistent"
)

const (
	// defaultEnsureTimeout bounds the whole ensure operation (attach probe,
	// optional takeover grace period, and spawn-then-poll), mirroring the
	// Electron supervisor's 30s attach/spawn budget.
	defaultEnsureTimeout = 30 * time.Second
	// ensurePollInterval is how often running.json/health is re-checked while
	// waiting for a freshly spawned daemon to come up.
	ensurePollInterval = 300 * time.Millisecond
	// wedgedKillGrace is how long `ensure` waits after SIGTERM-ing a wedged
	// holder before escalating to SIGKILL.
	wedgedKillGrace = 3 * time.Second
	// wedgedKillPollInterval is how often liveness is re-checked during the
	// SIGTERM grace period.
	wedgedKillPollInterval = 100 * time.Millisecond
)

type ensureOptions struct {
	owner   string
	json    bool
	timeout time.Duration
}

// ensureResult is the single JSON line `ao daemon ensure --json` prints on
// success.
type ensureResult struct {
	Port int    `json:"port"`
	PID  int    `json:"pid"`
	Mode string `json:"mode"`
}

// ensureAction is the pure decision derived from an inspectDaemon snapshot.
type ensureAction string

const (
	// ensureActionAttach means a healthy daemon already owns the recorded
	// port; use it as-is.
	ensureActionAttach ensureAction = "attached"
	// ensureActionSpawn means nothing usable is running (no run-file, or one
	// naming a dead process); start a fresh daemon.
	ensureActionSpawn ensureAction = "spawned"
	// ensureActionTakeover means a process is alive at the recorded PID but is
	// not answering /healthz or /readyz correctly (a wedged orphan); kill it
	// before spawning a replacement so the child does not collide on the port.
	ensureActionTakeover ensureAction = "takeover"
)

// decideEnsureAction maps an inspectDaemon snapshot to the action `ao daemon
// ensure` should take. Kept side-effect free so it can be table-tested without
// spawning real processes.
func decideEnsureAction(st daemonStatus) ensureAction {
	switch st.State {
	case stateReady:
		return ensureActionAttach
	case stateUnhealthy, stateNotReady:
		return ensureActionTakeover
	default: // stateStopped, stateStale
		return ensureActionSpawn
	}
}

func newDaemonEnsureCommand(ctx *commandContext) *cobra.Command {
	opts := ensureOptions{owner: ownerApp, timeout: defaultEnsureTimeout}
	cmd := &cobra.Command{
		Use:   "ensure",
		Short: "Attach to, spawn, or take over the local AO daemon",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if opts.owner != ownerApp && opts.owner != ownerPersistent {
				return usageError{fmt.Errorf("--owner must be %q or %q, got %q", ownerApp, ownerPersistent, opts.owner)}
			}
			res, err := ctx.ensureDaemon(cmd.Context(), opts)
			if err != nil {
				return err
			}
			if opts.json {
				return writeJSONLine(cmd.OutOrStdout(), res)
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "AO daemon %s: pid=%d port=%d\n", res.Mode, res.PID, res.Port)
			return err
		},
	}
	cmd.Flags().StringVar(&opts.owner, "owner", ownerApp, "Daemon ownership tag written to running.json (app|persistent)")
	cmd.Flags().BoolVar(&opts.json, "json", false, "Output the ensure result as a single JSON line")
	cmd.Flags().DurationVar(&opts.timeout, "timeout", defaultEnsureTimeout, "How long to wait for the daemon to become ready")
	return cmd
}

// writeJSONLine prints v as one compact JSON line, unlike writeJSON's indented
// multi-line envelope — `ao daemon ensure --json` is meant to be parsed by a
// supervisor reading a single line of stdout.
func writeJSONLine(w io.Writer, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(w, string(data))
	return err
}

// ensureDaemon implements attach-or-spawn-or-takeover: it inspects the
// recorded daemon, decides an action, and returns the resulting port/pid/mode.
func (c *commandContext) ensureDaemon(ctx context.Context, opts ensureOptions) (ensureResult, error) {
	cfg, err := config.Load()
	if err != nil {
		return ensureResult{}, err
	}

	timeout := opts.timeout
	if timeout <= 0 {
		timeout = defaultEnsureTimeout
	}
	deadline := c.deps.Now().Add(timeout)

	st, err := c.inspectDaemon(ctx)
	if err != nil {
		return ensureResult{}, err
	}

	switch decideEnsureAction(st) {
	case ensureActionAttach:
		return ensureResult{Port: st.Port, PID: st.PID, Mode: string(ensureActionAttach)}, nil

	case ensureActionTakeover:
		if err := c.takeoverWedgedDaemon(ctx, st.PID, deadline); err != nil {
			return ensureResult{}, err
		}
		if err := runfile.RemoveIfOwned(cfg.RunFilePath, st.PID); err != nil {
			return ensureResult{}, err
		}
		return c.spawnAndWait(ctx, opts, string(ensureActionTakeover), deadline)

	default: // ensureActionSpawn
		if st.State == stateStale {
			if err := runfile.RemoveIfOwned(cfg.RunFilePath, st.PID); err != nil {
				return ensureResult{}, err
			}
		}
		return c.spawnAndWait(ctx, opts, string(ensureActionSpawn), deadline)
	}
}

// takeoverWedgedDaemon kills a live-but-unresponsive holder of the daemon
// port: SIGTERM first, then SIGKILL after wedgedKillGrace if it is still
// alive. It never waits past deadline.
func (c *commandContext) takeoverWedgedDaemon(ctx context.Context, pid int, deadline time.Time) error {
	if pid <= 0 {
		return nil
	}
	_ = c.deps.TerminateProcessGroup(pid)

	graceDeadline := c.deps.Now().Add(wedgedKillGrace)
	if graceDeadline.After(deadline) {
		graceDeadline = deadline
	}
	for c.deps.ProcessAlive(pid) && c.deps.Now().Before(graceDeadline) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		c.deps.Sleep(wedgedKillPollInterval)
	}

	if c.deps.ProcessAlive(pid) {
		_ = c.deps.KillProcessGroup(pid)
	}
	return nil
}

// spawnAndWait execs a detached `ao daemon` (inheriting this process's
// environment, so AO_PORT/AO_RUN_FILE/AO_DATA_DIR flow through unchanged, plus
// AO_OWNER stamped from --owner) and polls running.json/health until it
// reports ready or deadline passes.
func (c *commandContext) spawnAndWait(ctx context.Context, opts ensureOptions, mode string, deadline time.Time) (ensureResult, error) {
	timeout := opts.timeout
	if timeout <= 0 {
		timeout = defaultEnsureTimeout
	}
	exe, err := c.deps.Executable()
	if err != nil {
		return ensureResult{}, fmt.Errorf("resolve ao executable: %w", err)
	}

	env := append(os.Environ(), "AO_OWNER="+opts.owner)
	if err := c.deps.StartProcess(processStartConfig{Path: exe, Args: []string{"daemon"}, Env: env}); err != nil {
		return ensureResult{}, fmt.Errorf("spawn daemon: %w", err)
	}

	for {
		select {
		case <-ctx.Done():
			return ensureResult{}, ctx.Err()
		default:
		}

		st, err := c.inspectDaemon(ctx)
		if err != nil {
			return ensureResult{}, err
		}
		if st.State == stateReady {
			return ensureResult{Port: st.Port, PID: st.PID, Mode: mode}, nil
		}
		if !c.deps.Now().Before(deadline) {
			return ensureResult{}, fmt.Errorf("daemon did not become ready within %s", timeout)
		}
		c.deps.Sleep(ensurePollInterval)
	}
}
