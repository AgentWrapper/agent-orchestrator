//go:build !windows

package codex

import (
	"os/exec"
	"syscall"
)

// configureProbeProcessGroup puts the probe in its own process group and, when
// the context expires, kills the whole group rather than just the direct child.
//
// exec.CommandContext's default cancel signals only the process it started.
// `codex exec` spawns descendants that inherit the output pipe, so they survive
// the deadline: the provider call keeps running and orphans accumulate across
// repeated timed-out config writes. WaitDelay closes the pipes but does not
// reap anything.
func configureProbeProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		// A negative pid targets the process group led by the child.
		if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
			return cmd.Process.Kill()
		}
		return nil
	}
}
