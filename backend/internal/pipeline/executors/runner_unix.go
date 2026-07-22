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

// killProcessTree sends SIGTERM to the child's process group, then escalates to
// SIGKILL after a short grace. Best-effort: a process that already exited makes
// the signals no-op.
//
// ponytail: fixed 2s grace; make it configurable only if a slow-draining shim
// ever needs a longer window.
func killProcessTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	pgid := cmd.Process.Pid
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	go func(pid int) {
		time.Sleep(2 * time.Second)
		_ = syscall.Kill(-pid, syscall.SIGKILL)
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
