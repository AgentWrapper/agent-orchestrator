//go:build !windows

package previewserver

import (
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"

	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

func previewCommand(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd
}

// errStalePreviewPID reports that a recorded preview PID could not be
// re-verified as the process AO launched, so no signal was sent.
var errStalePreviewPID = errors.New("preview pid is stale or recycled; refusing to signal")

// previewProcessStartTime returns the kernel-reported start time of pid as an
// opaque string (`ps -o lstart=`), or "" when the process does not exist or ps
// fails. It is captured at launch and compared verbatim before any group
// signal: a bare PID stops identifying anything the moment the child is
// reaped, and a group kill on a recycled number destroys an unrelated process
// family — a tmux server is its own group leader, so one stale group kill
// took out every tmux session at once (issue #3475).
func previewProcessStartTime(pid int) string {
	if pid <= 0 {
		return ""
	}
	out, err := aoprocess.Command("ps", "-o", "lstart=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// previewGroupHasMembers reports whether any process still belongs to process
// group pid.
func previewGroupHasMembers(pid int) bool {
	return aoprocess.Command("pgrep", "-g", strconv.Itoa(pid)).Run() == nil
}

// signalPreviewGroup delivers sig to pid's process group only after
// re-verifying that the number still identifies the process AO launched:
//
//   - The leader still exists: its start time must match the recorded one
//     verbatim, otherwise the PID was recycled and nothing is sent.
//   - The leader is gone (exited and reaped) but the group still has members:
//     POSIX reserves a PGID while its group lives and membership is only
//     inherited from the leader, so the members are AO's orphaned descendants
//     (the ones that ignored SIGTERM) and the group signal is what reaps them.
//   - Neither: nothing of AO's remains. A signal could only ever hit a
//     recycled PID, so nothing is sent.
//
// ponytail: the verify-then-kill pair is not atomic; without pidfd-style
// primitives a recycle in that microsecond window is untestable and accepted.
func signalPreviewGroup(pid int, recordedStart string, sig syscall.Signal) error {
	if pid <= 0 {
		return nil
	}
	if recordedStart == "" {
		return errStalePreviewPID
	}
	if current := previewProcessStartTime(pid); current != "" {
		if current != recordedStart {
			return errStalePreviewPID
		}
	} else if !previewGroupHasMembers(pid) {
		return nil
	}
	err := syscall.Kill(-pid, sig)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

// signalPreviewRoot signals only the direct child through os.Process, which
// refuses to signal an already-reaped child, so it can never hit a recycled
// PID. It is the fallback for runs whose launch identity could not be
// captured: descendants may leak, innocents never die.
func signalPreviewRoot(cmd *exec.Cmd, sig syscall.Signal) error {
	err := cmd.Process.Signal(sig)
	if err == nil || errors.Is(err, os.ErrProcessDone) || errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

func terminatePreviewProcess(cmd *exec.Cmd, startTime string) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	if startTime == "" {
		return signalPreviewRoot(cmd, syscall.SIGTERM)
	}
	return signalPreviewGroup(cmd.Process.Pid, startTime, syscall.SIGTERM)
}

func forceKillPreviewProcess(cmd *exec.Cmd, startTime string) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	if startTime == "" {
		return signalPreviewRoot(cmd, syscall.SIGKILL)
	}
	return signalPreviewGroup(cmd.Process.Pid, startTime, syscall.SIGKILL)
}

func forceKillPreviewPID(pid int, startTime string) error {
	return signalPreviewGroup(pid, startTime, syscall.SIGKILL)
}
