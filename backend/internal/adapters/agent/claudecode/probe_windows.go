//go:build windows

package claudecode

import "os/exec"

func configureProbeProcessGroup(cmd *exec.Cmd) {}
