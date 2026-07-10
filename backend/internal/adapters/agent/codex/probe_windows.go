//go:build windows

package codex

import "os/exec"

// configureProbeProcessGroup is a no-op on Windows: there is no POSIX process
// group to signal, and exec.CommandContext's default cancel already terminates
// the probe process. WaitDelay remains the bound on the output pipes.
func configureProbeProcessGroup(cmd *exec.Cmd) {}
