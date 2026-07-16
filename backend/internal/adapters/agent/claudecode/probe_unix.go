//go:build !windows

package claudecode

import (
	"os/exec"
	"syscall"
)

// configureProbeProcessGroup puts the probe in its own process group so a
// timed-out Claude print probe cannot leave provider/MCP descendants running.
func configureProbeProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
			return cmd.Process.Kill()
		}
		return nil
	}
}
