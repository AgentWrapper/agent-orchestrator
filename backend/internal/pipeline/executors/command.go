package executors

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// commandOutputCapBytes bounds captured stdout/stderr (1 MiB) so a runaway shim
// cannot OOM the engine.
const commandOutputCapBytes = 1 << 20

// stageOutputTailCapBytes bounds the combined stdout+stderr tail persisted onto
// the stage state (64 KiB) so the run detail can show what ran without the state
// growing unbounded.
const stageOutputTailCapBytes = 64 << 10

// stderrTailCapBytes bounds the stderr snippet appended to a failure reason.
const stderrTailCapBytes = 500

// ForkStatus classifies the linked session's PR provenance for the fork gate.
// The nil-safe Unknown value is the fail-safe default: a PR whose fork status
// the SCM plugin cannot determine is treated as untrusted.
type ForkStatus int

const (
	// ForkUnknown means fork status could not be determined; blocked by default.
	ForkUnknown ForkStatus = iota
	// ForkNo means the PR is not from a fork (or there is no PR); safe to run.
	ForkNo
	// ForkYes means the PR is from a fork; blocked unless allowForkPRs.
	ForkYes
)

// CommandSession is the linked-session facts the command executor needs: where
// to run (workspace + cwd) and whether the PR is from a fork. Injected so the
// executor stays decoupled from session storage.
type CommandSession struct {
	WorkspacePath string
	Fork          ForkStatus
	// PRNumber is surfaced in the fork-skip observation; 0 when there is no PR.
	PRNumber int
}

// CommandSessions resolves the linked worker session for a command stage.
type CommandSessions interface {
	Get(ctx context.Context, sessionID string) (CommandSession, bool, error)
}

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
// SIGTERM->SIGKILL escalation so detached shells do not outlive the stage).
type CommandProcess interface {
	Done() <-chan struct{}
	Result() CommandResult
	Kill()
}

// CommandRunner starts a subprocess for a command stage. The production impl
// (osRunner) shells out; unit tests inject a fake so no real process is spawned.
type CommandRunner interface {
	Start(ctx context.Context, spec CommandSpec) (CommandProcess, error)
}

// commandHandle is the running-stage token for a command stage. child is nil
// when the stage short-circuited before spawn (fork gate or a start error);
// final is then pre-populated.
type commandHandle struct {
	stageIdentity
	child CommandProcess
	final *Outcome
	// workspaceDir is the stage workspace root; a .ao/pipeline-findings.jsonl
	// dropped here is harvested after the process exits.
	workspaceDir string
	// timeoutCtx is non-nil only when the stage set a timeout; its
	// DeadlineExceeded error distinguishes a timeout kill from a natural exit.
	timeoutCtx    context.Context
	cancelTimeout context.CancelFunc
	timeoutMs     int64
}

// releaseTimeout frees the timeout context, if any. Idempotent.
func (h *commandHandle) releaseTimeout() {
	if h.cancelTimeout != nil {
		h.cancelTimeout()
	}
}

// CommandExecutor shells out a stage's command in the linked session's
// workspace and maps its JSON-over-stdout result to a verdict. Fork PRs are
// gated before any subprocess spawns.
type CommandExecutor struct {
	runner   CommandRunner
	sessions CommandSessions
}

// NewCommandExecutor builds a command executor over the given runner + session
// seams.
func NewCommandExecutor(runner CommandRunner, sessions CommandSessions) *CommandExecutor {
	return &CommandExecutor{runner: runner, sessions: sessions}
}

var _ StageExecutor = (*CommandExecutor)(nil)

// Start resolves the linked session, applies the fork-PR gate, then spawns the
// command. Fork-gated stages complete as neutral with a skip observation and
// NO subprocess is ever started. A missing session/workspace or spawn failure
// short-circuits to a failed outcome.
func (e *CommandExecutor) Start(ctx context.Context, in StartInput) (Handle, error) {
	if in.Stage.Executor.Kind != pipeline.ExecutorCommand {
		return nil, fmt.Errorf("command executor cannot start stage %q with executor.kind=%s", in.Stage.Name, in.Stage.Executor.Kind)
	}
	id := stageIdentity{runID: in.RunID, stageRunID: in.StageRunID, stageName: in.Stage.Name}
	spec := in.Stage.Executor

	session, exists, err := e.sessions.Get(ctx, in.LinkedSessionID)
	if err != nil {
		return shortCircuit(id, Outcome{Status: OutcomeFailed,
			ErrorMessage: fmt.Sprintf("failed to resolve session %s for command stage %q: %v", in.LinkedSessionID, in.Stage.Name, err)}), nil
	}
	if !exists {
		return shortCircuit(id, Outcome{Status: OutcomeFailed,
			ErrorMessage: fmt.Sprintf("command stage %q references unknown session %s", in.Stage.Name, in.LinkedSessionID)}), nil
	}

	// Fork-PR gate, BEFORE spawn, via the shared helper so agent/command/builtin
	// share one trust boundary. Prefer the run context's tri-state (#275); fall
	// back to the live session lookup this path already resolved when the context
	// carries no verdict (e.g. runs persisted before RunContext, manual runs).
	fork, prNumber := session.Fork, session.PRNumber
	if in.Context.IsFromFork != nil {
		fork, prNumber = forkFromContext(in.Context)
	}
	if skip, gated := forkGateDecision(fork, prNumber, in.Stage.Name, in.AllowForkPRs); gated {
		return shortCircuit(id, skip), nil
	}

	if session.WorkspacePath == "" {
		return shortCircuit(id, Outcome{Status: OutcomeFailed,
			ErrorMessage: fmt.Sprintf("command stage %q requires a workspace but session %s has none", in.Stage.Name, in.LinkedSessionID)}), nil
	}

	dir, err := resolveCwd(session.WorkspacePath, spec.Cwd)
	if err != nil {
		return shortCircuit(id, Outcome{Status: OutcomeFailed,
			ErrorMessage: fmt.Sprintf("command stage %q: %v", in.Stage.Name, err)}), nil
	}

	// Enforce Stage.TimeoutMs by deriving a deadline ctx: on expiry the runner's
	// Cancel hook fires the SIGTERM->SIGKILL process-tree kill, the child exits,
	// and Poll maps the DeadlineExceeded into a timeout failure.
	runCtx := ctx
	var timeoutCtx context.Context
	var cancelTimeout context.CancelFunc
	var timeoutMs int64
	if in.Stage.TimeoutMs != nil && *in.Stage.TimeoutMs > 0 {
		timeoutMs = *in.Stage.TimeoutMs
		runCtx, cancelTimeout = context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
		timeoutCtx = runCtx
	}

	child, err := e.runner.Start(runCtx, CommandSpec{
		Command:   spec.Command,
		Args:      spec.Args,
		Env:       pipelineEnv(in, spec.Env),
		Dir:       dir,
		OutputCap: commandOutputCapBytes,
	})
	if err != nil {
		if cancelTimeout != nil {
			cancelTimeout()
		}
		return shortCircuit(id, Outcome{Status: OutcomeFailed,
			ErrorMessage: fmt.Sprintf("failed to spawn command %q: %v", spec.Command, err)}), nil
	}

	return &commandHandle{
		stageIdentity: id,
		child:         child,
		workspaceDir:  session.WorkspacePath,
		timeoutCtx:    timeoutCtx,
		cancelTimeout: cancelTimeout,
		timeoutMs:     timeoutMs,
	}, nil
}

// Poll returns OutcomeRunning until the child exits, then interprets its exit
// code + stdout into a terminal outcome. A short-circuited handle returns its
// latched outcome immediately.
func (e *CommandExecutor) Poll(_ context.Context, h Handle) (Outcome, error) {
	handle, ok := h.(*commandHandle)
	if !ok {
		return Outcome{}, fmt.Errorf("command executor: unexpected handle type %T", h)
	}
	if handle.final != nil {
		return *handle.final, nil
	}
	select {
	case <-handle.child.Done():
		timedOut := handle.timeoutCtx != nil && errors.Is(handle.timeoutCtx.Err(), context.DeadlineExceeded)
		out := interpretExit(commandExit{
			stageName:    handle.stageName,
			res:          handle.child.Result(),
			workspaceDir: handle.workspaceDir,
			timedOut:     timedOut,
			timeoutMs:    handle.timeoutMs,
		})
		handle.final = &out
		handle.releaseTimeout()
		return out, nil
	default:
		return Outcome{Status: OutcomeRunning}, nil
	}
}

// Cancel kills the subprocess tree. Idempotent and a no-op on a short-circuited
// or already-finished handle.
func (e *CommandExecutor) Cancel(_ context.Context, h Handle) error {
	handle, ok := h.(*commandHandle)
	if !ok {
		return fmt.Errorf("command executor: unexpected handle type %T", h)
	}
	if handle.child == nil || handle.final != nil {
		handle.releaseTimeout()
		return nil
	}
	handle.child.Kill()
	handle.releaseTimeout()
	return nil
}

// shortCircuit builds a handle whose outcome is already decided (fork gate,
// resolution failure, spawn failure). No subprocess is attached.
func shortCircuit(id stageIdentity, out Outcome) *commandHandle {
	return &commandHandle{stageIdentity: id, child: nil, final: &out}
}

// resolveCwd joins a config-provided relative cwd onto the workspace root,
// rejecting absolute paths and ".." segments so a malicious config cannot
// escape the worktree.
func resolveCwd(base, rel string) (string, error) {
	if rel == "" {
		return base, nil
	}
	if strings.HasPrefix(rel, "/") || strings.HasPrefix(rel, "\\") || isWindowsAbs(rel) {
		return "", fmt.Errorf("command.cwd must be a relative path inside the workspace, got %q", rel)
	}
	for _, seg := range strings.FieldsFunc(rel, func(r rune) bool { return r == '/' || r == '\\' }) {
		if seg == ".." {
			return "", fmt.Errorf("command.cwd must be a relative path inside the workspace, got %q", rel)
		}
	}
	return strings.TrimRight(base, "/\\") + "/" + strings.TrimLeft(rel, "/\\"), nil
}

func isWindowsAbs(rel string) bool {
	return len(rel) >= 2 && rel[1] == ':' &&
		((rel[0] >= 'a' && rel[0] <= 'z') || (rel[0] >= 'A' && rel[0] <= 'Z'))
}

// pipelineEnv merges a fixed pipeline/PR context env block under the stage's own
// env map. The stage's YAML env wins on any key collision (it is applied last).
// Unset PR values are omitted so the subprocess never sees an empty AO_PR_* key.
func pipelineEnv(in StartInput, stageEnv map[string]string) map[string]string {
	c := in.Context
	env := make(map[string]string, len(stageEnv)+7)
	env["AO_PIPELINE_RUN_ID"] = string(in.RunID)
	env["AO_PIPELINE_STAGE"] = in.Stage.Name
	if c.PRNumber > 0 {
		env["AO_PR_NUMBER"] = strconv.Itoa(c.PRNumber)
	}
	if c.PRURL != "" {
		env["AO_PR_URL"] = c.PRURL
	}
	if c.SourceBranch != "" {
		env["AO_PR_BRANCH"] = c.SourceBranch
	}
	if c.TargetBranch != "" {
		env["AO_PR_BASE_BRANCH"] = c.TargetBranch
	}
	if c.HeadSHA != "" {
		env["AO_PR_HEAD_SHA"] = c.HeadSHA
	}
	// Stage env applied last so an author's explicit value overrides the block.
	for k, v := range stageEnv {
		env[k] = v
	}
	return env
}

// commandTaskResult is the single JSON object a command shim writes to stdout.
type commandTaskResult struct {
	Outcome   string                   `json:"outcome"`
	Verdict   pipeline.Verdict         `json:"verdict,omitempty"`
	Artifacts []pipeline.ArtifactInput `json:"artifacts,omitempty"`
	Reason    string                   `json:"reason,omitempty"`
}

// commandExit bundles everything interpretExit needs to map a finished (or
// timed-out) subprocess to a stage outcome.
type commandExit struct {
	stageName string
	res       CommandResult
	// workspaceDir is the stage workspace root; when non-empty a findings file
	// dropped at .ao/pipeline-findings.jsonl is harvested. Empty disables it.
	workspaceDir string
	// timedOut reports that the stage's timeout fired and the process was killed.
	timedOut bool
	// timeoutMs is the configured timeout, surfaced in the timeout reason.
	timeoutMs int64
}

// interpretExit maps a finished subprocess to a stage outcome. It has two modes:
//
//   - Envelope mode (stdout is a JSON object carrying an "outcome" field): the
//     historical JSON-over-stdout contract, unchanged.
//   - Exit-code fallback (stdout is not that envelope): exit 0 -> completed/pass,
//     nonzero -> failed with a reason built from the exit code plus a stderr
//     tail. A fallback outcome carries a command_stage_exit_mode observation.
//
// In BOTH modes a completed stage harvests a .ao/pipeline-findings.jsonl drop
// (same helper the agent executor uses); a malformed findings file fails the
// stage. The combined stdout+stderr tail is captured on every terminal outcome.
func interpretExit(ex commandExit) Outcome {
	out := interpretExitStatus(ex)
	out.Output = combinedOutputTail(ex.res.Stdout, ex.res.Stderr)
	if out.Status != OutcomeCompleted {
		return out
	}
	return harvestCommandFindings(ex, out)
}

// interpretExitStatus resolves the terminal status/verdict before findings
// harvest, dispatching between envelope and exit-code-fallback modes.
func interpretExitStatus(ex commandExit) Outcome {
	stageName, res := ex.stageName, ex.res
	if res.Err != nil {
		return Outcome{Status: OutcomeFailed, ErrorMessage: fmt.Sprintf("command stage %q spawn error: %v", stageName, res.Err)}
	}
	if ex.timedOut {
		return Outcome{Status: OutcomeFailed, ErrorMessage: fmt.Sprintf("command stage %q timed out after %dms%s", stageName, ex.timeoutMs, stderrSuffix(res.Stderr))}
	}
	if res.Signal != "" {
		return Outcome{Status: OutcomeFailed, ErrorMessage: fmt.Sprintf("command stage %q killed by signal %s%s", stageName, res.Signal, stderrSuffix(res.Stderr))}
	}

	trimmed := strings.TrimSpace(res.Stdout)
	if looksLikeEnvelope(trimmed) {
		return interpretEnvelope(stageName, res, trimmed)
	}

	// Exit-code fallback: no JSON envelope, so the raw exit code is the verdict.
	obs := Observation{Name: "command_stage_exit_mode", Data: map[string]any{
		"stage":    stageName,
		"mode":     "exit-code",
		"exitCode": res.ExitCode,
	}, Note: fmt.Sprintf("no JSON result envelope on stdout; verdict taken from exit code %d", res.ExitCode)}
	if res.ExitCode != 0 {
		return Outcome{Status: OutcomeFailed, Observations: []Observation{obs},
			ErrorMessage: fmt.Sprintf("command stage %q exited with code %d%s", stageName, res.ExitCode, stderrSuffix(res.Stderr))}
	}
	return Outcome{Status: OutcomeCompleted, Verdict: pipeline.VerdictPass, Observations: []Observation{obs}}
}

// interpretEnvelope applies the historical JSON-over-stdout contract to a stdout
// already known to be an envelope. A nonzero exit still fails: the shim crashed.
func interpretEnvelope(stageName string, res CommandResult, trimmed string) Outcome {
	if res.ExitCode != 0 {
		return Outcome{Status: OutcomeFailed, ErrorMessage: fmt.Sprintf("command stage %q exited with code %d%s", stageName, res.ExitCode, stderrSuffix(res.Stderr))}
	}

	var result commandTaskResult
	if err := json.Unmarshal([]byte(trimmed), &result); err != nil {
		return Outcome{Status: OutcomeFailed, ErrorMessage: fmt.Sprintf("command stage %q produced unparseable JSON on stdout: %v", stageName, err)}
	}
	if verr := validateTaskResult(result); verr != "" {
		return Outcome{Status: OutcomeFailed, ErrorMessage: fmt.Sprintf("command stage %q JSON failed validation: %s", stageName, verr)}
	}

	if result.Outcome == "failed" {
		if reason := strings.TrimSpace(result.Reason); reason != "" {
			return Outcome{Status: OutcomeFailed, ErrorMessage: fmt.Sprintf("command stage %q reported outcome=failed: %s", stageName, reason)}
		}
		return Outcome{Status: OutcomeFailed, ErrorMessage: fmt.Sprintf("command stage %q reported outcome=failed", stageName)}
	}

	verdict := result.Verdict
	if verdict == "" {
		verdict = defaultVerdictFor(result.Outcome)
	}
	out := Outcome{Status: OutcomeCompleted, Verdict: verdict, Artifacts: result.Artifacts}
	if result.Outcome == "skipped" {
		data := map[string]any{"stage": stageName}
		if result.Reason != "" {
			data["reason"] = result.Reason
		}
		out.Observations = []Observation{{Name: "command_stage_self_skipped", Data: data}}
	}
	return out
}

// harvestCommandFindings merges a command stage's optional findings-file drop
// into an already-completed outcome. A malformed file flips the stage to failed
// (matching agent semantics); a truncated file adds a truncation observation.
func harvestCommandFindings(ex commandExit, out Outcome) Outcome {
	if ex.workspaceDir == "" {
		return out
	}
	findingsPath := filepath.Join(ex.workspaceDir, stageFindingsRelativePath)
	if !fileExists(findingsPath) {
		return out
	}

	result, err := parseFindingsFile(findingsPath)
	if err != nil {
		return Outcome{Status: OutcomeFailed, Output: out.Output,
			ErrorMessage: fmt.Sprintf("command stage %q produced unparseable findings at %s: %v", ex.stageName, findingsPath, err)}
	}

	out.Artifacts = append(out.Artifacts, result.artifacts...)
	out.StatusChanges = append(out.StatusChanges, result.statusChanges...)
	if result.truncated {
		out.Observations = append(out.Observations, Observation{
			Name: "pipeline.findings.truncated",
			Data: map[string]any{
				"stageName":    ex.stageName,
				"findingsPath": findingsPath,
				"capBytes":     findingsFileSizeCapBytes,
				"bytesRead":    result.bytesRead,
			},
			Note: fmt.Sprintf("findings file exceeded %d bytes and was truncated; some findings may be missing", findingsFileSizeCapBytes),
		})
	}
	return out
}

// looksLikeEnvelope reports whether trimmed stdout is a JSON object carrying an
// "outcome" field, i.e. an attempt at the command-task envelope. Anything else
// (plain text, a JSON array, an object without "outcome") routes to the
// exit-code fallback.
func looksLikeEnvelope(trimmed string) bool {
	if trimmed == "" {
		return false
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &probe); err != nil {
		return false
	}
	_, ok := probe["outcome"]
	return ok
}

// stderrSuffix returns a "; stderr: <tail>" snippet for a failure reason, or ""
// when stderr is blank. The tail (last stderrTailCapBytes) is kept because the
// end of a build log is usually where the error is.
func stderrSuffix(stderr string) string {
	preview := strings.TrimSpace(stderr)
	if preview == "" {
		return ""
	}
	if len(preview) > stderrTailCapBytes {
		preview = preview[len(preview)-stderrTailCapBytes:]
	}
	return "; stderr: " + preview
}

// combinedOutputTail joins stdout and stderr and keeps the last
// stageOutputTailCapBytes for the run detail. Captured on success and failure.
func combinedOutputTail(stdout, stderr string) string {
	var combined string
	switch {
	case stdout != "" && stderr != "":
		combined = stdout + "\n" + stderr
	case stdout != "":
		combined = stdout
	default:
		combined = stderr
	}
	if len(combined) > stageOutputTailCapBytes {
		combined = combined[len(combined)-stageOutputTailCapBytes:]
	}
	return combined
}

func defaultVerdictFor(outcome string) pipeline.Verdict {
	if outcome == "succeeded" {
		return pipeline.VerdictPass
	}
	return pipeline.VerdictNeutral // "neutral" and "skipped" both map to neutral
}

// validateTaskResult returns "" when the decoded result is well-formed, else a
// human-readable reason. Decoding already rejected unknown fields and bad
// types; this enforces the outcome enum.
func validateTaskResult(r commandTaskResult) string {
	switch r.Outcome {
	case "succeeded", "failed", "neutral", "skipped":
	default:
		return fmt.Sprintf(`field "outcome" must be one of "succeeded"|"failed"|"neutral"|"skipped", got %q`, r.Outcome)
	}
	switch r.Verdict {
	case "", pipeline.VerdictPass, pipeline.VerdictFail, pipeline.VerdictNeutral:
	default:
		return fmt.Sprintf(`field "verdict" must be "pass"|"fail"|"neutral", got %q`, r.Verdict)
	}
	return ""
}
