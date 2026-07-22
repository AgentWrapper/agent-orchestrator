//go:build windows

package executors

import (
	"os"
	"os/exec"
)

// configureProcAttr is a no-op on Windows; process-group semantics differ and
// exec.CommandContext already terminates the child on ctx cancel.
func configureProcAttr(cmd *exec.Cmd) {}

// killProcessTree kills the child process. Best-effort.
//
// ponytail: single-process kill; a Job Object would be needed to reap a full
// tree on Windows if detached grandchildren ever become a problem.
func killProcessTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	_ = cmd.Process.Kill()
}

// stateSignal returns "" on Windows: exits are reported via ExitCode, not
// signals.
func stateSignal(state *os.ProcessState) string { return "" }
