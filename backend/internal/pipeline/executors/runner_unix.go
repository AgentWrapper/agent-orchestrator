//go:build !windows

package executors

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

// configureProcAttr puts the child in its own process group so killProcessTree
// can signal the whole tree (the shim plus any shells it spawns) via -pgid.
func configureProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// processGroupID returns the id of the process group the child leads.
// configureProcAttr made it a group leader, so the group id is its pid.
func processGroupID(cmd *exec.Cmd) int {
	if cmd.Process == nil {
		return 0
	}
	return cmd.Process.Pid
}

// killProcessTree sends SIGTERM to the child's process group, then escalates to
// SIGKILL after a short grace. Best-effort: a process that already exited makes
// the signals no-op.
func killProcessTree(cmd *exec.Cmd) {
	if pgid := processGroupID(cmd); pgid > 0 {
		killProcessGroup(pgid)
	}
}

// killProcessGroup terminates a process group, escalating SIGTERM to SIGKILL
// after a short grace. The restart reaper shares it with killProcessTree
// because a group left by a dead daemon deserves the same drain window as one
// this process is tearing down itself.
//
// ponytail: fixed 2s grace; make it configurable only if a slow-draining shim
// ever needs a longer window.
func killProcessGroup(pgid int) {
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	go func(pgid int) {
		time.Sleep(2 * time.Second)
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
	}(pgid)
}

// stateSignal returns the terminating signal's name, or "" for a normal exit.
func stateSignal(state *os.ProcessState) string {
	ws, ok := state.Sys().(syscall.WaitStatus)
	if !ok || !ws.Signaled() {
		return ""
	}
	return ws.Signal().String()
}
