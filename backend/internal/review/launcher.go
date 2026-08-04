package review

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
)

const cancelInterruptDelay = 150 * time.Millisecond

const reviewerTaskMessagePrefix = "Read and follow the AO review task in `"

// Launcher spawns, re-notifies, and probes a reviewer over a worker's worktree.
// It is the side of the engine that talks to the reviewer registry and runtime;
// the engine owns the orchestration and persistence.
type Launcher interface {
	// Preflight checks whether the reviewer for the given harness is available
	// to run (binary on PATH, etc.) without starting a runtime pane. It runs
	// only when a reviewer launch is actually required, after ReviewRun rows
	// have been created. On failure the engine's Trigger() calls failRuns() to
	// mark those rows as failed, matching the existing Spawn failure semantics.
	Preflight(ctx context.Context, harness domain.ReviewerHarness, workspacePath string) error
	// Spawn launches a fresh reviewer and returns its stable execution handle.
	// For interactive reviewers this is also the runtime pane handle.
	Spawn(ctx context.Context, spec LaunchSpec) (handleID string, err error)
	// Notify asks an existing reviewer execution to review a new commit.
	Notify(ctx context.Context, handleID string, spec LaunchSpec) error
	// Alive reports whether a reviewer execution is still running.
	Alive(ctx context.Context, handleID string) (bool, error)
	// Cancel stops a running reviewer. Interactive reviewer terminals are kept.
	Cancel(ctx context.Context, handleID string, harness domain.ReviewerHarness) error
}

// TerminalReviewRecoverer is an optional launcher capability used during
// daemon startup. Keeping it separate from Launcher avoids forcing lightweight
// test/future launcher implementations to persist terminal requests.
type TerminalReviewRecoverer interface {
	RecoverTerminalReviews(ctx context.Context) error
}

// LaunchSpec is the engine's request to (re)launch a reviewer for one pass.
type LaunchSpec struct {
	RunID         string
	BatchID       string
	WorkerID      domain.SessionID
	Harness       domain.ReviewerHarness
	WorkspacePath string
	PRURL         string
	TargetSHA     string
	ReviewQueue   []ports.ReviewTask
	ReviewIndex   int
}

// ReviewCompletion is one asynchronously completed one-shot review. Err is set
// when the CLI failed before producing a usable result.
type ReviewCompletion struct {
	RunID     string
	PRURL     string
	TargetSHA string
	Verdict   domain.ReviewVerdict
	Body      string
	Comments  []ports.ReviewComment
	Err       error
}

// CompletionHandler records results emitted by a one-shot reviewer.
type CompletionHandler func(ctx context.Context, workerID domain.SessionID, completions []ReviewCompletion)

// TerminalReviewConsumedChecker tells the launcher whether every run backed by
// a terminal request is in a terminal persisted state. It is optional so the
// generic launcher remains usable without a store.
type TerminalReviewConsumedChecker func(ctx context.Context, workerID domain.SessionID, runIDs []string) bool

// TerminalReviewActiveChecker reports whether at least one run referenced by
// a durable terminal request is still running for the worker. Recovery uses it
// before registering a watcher so an old incomplete request cannot replace the
// watcher for a newer batch on the same stable terminal handle.
type TerminalReviewActiveChecker func(ctx context.Context, workerID domain.SessionID, runIDs []string) (bool, error)

// reviewerRuntime is the runtime surface the launcher needs: create a pane,
// inject a message into a running pane, and probe liveness. The tmux runtime
// satisfies it.
type reviewerRuntime interface {
	Create(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error)
	Destroy(ctx context.Context, handle ports.RuntimeHandle) error
	Interrupt(ctx context.Context, handle ports.RuntimeHandle) error
	IsAlive(ctx context.Context, handle ports.RuntimeHandle) (bool, error)
	SendMessage(ctx context.Context, handle ports.RuntimeHandle, message string) error
}

// reviewerTerminalRuntime identifies the production runtimes that support a
// durable visible terminal. The optional capability keeps lightweight launcher
// fakes and third-party runtimes on the original background one-shot path.
type reviewerTerminalRuntime interface {
	reviewerRuntime
	GetOutput(ctx context.Context, handle ports.RuntimeHandle, lines int) (string, error)
}

// reviewerTerminalProcessRuntime is an optional stronger liveness probe for
// output-only terminals. A retained tmux/ConPTY host can outlive its command,
// so session existence alone is not enough to decide whether recovery should
// keep polling an incomplete sidecar.
type reviewerTerminalProcessRuntime interface {
	IsProcessAlive(ctx context.Context, handle ports.RuntimeHandle) (bool, error)
}

// agentLauncher resolves a reviewer adapter from the registry and drives the
// runtime. The reviewer reuses the worker's worktree (a fresh session worktree
// would branch off the default branch and so would not contain the PR changes).
type agentLauncher struct {
	reviewers  ports.ReviewerResolver
	runtime    reviewerRuntime
	dataDir    string
	rootCtx    context.Context
	onComplete CompletionHandler
	consumed   TerminalReviewConsumedChecker
	active     TerminalReviewActiveChecker
	execute    oneShotExecutor

	jobsMu  sync.Mutex
	jobs    map[string]oneShotJob
	nextJob uint64
	// recovered fences duplicate startup probes in one daemon process. Durable
	// request paths remain the authority across a real restart; this map only
	// makes an explicit second recovery call idempotent in the same process.
	recovered map[string]struct{}
}

type preLaunchReviewer interface {
	PreLaunch(ctx context.Context, inv ports.ReviewInvocation) error
}

// LauncherOption customizes one-shot reviewer execution.
type LauncherOption func(*agentLauncher)

// WithLauncherContext ties one-shot reviewer processes to the daemon lifetime.
func WithLauncherContext(ctx context.Context) LauncherOption {
	return func(l *agentLauncher) {
		if ctx != nil {
			l.rootCtx = ctx
		}
	}
}

// WithCompletionHandler records one-shot reviewer results.
func WithCompletionHandler(handler CompletionHandler) LauncherOption {
	return func(l *agentLauncher) { l.onComplete = handler }
}

// WithTerminalReviewConsumed enables bounded cleanup of old request/result
// pairs after the normal completion handler has confirmed all referenced runs
// are no longer running.
func WithTerminalReviewConsumed(checker TerminalReviewConsumedChecker) LauncherOption {
	return func(l *agentLauncher) { l.consumed = checker }
}

// WithTerminalReviewActive enables stale-request fencing during restart
// recovery. It is optional so lightweight launcher users and tests retain the
// generic behavior when no persistence layer is available.
func WithTerminalReviewActive(checker TerminalReviewActiveChecker) LauncherOption {
	return func(l *agentLauncher) { l.active = checker }
}

// NewLauncher builds the production reviewer launcher.
func NewLauncher(reviewers ports.ReviewerResolver, runtime reviewerRuntime, dataDir string, opts ...LauncherOption) Launcher {
	l := &agentLauncher{
		reviewers: reviewers,
		runtime:   runtime,
		dataDir:   dataDir,
		rootCtx:   context.Background(),
		jobs:      make(map[string]oneShotJob),
		recovered: make(map[string]struct{}),
		execute:   executeOneShot,
	}
	for _, opt := range opts {
		opt(l)
	}
	return l
}

// Preflight checks whether the reviewer for the given harness can be launched
// without starting a runtime pane. It uses the same source of truth as Spawn:
// resolve the adapter, build the real ReviewCommand, and validate the
// executable. The only difference from Spawn is that Preflight stops before
// runtime.Create().
func (l *agentLauncher) Preflight(ctx context.Context, harness domain.ReviewerHarness, workspacePath string) error {
	reviewer, ok := l.reviewers.Reviewer(harness)
	if !ok {
		return fmt.Errorf("no reviewer adapter for harness %q", harness)
	}
	cmd, err := reviewer.ReviewCommand(ctx, ports.ReviewInvocation{WorkspacePath: workspacePath})
	if err != nil {
		return fmt.Errorf("reviewer command: %w", err)
	}
	if len(cmd.Argv) == 0 {
		return fmt.Errorf("reviewer produced empty command")
	}
	if resolved, resolveErr := resolveReviewerCommand(ctx, reviewer, cmd); resolveErr == nil {
		cmd = resolved
	} else if ctx.Err() != nil {
		return resolveErr
	}
	// Unwrap any leading env KEY=value ... prefix so the real binary is
	// validated. Mirrors launchBinary in the session manager, which already
	// skips the same prefix to validate the worker agent binary.
	bin := cmd.Argv[reviewerCommandBinaryIndex(cmd.Argv)]
	if _, err := exec.LookPath(bin); err != nil {
		// Keep the executable name and the platform diagnostic while wrapping
		// the typed port sentinel used by the service/controller mapping.
		if harness == domain.ReviewerGreptile {
			return fmt.Errorf("Greptile CLI is not installed (binary not found). Install it, then run greptile login and retry: %w", ports.ErrAgentBinaryNotFound)
		}
		return fmt.Errorf("reviewer binary %q not found: %v: %w", bin, err, ports.ErrAgentBinaryNotFound)
	}
	if checker, ok := reviewer.(ports.ReviewerAuthChecker); ok {
		status, _ := checker.AuthStatus(ctx)
		if status == ports.AgentAuthStatusUnauthorized {
			if harness == domain.ReviewerGreptile {
				return fmt.Errorf("Greptile CLI is not authenticated. Run greptile login and retry: %w", ports.ErrReviewerNotAuthenticated)
			}
			return fmt.Errorf("reviewer %q is not authenticated: %w", harness, ports.ErrReviewerNotAuthenticated)
		}
	}
	return nil
}

// reviewerHandleID is the stable execution handle for a worker's reviewer, so
// one live reviewer is reused across passes.
func reviewerHandleID(workerID domain.SessionID) string {
	return "review-" + string(workerID)
}

func (l *agentLauncher) invocation(spec LaunchSpec) ports.ReviewInvocation {
	prompt, systemPrompt := reviewTexts(spec)
	return ports.ReviewInvocation{
		ReviewerID:      reviewerHandleID(spec.WorkerID),
		RunID:           spec.RunID,
		WorkerSessionID: spec.WorkerID,
		PRURL:           spec.PRURL,
		TargetSHA:       spec.TargetSHA,
		ReviewQueue:     spec.ReviewQueue,
		ReviewIndex:     spec.ReviewIndex,
		WorkspacePath:   spec.WorkspacePath,
		Prompt:          prompt,
		SystemPrompt:    systemPrompt,
	}
}

// prepareInvocation stores the full reviewer instructions outside the
// worktree, then replaces the terminal-visible prompt with a short file
// reference.
// Reviewer panes are shared by desktop, mobile, and direct runtime attaches,
// so keeping the full text out of the PTY is the only device-independent way
// to hide it.
func (l *agentLauncher) prepareInvocation(spec LaunchSpec) (ports.ReviewInvocation, error) {
	inv := l.invocation(spec)
	if strings.TrimSpace(l.dataDir) == "" {
		return ports.ReviewInvocation{}, fmt.Errorf("reviewer prompt data directory is required")
	}
	if strings.TrimSpace(spec.BatchID) == "" || strings.TrimSpace(spec.RunID) == "" {
		return ports.ReviewInvocation{}, fmt.Errorf("reviewer prompt batch and run ids are required")
	}
	promptRoot := filepath.Join(l.dataDir, "prompts", string(spec.WorkerID), "reviewer")
	requestDir := filepath.Join(promptRoot, "requests", spec.BatchID, spec.RunID)
	if err := os.MkdirAll(requestDir, 0o700); err != nil {
		return ports.ReviewInvocation{}, fmt.Errorf("create reviewer prompt directory: %w", err)
	}
	taskPath := filepath.Join(requestDir, "task.md")
	if err := os.WriteFile(taskPath, []byte(strings.TrimRight(inv.Prompt, "\n")+"\n"), 0o600); err != nil {
		return ports.ReviewInvocation{}, fmt.Errorf("write reviewer task prompt: %w", err)
	}
	systemPath := filepath.Join(promptRoot, "system.md")
	systemPrompt := strings.TrimRight(inv.SystemPrompt, "\n") + "\n\n" +
		"AO stores each review task in an immutable file. Whenever AO asks you to start a review task, " +
		"read the exact file path in that request first and follow it completely.\n"
	if err := os.WriteFile(systemPath, []byte(systemPrompt), 0o600); err != nil {
		return ports.ReviewInvocation{}, fmt.Errorf("write reviewer system prompt: %w", err)
	}
	inv.Prompt = reviewerTaskMessagePrefix + filepath.ToSlash(taskPath) + "`."
	inv.SystemPrompt = ""
	inv.SystemPromptFile = systemPath
	inv.TaskPromptFile = taskPath
	inv.TaskPromptRoot = promptRoot
	return inv, nil
}

func (l *agentLauncher) Spawn(ctx context.Context, spec LaunchSpec) (string, error) {
	reviewer, ok := l.reviewers.Reviewer(spec.Harness)
	if !ok {
		return "", fmt.Errorf("no reviewer adapter for harness %q", spec.Harness)
	}
	if oneShot, ok := reviewer.(ports.OneShotReviewer); ok {
		return l.startOneShot(spec, oneShot)
	}
	handleID := reviewerHandleID(spec.WorkerID)
	inv, err := l.prepareInvocation(spec)
	if err != nil {
		return "", err
	}
	if pl, ok := reviewer.(preLaunchReviewer); ok {
		if err := pl.PreLaunch(ctx, inv); err != nil {
			return "", fmt.Errorf("reviewer pre-launch: %w", err)
		}
	}
	cmd, err := reviewer.ReviewCommand(ctx, inv)
	if err != nil {
		return "", fmt.Errorf("reviewer command: %w", err)
	}
	if resolved, resolveErr := resolveReviewerCommand(ctx, reviewer, cmd); resolveErr == nil {
		cmd = resolved
	} else if ctx.Err() != nil {
		return "", resolveErr
	}
	// The reviewer handle is stable per worker, so a still-live pane from a
	// previous pass would otherwise block `tmux new-session` (duplicate name) or,
	// worse, keep serving under its old harness. Destroy any stale pane on this
	// handle first so the reviewer always (re)launches under spec.Harness's
	// sandbox/permissions/env — which are applied only here at Create, never by
	// Notify. Destroy is idempotent when no pane exists (first spawn / dead pane).
	if err := l.runtime.Destroy(ctx, ports.RuntimeHandle{ID: handleID}); err != nil {
		return "", fmt.Errorf("reviewer replace stale pane: %w", err)
	}
	handle, err := l.runtime.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID(handleID),
		WorkspacePath: spec.WorkspacePath,
		Argv:          cmd.Argv,
		Env:           pinnedEnv(cmd.Env),
	})
	if err != nil {
		return "", fmt.Errorf("reviewer runtime: %w", err)
	}
	return handle.ID, nil
}

// resolveReviewerCommand replaces a logical reviewer executable with the
// adapter's resolved path when the adapter supports an install-location probe.
// This keeps GUI-launched daemons working when a CLI is installed outside the
// daemon's inherited PATH, while adapters without the optional capability keep
// their existing command unchanged.
func resolveReviewerCommand(ctx context.Context, reviewer ports.Reviewer, command ports.ReviewCommandSpec) (ports.ReviewCommandSpec, error) {
	if len(command.Argv) == 0 {
		return command, nil
	}
	resolver, ok := reviewer.(ports.ReviewerBinaryResolver)
	if !ok {
		return command, nil
	}
	path, err := resolver.ResolveBinary(ctx)
	if err != nil {
		return command, err
	}
	index := reviewerCommandBinaryIndex(command.Argv)
	argv := append([]string(nil), command.Argv...)
	argv[index] = path
	command.Argv = argv
	return command, nil
}

func reviewerCommandBinaryIndex(argv []string) int {
	if len(argv) > 0 && filepath.Base(argv[0]) == "env" {
		for index, arg := range argv[1:] {
			if !strings.Contains(arg, "=") {
				return index + 1
			}
		}
	}
	return 0
}

// pinnedEnv returns the reviewer command's env with PATH pinned to the daemon's
// own directory, so the bare `ao` the reviewer runs (e.g. `ao review submit`)
// resolves to this daemon's CLI rather than a foreign `ao` first on the
// inherited PATH. Mirrors the worker-session pin in the session manager.
// Best-effort: an unpinnable daemon (not named "ao") keeps the inherited PATH.
func pinnedEnv(base map[string]string) map[string]string {
	path, err := sessionmanager.HookPATH(os.Executable, os.Getenv, base)
	if err != nil {
		return base
	}
	env := make(map[string]string, len(base)+1)
	for k, v := range base {
		env[k] = v
	}
	env["PATH"] = path
	return env
}

func (l *agentLauncher) Notify(ctx context.Context, handleID string, spec LaunchSpec) error {
	reviewer, ok := l.reviewers.Reviewer(spec.Harness)
	if !ok {
		return fmt.Errorf("no reviewer adapter for harness %q", spec.Harness)
	}
	if oneShot, ok := reviewer.(ports.OneShotReviewer); ok {
		// A one-shot Notify is a fresh CLI process, not an input message to the
		// existing pane. Re-run the binary preflight for terminal one-shots so a
		// CLI removed between review passes fails before replacing the retained
		// output pane.
		if _, terminal := reviewer.(ports.TerminalOneShotReviewer); terminal {
			if err := l.Preflight(ctx, spec.Harness, spec.WorkspacePath); err != nil {
				return err
			}
		}
		_, err := l.startOneShot(spec, oneShot)
		return err
	}
	inv, err := l.prepareInvocation(spec)
	if err != nil {
		return err
	}
	msg, err := reviewer.ReviewMessage(ctx, inv)
	if err != nil {
		return fmt.Errorf("reviewer message: %w", err)
	}
	if err := l.runtime.SendMessage(ctx, ports.RuntimeHandle{ID: handleID}, msg); err != nil {
		return fmt.Errorf("notify reviewer: %w", err)
	}
	return nil
}

func (l *agentLauncher) Alive(ctx context.Context, handleID string) (bool, error) {
	if handleID == "" {
		return false, nil
	}
	if alive, handled := l.oneShotAlive(handleID); handled {
		return alive, nil
	}
	return l.runtime.IsAlive(ctx, ports.RuntimeHandle{ID: handleID})
}

func (l *agentLauncher) Cancel(ctx context.Context, handleID string, harness domain.ReviewerHarness) error {
	if handleID == "" {
		return nil
	}
	if handled, err := l.cancelOneShot(ctx, handleID); handled {
		return err
	}
	reviewer, ok := l.reviewers.Reviewer(harness)
	if !ok {
		return fmt.Errorf("no reviewer adapter for harness %q", harness)
	}
	// A daemon restart drops the in-memory one-shot job, but a recovered
	// Greptile terminal still represents a local process/pane that must be
	// destroyed on cancel. Do not fall back to an interrupt that would retain a
	// dead pane for a one-shot reviewer.
	if _, terminal := reviewer.(ports.TerminalOneShotReviewer); terminal {
		return l.runtime.Destroy(ctx, ports.RuntimeHandle{ID: handleID})
	}
	canceller, ok := reviewer.(ports.ReviewerCanceller)
	if !ok {
		return fmt.Errorf("reviewer adapter %q does not support cancellation", harness)
	}
	spec, err := canceller.ReviewCancel(ctx)
	if err != nil {
		return fmt.Errorf("reviewer cancel: %w", err)
	}
	switch spec.Mode {
	case ports.ReviewCancelInterrupt:
		interrupts := spec.Interrupts
		if interrupts <= 0 {
			interrupts = 1
		}
		for i := 0; i < interrupts; i++ {
			if err := l.runtime.Interrupt(ctx, ports.RuntimeHandle{ID: handleID}); err != nil {
				return err
			}
			if i < interrupts-1 {
				timer := time.NewTimer(cancelInterruptDelay)
				select {
				case <-ctx.Done():
					timer.Stop()
					return ctx.Err()
				case <-timer.C:
				}
			}
		}
		return nil
	default:
		return fmt.Errorf("reviewer adapter %q returned unsupported cancel mode %q", harness, spec.Mode)
	}
}
