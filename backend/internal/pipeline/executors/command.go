package executors

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// stageTailCapBytes bounds the in-memory copy of a stage's output (64 KiB) that
// the run-detail DTO shows. The full stream is on disk in the stage log, so
// nothing is lost by keeping this small.
const stageTailCapBytes = 64 << 10

// stageLogFilePerm matches the run folder's file mode: run output can contain
// whatever the command printed, so it stays owner-only.
const stageLogFilePerm os.FileMode = 0o600

// stageLogDirPerm matches the run folder's directory mode.
const stageLogDirPerm os.FileMode = 0o750

// RunnerFactory builds a CommandRunner bound to one stage's log sink. It exists
// because the sink is per stage while the executor is per project: NewOSRunner
// satisfies this signature as-is, and tests pass a fake.
type RunnerFactory func(sink LogSink) CommandRunner

// CommandExecutor runs a command stage's `run:` block in the stage's workspace.
// Exit status is the outcome (spec section 6.1): there is no stdout envelope to
// parse, and this executor never decides whether a code means success.
type CommandExecutor struct {
	runners RunnerFactory
}

// NewCommandExecutor builds the command executor over a runner factory. Pass
// NewOSRunner in production.
func NewCommandExecutor(runners RunnerFactory) *CommandExecutor {
	return &CommandExecutor{runners: runners}
}

var _ StageExecutor = (*CommandExecutor)(nil)

// commandHandle is the running-stage token for a command stage.
type commandHandle struct {
	stageIdentity
	child CommandProcess
	log   *stageLog
}

// ProcessGroup returns the group the command was started in, so the driver can
// persist it against the stage. Restart reconciliation is the only reader: it
// is the one thing that can still find this work after the handle is gone.
func (h *commandHandle) ProcessGroup() int { return h.child.PGID() }

// OutputTail returns the capped copy of the stage's output.
func (h *commandHandle) OutputTail() (string, bool) {
	if h.log == nil {
		return "", false
	}
	return h.log.tail()
}

// Start opens the stage log and spawns the command. The `run:` block is handed
// to a shell so environment variables interpolate, which is the whole of v2's
// templating story (spec section 12.3).
func (e *CommandExecutor) Start(ctx context.Context, in StartInput) (Handle, error) {
	if in.Stage.Executor != pipeline.ExecutorCommand {
		return nil, fmt.Errorf("command executor cannot start stage %q with executor %q", in.Stage.ID, in.Stage.Executor)
	}
	if in.WorkspacePath == "" {
		return nil, fmt.Errorf("command stage %q has no workspace to run in", in.Stage.ID)
	}
	log, err := openStageLog(in.LogPath)
	if err != nil {
		return nil, fmt.Errorf("command stage %q: %w", in.Stage.ID, err)
	}

	child, err := e.runners(log).Start(ctx, CommandSpec{
		// ponytail: sh everywhere, matching how session_manager runs a
		// configured command. A Windows shell selection lands the day a
		// pipeline has to run there.
		Command: "sh",
		Args:    []string{"-c", in.Stage.Run},
		Env:     commandEnv(in),
		Dir:     in.WorkspacePath,
		// The runner's own capture is bounded to the same size as the tail: the
		// stage log on disk is the complete record, so buffering more in the
		// engine buys nothing.
		OutputCap: stageTailCapBytes,
	})
	if err != nil {
		log.close()
		return nil, fmt.Errorf("spawn command stage %q: %w", in.Stage.ID, err)
	}

	return &commandHandle{
		stageIdentity: stageIdentity{runID: in.RunID, stageID: in.Stage.ID, attempt: in.Attempt},
		child:         child,
		log:           log,
	}, nil
}

// Poll reports running until the process exits, then reports the exit status
// verbatim. Mapping a code onto an outcome is the driver's job.
func (e *CommandExecutor) Poll(_ context.Context, h Handle) (Poll, error) {
	handle, ok := h.(*commandHandle)
	if !ok {
		return Poll{}, fmt.Errorf("command executor: unexpected handle type %T", h)
	}
	select {
	case <-handle.child.Done():
		handle.log.close()
		res := handle.child.Result()
		out := Poll{State: PollExited, ExitCode: res.ExitCode}
		switch {
		case res.Err != nil:
			// A spawn or wait failure is not a clean exit. Never let it read as
			// success just because no status was collected.
			if out.ExitCode == 0 {
				out.ExitCode = -1
			}
			out.Reason = res.Err.Error()
		case res.Signal != "":
			out.Reason = "killed by signal " + res.Signal
		}
		return out, nil
	default:
		return Poll{State: PollRunning}, nil
	}
}

// Cancel kills the process group (the runner owns the SIGTERM to SIGKILL
// escalation, so a shell's children die with it) and closes the log.
// Idempotent.
func (e *CommandExecutor) Cancel(_ context.Context, h Handle) error {
	handle, ok := h.(*commandHandle)
	if !ok {
		return fmt.Errorf("command executor: unexpected handle type %T", h)
	}
	handle.child.Kill()
	return nil
}

// Interrupt is Cancel for a command stage. The interrupt/cancel distinction only
// buys anything for agent stages, where the session must survive the kill (spec
// section 7.2); a process has nothing to preserve.
func (e *CommandExecutor) Interrupt(ctx context.Context, h Handle) error {
	return e.Cancel(ctx, h)
}

// commandEnv layers the resolved credentials over the ambient set. The process
// environment is added underneath by the runner, so the effective order is
// process env, then ambient, then credentials. Credentials win a collision:
// they are the authority the stage was granted, and ambient identity must not
// be able to mask them.
func commandEnv(in StartInput) map[string]string {
	env := make(map[string]string, len(in.Env)+len(in.Credentials))
	for k, v := range in.Env {
		env[k] = v
	}
	for k, v := range in.Credentials {
		env[k] = v
	}
	return env
}

// stageLog is the LogSink for one stage: it writes the full stream to
// <run>/stage-logs/<stage>.log and keeps a capped copy in memory for the
// run-detail DTO. Both streams land in one file, raw and interleaved, because
// tagging each chunk would split partial lines mid-write.
type stageLog struct {
	mu     sync.Mutex
	file   *os.File
	capped *capBuffer
	closed bool
}

// openStageLog creates or appends to the stage's log file. Appending means a
// second attempt after a nudge adds to the record instead of erasing the first.
func openStageLog(path string) (*stageLog, error) {
	if path == "" {
		return nil, fmt.Errorf("stage log: no log path")
	}
	if err := os.MkdirAll(filepath.Dir(path), stageLogDirPerm); err != nil {
		return nil, fmt.Errorf("stage log dir %s: %w", filepath.Dir(path), err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, stageLogFilePerm)
	if err != nil {
		return nil, fmt.Errorf("open stage log %s: %w", path, err)
	}
	return &stageLog{file: file, capped: &capBuffer{limit: stageTailCapBytes}}, nil
}

// Write implements LogSink. Failures are swallowed: a stage must not die
// because logging did, and the exit status is still the outcome.
func (l *stageLog) Write(_ string, chunk []byte) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return
	}
	_, _ = l.file.Write(chunk)
	_, _ = l.capped.Write(chunk)
}

// tail returns the in-memory copy and whether output past the cap was dropped.
func (l *stageLog) tail() (string, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.capped.String(), l.capped.capped
}

// close releases the file. Idempotent, and safe to race with a pump goroutine.
func (l *stageLog) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return
	}
	l.closed = true
	_ = l.file.Close()
}
