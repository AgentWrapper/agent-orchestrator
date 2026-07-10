package cli

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/runfile"
)

const defaultStopTimeout = 10 * time.Second

type stopOptions struct {
	timeout time.Duration
	json    bool
}

func newStopCommand(ctx *commandContext) *cobra.Command {
	opts := stopOptions{timeout: defaultStopTimeout}
	cmd := &cobra.Command{
		Use:   "stop",
		Short: "Stop the AO daemon",
		Args:  noArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			st, err := ctx.stopDaemon(cmd.Context(), opts)
			if err != nil {
				return err
			}
			if opts.json {
				return writeJSON(cmd.OutOrStdout(), st)
			}
			if st.State == stateStopped {
				_, err = fmt.Fprintln(cmd.OutOrStdout(), "AO daemon stopped")
				return err
			}
			return writeStatus(cmd, st)
		},
	}
	cmd.Flags().DurationVar(&opts.timeout, "timeout", defaultStopTimeout, "How long to wait for daemon shutdown")
	cmd.Flags().BoolVar(&opts.json, "json", false, "Output stop result as JSON")
	return cmd
}

func (c *commandContext) stopDaemon(ctx context.Context, opts stopOptions) (daemonStatus, error) {
	cfg, err := config.Load()
	if err != nil {
		return daemonStatus{}, err
	}
	st, err := c.inspectDaemon(ctx)
	if err != nil {
		return daemonStatus{}, err
	}
	switch st.State {
	case stateStopped:
		return st, nil
	case stateStale:
		if err := runfile.Remove(cfg.RunFilePath); err != nil {
			return daemonStatus{}, err
		}
		return daemonStatus{State: stateStopped, RunFile: cfg.RunFilePath, DataDir: cfg.DataDir}, nil
	}
	if !st.owned {
		if st.Error != "" {
			return daemonStatus{}, fmt.Errorf("daemon pid %d is alive but ownership could not be verified: %s", st.PID, st.Error)
		}
		return daemonStatus{}, fmt.Errorf("daemon pid %d is alive but ownership could not be verified", st.PID)
	}

	stoppedBySystemd, err := c.stopSystemdDaemon(ctx, st.PID, opts.timeout)
	if err != nil {
		return daemonStatus{}, err
	}
	if !stoppedBySystemd {
		if err := c.requestShutdown(ctx, st.Port, st.shutdownToken); err != nil {
			return daemonStatus{}, fmt.Errorf("request daemon shutdown: %w", err)
		}
	}
	return c.waitForStopped(ctx, st.PID, cfg.RunFilePath, cfg.DataDir, opts.timeout)
}

func (c *commandContext) stopSystemdDaemon(ctx context.Context, pid int, timeout time.Duration) (bool, error) {
	systemctl, err := c.deps.LookPath("systemctl")
	if err != nil {
		return false, nil
	}

	checkCtx, cancelCheck := context.WithTimeout(ctx, probeTimeout)
	defer cancelCheck()
	if _, err := c.deps.CommandOutput(checkCtx, systemctl, "--user", "is-active", "--quiet", "ao.service"); err != nil {
		return false, nil
	}
	out, err := c.deps.CommandOutput(checkCtx, systemctl, "--user", "show", "ao.service", "-P", "MainPID")
	if err != nil {
		return false, nil
	}
	mainPID, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || mainPID != pid {
		return false, nil
	}

	if timeout <= 0 {
		timeout = defaultStopTimeout
	}
	stopCtx, cancelStop := context.WithTimeout(ctx, timeout)
	defer cancelStop()
	if _, err := c.deps.CommandOutput(stopCtx, systemctl, "--user", "stop", "ao.service"); err != nil {
		return true, fmt.Errorf("stop ao.service: %w", err)
	}
	return true, nil
}

func (c *commandContext) requestShutdown(ctx context.Context, port int, shutdownToken string) error {
	reqCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, fmt.Sprintf("http://%s:%d/shutdown", config.LoopbackHost, port), http.NoBody)
	if err != nil {
		return err
	}
	if shutdownToken != "" {
		req.Header.Set(runfile.ShutdownTokenHeader, shutdownToken)
	}
	resp, err := c.deps.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

func (c *commandContext) waitForStopped(ctx context.Context, pid int, runFilePath, dataDir string, timeout time.Duration) (daemonStatus, error) {
	if timeout <= 0 {
		timeout = defaultStopTimeout
	}
	deadline := c.deps.Now().Add(timeout)
	for {
		select {
		case <-ctx.Done():
			return daemonStatus{}, ctx.Err()
		default:
		}

		info, err := runfile.Read(runFilePath)
		if err != nil {
			return daemonStatus{}, err
		}
		alive := c.deps.ProcessAlive(pid)
		if !alive {
			// Only remove the run-file if it still belongs to the process we
			// stopped. A concurrent `ao start` may have already written a new
			// run-file for a different daemon; removing that would corrupt its
			// handshake and make a live daemon look stopped.
			if info != nil && info.PID == pid {
				if err := runfile.Remove(runFilePath); err != nil {
					return daemonStatus{}, err
				}
			}
			return daemonStatus{State: stateStopped, RunFile: runFilePath, DataDir: dataDir}, nil
		}
		if info == nil {
			// The run-file is the daemon's own liveness marker; it removes it as
			// it shuts down, before the OS process has necessarily exited. Once
			// the marker is gone the daemon has committed to stopping, so treat
			// that as stopped.
			//
			// We still poll for full process exit as a best effort so Windows
			// releases inherited handles such as daemon.log before callers clean
			// up the data directory, but exceeding the timeout is NOT an error:
			// with no desktop client connected the daemon can drain its
			// background workers slower than the stop timeout, and failing here
			// made `ao stop` spuriously report failure (issue #2214).
			if !c.deps.Now().Before(deadline) {
				return daemonStatus{State: stateStopped, RunFile: runFilePath, DataDir: dataDir}, nil
			}
			c.deps.Sleep(100 * time.Millisecond)
			continue
		}
		if !c.deps.Now().Before(deadline) {
			return daemonStatus{}, fmt.Errorf("daemon pid %d did not stop within %s", pid, timeout)
		}
		c.deps.Sleep(100 * time.Millisecond)
	}
}
