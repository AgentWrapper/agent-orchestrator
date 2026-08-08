//go:build windows

package review

import (
	"os"
	"os/exec"
	"strconv"

	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

// npm-installed CLIs run through a .cmd shim on Windows. Killing only that shim
// can leave its node.exe child running, so cancellation terminates the exact
// process tree rooted at the command AO started.
func configureOneShotCancellation(cmd *exec.Cmd) {
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return os.ErrProcessDone
		}
		err := aoprocess.Command(
			"taskkill",
			"/PID", strconv.Itoa(cmd.Process.Pid),
			"/T",
			"/F",
		).Run()
		if err != nil {
			return cmd.Process.Kill()
		}
		return nil
	}
}
