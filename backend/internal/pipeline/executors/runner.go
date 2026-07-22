package executors

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"sync"
	"time"
)

// LogSink receives streamed subprocess output for logging. stream is "stdout"
// or "stderr". Implementations must be safe for concurrent calls (stdout and
// stderr pump on separate goroutines). Injected so the engine can route command
// output to the activity log; may be nil.
type LogSink interface {
	Write(stream string, chunk []byte)
}

// osRunner is the production CommandRunner: it shells out with os/exec, streams
// stdout/stderr to an optional sink while capturing both (capped) for the
// JSON-over-stdout contract, and kills the whole process tree on Cancel so
// detached shells do not outlive the stage.
type osRunner struct {
	sink LogSink
}

// NewOSRunner builds the production command runner. sink may be nil.
func NewOSRunner(sink LogSink) CommandRunner {
	return &osRunner{sink: sink}
}

// osProcess is a live os/exec subprocess.
type osProcess struct {
	cmd  *exec.Cmd
	done chan struct{}

	mu     sync.Mutex
	result CommandResult
}

func (p *osProcess) Done() <-chan struct{} { return p.done }

func (p *osProcess) Result() CommandResult {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.result
}

func (p *osProcess) Kill() {
	// Terminate the process group (SIGTERM then SIGKILL) so a shell's children
	// die with it. Best-effort: a race with natural exit is benign.
	killProcessTree(p.cmd)
}

func (r *osRunner) Start(ctx context.Context, spec CommandSpec) (CommandProcess, error) {
	cmd := exec.CommandContext(ctx, spec.Command, spec.Args...)
	cmd.Dir = spec.Dir
	cmd.Env = mergeEnv(spec.Env)
	configureProcAttr(cmd)
	// On ctx expiry (a stage timeout) tear down the whole process group via the
	// same SIGTERM->SIGKILL path Cancel uses, not just the direct child, so a
	// shell's descendants die too. WaitDelay bounds the post-signal wait so a
	// lingering grandchild holding a pipe cannot hang cmd.Wait forever.
	cmd.Cancel = func() error {
		killProcessTree(cmd)
		return nil
	}
	cmd.WaitDelay = 5 * time.Second

	capBytes := spec.OutputCap
	if capBytes <= 0 {
		capBytes = commandOutputCapBytes
	}
	stdout := &capBuffer{limit: capBytes}
	stderr := &capBuffer{limit: capBytes}
	cmd.Stdout = teeSink(stdout, r.sink, "stdout")
	cmd.Stderr = teeSink(stderr, r.sink, "stderr")

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	p := &osProcess{cmd: cmd, done: make(chan struct{})}
	go func() {
		defer close(p.done)
		waitErr := cmd.Wait()
		res := CommandResult{
			Stdout:       stdout.String(),
			Stderr:       stderr.String(),
			StdoutCapped: stdout.capped,
		}
		if cmd.ProcessState != nil {
			res.ExitCode = cmd.ProcessState.ExitCode()
			res.Signal = stateSignal(cmd.ProcessState)
		}
		// A non-zero exit surfaces via ExitCode, not Err. Only a genuine
		// spawn/wait failure (not *exec.ExitError) is reported as Err.
		var exitErr *exec.ExitError
		if waitErr != nil && !errors.As(waitErr, &exitErr) {
			res.Err = waitErr
		}
		p.mu.Lock()
		p.result = res
		p.mu.Unlock()
	}()
	return p, nil
}

// mergeEnv overlays the stage's env onto the daemon's environment.
func mergeEnv(extra map[string]string) []string {
	if len(extra) == 0 {
		return os.Environ()
	}
	base := os.Environ()
	env := make([]string, 0, len(base)+len(extra))
	env = append(env, base...)
	for k, v := range extra {
		env = append(env, k+"="+v)
	}
	return env
}
