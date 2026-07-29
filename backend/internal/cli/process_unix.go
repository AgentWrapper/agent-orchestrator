//go:build !windows

package cli

import "syscall"

// detachSysProcAttr puts the daemon in a new session (Setsid) so it is no
// longer in the launcher's foreground process group and won't receive the
// terminal's SIGINT/SIGHUP.
func detachSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}

// terminateProcessGroup sends SIGTERM to pid's process group. Because
// startProcess launches the daemon with Setsid (a new session), pid is the
// session/process-group leader, so -pid targets the whole group. Signaling an
// already-dead pid is not an error the caller needs to see.
func terminateProcessGroup(pid int) error {
	return syscall.Kill(-pid, syscall.SIGTERM)
}

// killProcessGroup escalates to SIGKILL, mirroring terminateProcessGroup.
func killProcessGroup(pid int) error {
	return syscall.Kill(-pid, syscall.SIGKILL)
}
