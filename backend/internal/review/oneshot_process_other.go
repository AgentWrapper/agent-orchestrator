//go:build !windows

package review

import "os/exec"

// CommandContext's default process kill is sufficient for native Unix CLI
// launchers, whose shims exec the underlying process.
func configureOneShotCancellation(*exec.Cmd) {}
