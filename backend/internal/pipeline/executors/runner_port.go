// Package executors runs pipeline stages. The v1 stage executors were stripped
// ahead of the v2 rebuild; the subprocess runner and its port survive because
// v2's command executor consumes them unchanged.
package executors

import "context"

// commandOutputCapBytes bounds captured stdout/stderr (1 MiB) so a runaway
// command cannot OOM the engine.
const commandOutputCapBytes = 1 << 20

// CommandSpec is the resolved subprocess the runner should start.
type CommandSpec struct {
	Command string
	Args    []string
	Env     map[string]string
	Dir     string
	// OutputCap bounds captured stdout/stderr bytes.
	OutputCap int
}

// CommandResult is a finished subprocess. ExitCode is meaningful only when
// Signal is empty; a non-empty Signal means the process was killed.
type CommandResult struct {
	ExitCode     int
	Signal       string
	Stdout       string
	Stderr       string
	StdoutCapped bool
	// Err is set when the process failed to spawn or wait errored for a reason
	// other than a non-zero exit (which is reported via ExitCode).
	Err error
}

// CommandProcess is a started subprocess. Done closes on exit, after which
// Result is readable. Kill terminates the process tree (the runner owns
// SIGTERM to SIGKILL escalation so detached shells do not outlive the stage).
type CommandProcess interface {
	Done() <-chan struct{}
	Result() CommandResult
	Kill()
	// PGID is the id of the process group the command runs in, or 0 where the
	// platform gave it none. It is persisted with the stage so a later daemon
	// can reap a group this one would otherwise leak on restart.
	PGID() int
}

// CommandRunner starts a subprocess for a command stage. The production impl
// (osRunner) shells out; unit tests inject a fake so no real process is spawned.
type CommandRunner interface {
	Start(ctx context.Context, spec CommandSpec) (CommandProcess, error)
}
