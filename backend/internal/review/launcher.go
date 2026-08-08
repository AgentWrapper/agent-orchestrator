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

const defaultReviewerInitialDelay = 500 * time.Millisecond

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
	// live pane (stable per worker, reused across passes) plus any native agent
	// session id known at launch time.
	Spawn(ctx context.Context, spec LaunchSpec) (LaunchResult, error)
	// RestoreTerminal launches an idle reviewer pane for a worker that already
	// has review history, without creating or starting a new review run.
	RestoreTerminal(ctx context.Context, spec LaunchSpec) (LaunchResult, error)
	// Notify asks an already-running reviewer pane to review a new commit.
	Notify(ctx context.Context, handleID string, spec LaunchSpec) error
	// Alive reports whether a reviewer pane is still running.
	Alive(ctx context.Context, handleID string) (bool, error)
	// Reusable reports whether the harness accepts another review task in its
	// existing TUI. Reviewers with launch-fixed context return false.
	Reusable(harness domain.ReviewerHarness) bool
	// Cancel interrupts a running reviewer pane while keeping the terminal alive.
	Cancel(ctx context.Context, handleID string, harness domain.ReviewerHarness) error
	// Destroy tears down a reviewer pane entirely. This is used when the owning
	// worker session itself is torn down, not for user-facing review cancellation.
	Destroy(ctx context.Context, handleID string) error
}

// TerminalReviewRecoverer restores durable output-only reviewer watchers after
// a daemon restart without widening the core Launcher contract.
type TerminalReviewRecoverer interface {
	RecoverTerminalReviews(ctx context.Context) error
}

// LaunchSpec is the engine's request to (re)launch a reviewer for one pass.
type LaunchSpec struct {
	RunID           string
	BatchID         string
	ReviewSessionID string
	WorkerID        domain.SessionID
	ProjectID       domain.ProjectID
	Harness         domain.ReviewerHarness
	WorkspacePath   string
	AgentSessionID  string
	PreviousRuns    []domain.ReviewRun
	PRURL           string
	TargetSHA       string
	ReviewQueue     []ports.ReviewTask
	ReviewIndex     int
}

// LaunchResult is the terminal/runtime state created by a reviewer launch.
type LaunchResult struct {
	HandleID       string
	AgentSessionID string
}

// ReviewCompletion is one asynchronously completed one-shot review.
//
//nolint:revive // the explicit completion type name is part of the launcher API.
type ReviewCompletion struct {
	RunID     string
	PRURL     string
	TargetSHA string
	Verdict   domain.ReviewVerdict
	Body      string
	Comments  []ports.ReviewComment
	Err       error
}

// CompletionHandler receives asynchronously completed one-shot reviews.
type CompletionHandler func(ctx context.Context, workerID domain.SessionID, completions []ReviewCompletion)

// TerminalReviewConsumedChecker reports whether durable terminal results were already consumed.
type TerminalReviewConsumedChecker func(ctx context.Context, workerID domain.SessionID, runIDs []string) bool

// TerminalReviewActiveChecker reports whether recovered terminal review runs remain active.
type TerminalReviewActiveChecker func(ctx context.Context, workerID domain.SessionID, runIDs []string) (bool, error)

// reviewerRuntime is the runtime surface the launcher needs: create a pane,
// inject a message into a running pane, and probe liveness. The tmux runtime
// satisfies it.
type reviewerRuntime interface {
	Create(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error)
	Destroy(ctx context.Context, handle ports.RuntimeHandle) error
	Interrupt(ctx context.Context, handle ports.RuntimeHandle) error
	SendInput(ctx context.Context, handle ports.RuntimeHandle, input string) error
	IsAlive(ctx context.Context, handle ports.RuntimeHandle) (bool, error)
	SendMessage(ctx context.Context, handle ports.RuntimeHandle, message string) error
	GetOutput(ctx context.Context, handle ports.RuntimeHandle, lines int) (string, error)
}

type reviewerTerminalRuntime interface {
	reviewerRuntime
}

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
	auth       agentAuthResolver
	rootCtx    context.Context
	onComplete CompletionHandler
	consumed   TerminalReviewConsumedChecker
	active     TerminalReviewActiveChecker
	execute    oneShotExecutor

	jobsMu    sync.Mutex
	jobs      map[string]oneShotJob
	nextJob   uint64
	recovered map[string]struct{}
}

type preLaunchReviewer interface {
	PreLaunch(ctx context.Context, inv ports.ReviewInvocation) error
}

type preflightReviewer interface {
	ReviewPreflight(ctx context.Context, workspacePath string) error
}

type agentAuthResolver interface {
	AuthStatus(ctx context.Context, harness domain.ReviewerHarness) (ports.AgentAuthStatus, bool, error)
}

// LauncherOption configures reviewer launcher behavior.
type LauncherOption func(*agentLauncher)

// WithAgentAuth lets reviewer preflight reuse the agent auth catalog for the
// same harness. Reviewer-specific auth probes must not be stricter than the
// normal agent's local auth status.
func WithAgentAuth(auth agentAuthResolver) LauncherOption {
	return func(l *agentLauncher) {
		l.auth = auth
	}
}

// WithLauncherContext sets the root context used by asynchronous one-shot reviews.
func WithLauncherContext(ctx context.Context) LauncherOption {
	return func(l *agentLauncher) {
		if ctx != nil {
			l.rootCtx = ctx
		}
	}
}

// WithCompletionHandler configures delivery of asynchronously completed reviews.
func WithCompletionHandler(handler CompletionHandler) LauncherOption {
	return func(l *agentLauncher) { l.onComplete = handler }
}

// WithTerminalReviewConsumed configures the durable-result consumption check.
func WithTerminalReviewConsumed(checker TerminalReviewConsumedChecker) LauncherOption {
	return func(l *agentLauncher) { l.consumed = checker }
}

// WithTerminalReviewActive configures the recovered-run activity check.
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
	if harness == domain.ReviewerGreptile {
		if resolved, resolveErr := resolveReviewerCommand(ctx, reviewer, cmd); resolveErr == nil {
			cmd = resolved
		} else if ctx.Err() != nil {
			return resolveErr
		}
	}
	// Unwrap any leading env KEY=value ... prefix so the real binary is
	// validated. Mirrors launchBinary in the session manager, which already
	// skips the same prefix to validate the worker agent binary.
	bin := cmd.Argv[reviewerCommandBinaryIndex(cmd.Argv)]
	if _, err := exec.LookPath(bin); err != nil {
		if harness == domain.ReviewerGreptile {
			return fmt.Errorf("greptile CLI is not installed (binary not found). Install it, then run greptile login and retry: %w", ports.ErrAgentBinaryNotFound)
		}
		return fmt.Errorf("reviewer binary %q not found: %w: %w", bin, err, ports.ErrAgentBinaryNotFound)
	}
	authStatus, authKnown, err := l.agentAuthStatus(ctx, harness)
	if err != nil {
		return err
	}
	if authKnown && authStatus == ports.AgentAuthStatusUnauthorized {
		return fmt.Errorf("agent auth catalog reports reviewer harness %q is unauthorized", harness)
	}
	if checker, ok := reviewer.(ports.ReviewerAuthChecker); ok {
		status, _ := checker.AuthStatus(ctx)
		if status == ports.AgentAuthStatusUnauthorized {
			if harness == domain.ReviewerGreptile {
				return fmt.Errorf("greptile CLI is not authenticated. Run greptile login and retry: %w", ports.ErrReviewerNotAuthenticated)
			}
			return fmt.Errorf("reviewer %q is not authenticated: %w", harness, ports.ErrReviewerNotAuthenticated)
		}
	}
	if pf, ok := reviewer.(preflightReviewer); ok {
		if err := pf.ReviewPreflight(ctx, workspacePath); err != nil {
			if authKnown && authStatus == ports.AgentAuthStatusAuthorized && looksLikeAuthFailure(err) {
				return nil
			}
			return err
		}
	}
	return nil
}

func (l *agentLauncher) agentAuthStatus(ctx context.Context, harness domain.ReviewerHarness) (ports.AgentAuthStatus, bool, error) {
	if l.auth == nil {
		return "", false, nil
	}
	status, ok, err := l.auth.AuthStatus(ctx, harness)
	if err != nil {
		return "", false, fmt.Errorf("agent auth catalog for reviewer harness %q: %w", harness, err)
	}
	return status, ok, nil
}

func looksLikeAuthFailure(err error) bool {
	msg := strings.ToLower(err.Error())
	for _, token := range []string{"auth", "login", "logged in", "credential", "token", "api key", "unauthor"} {
		if strings.Contains(msg, token) {
			return true
		}
	}
	return false
}

// reviewerHandleID is the stable runtime handle for a worker's reviewer pane, so
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
		AgentSessionID:  spec.AgentSessionID,
		PRURL:           spec.PRURL,
		TargetSHA:       spec.TargetSHA,
		ReviewQueue:     spec.ReviewQueue,
		ReviewIndex:     spec.ReviewIndex,
		WorkspacePath:   spec.WorkspacePath,
		DataDir:         l.dataDir,
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
func (l *agentLauncher) prepareInvocation(ctx context.Context, spec LaunchSpec) (ports.ReviewInvocation, error) {
	if err := ctx.Err(); err != nil {
		return ports.ReviewInvocation{}, err
	}
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
	if err := ctx.Err(); err != nil {
		return ports.ReviewInvocation{}, err
	}
	taskPath := filepath.Join(requestDir, "task.md")
	if err := os.WriteFile(taskPath, []byte(strings.TrimRight(inv.Prompt, "\n")+"\n"), 0o600); err != nil {
		return ports.ReviewInvocation{}, fmt.Errorf("write reviewer task prompt: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return ports.ReviewInvocation{}, err
	}
	systemPath := filepath.Join(promptRoot, "system.md")
	systemPrompt := strings.TrimRight(inv.SystemPrompt, "\n") + "\n\n" +
		"AO stores each review task in an immutable file. Whenever AO asks you to start a review task, " +
		"read the exact file path in that request first and follow it completely.\n"
	if err := os.WriteFile(systemPath, []byte(systemPrompt), 0o600); err != nil {
		return ports.ReviewInvocation{}, fmt.Errorf("write reviewer system prompt: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return ports.ReviewInvocation{}, err
	}
	inv.Prompt = reviewerTaskMessagePrefix + filepath.ToSlash(taskPath) + "`."
	inv.SystemPrompt = ""
	inv.SystemPromptFile = systemPath
	inv.TaskPromptFile = taskPath
	inv.TaskPromptRoot = promptRoot
	return inv, nil
}

func (l *agentLauncher) prepareIdleInvocation(spec LaunchSpec) (ports.ReviewInvocation, error) {
	promptRoot := filepath.Join(l.dataDir, "prompts", string(spec.WorkerID), "reviewer")
	systemPath := filepath.Join(promptRoot, "system.md")
	systemPrompt := reviewSystemPrompt() + "\n\n" +
		"AO may restore your terminal before a new review task exists. In that state, wait for AO to send a review task file path before reviewing or submitting results.\n"
	if err := os.MkdirAll(promptRoot, 0o700); err != nil {
		return ports.ReviewInvocation{}, fmt.Errorf("create reviewer prompt directory: %w", err)
	}
	if err := os.WriteFile(systemPath, []byte(systemPrompt), 0o600); err != nil {
		return ports.ReviewInvocation{}, fmt.Errorf("write reviewer system prompt: %w", err)
	}
	prompt := fmt.Sprintf("Reviewer terminal restored for worker session %s.\n\n%s\n\nWait for AO to send the next review task file path before submitting a new review.", spec.WorkerID, previousReviewHistoryText(spec.PreviousRuns))
	return ports.ReviewInvocation{
		ReviewerID:       reviewerHandleID(spec.WorkerID),
		WorkerSessionID:  spec.WorkerID,
		AgentSessionID:   spec.AgentSessionID,
		WorkspacePath:    spec.WorkspacePath,
		DataDir:          l.dataDir,
		Prompt:           prompt,
		SystemPrompt:     "",
		SystemPromptFile: systemPath,
		TaskPromptRoot:   promptRoot,
	}, nil
}

func previousReviewHistoryText(runs []domain.ReviewRun) string {
	if len(runs) == 0 {
		return "No previous review runs are recorded for this worker session."
	}
	var b strings.Builder
	b.WriteString("Previous review runs for this worker session, newest first:")
	const maxRuns = 20
	for i, run := range runs {
		if i >= maxRuns {
			fmt.Fprintf(&b, "\n* ... %d older review run(s) omitted.", len(runs)-maxRuns)
			break
		}
		fmt.Fprintf(&b, "\n* %s", run.PRURL)
		if run.TargetSHA != "" {
			fmt.Fprintf(&b, " at %s", run.TargetSHA)
		}
		fmt.Fprintf(&b, " - status: %s", run.Status)
		if run.Verdict != "" {
			fmt.Fprintf(&b, ", verdict: %s", run.Verdict)
		}
		if run.GithubReviewID != "" {
			fmt.Fprintf(&b, ", GitHub review: %s", run.GithubReviewID)
		}
		body := strings.TrimSpace(run.Body)
		if body != "" {
			fmt.Fprintf(&b, "\n  Body: %s", truncateReviewHistoryBody(body))
		}
	}
	return b.String()
}

func truncateReviewHistoryBody(body string) string {
	const maxBody = 1200
	body = strings.Join(strings.Fields(body), " ")
	if len(body) <= maxBody {
		return body
	}
	return strings.TrimSpace(body[:maxBody]) + "..."
}

func (l *agentLauncher) Spawn(ctx context.Context, spec LaunchSpec) (LaunchResult, error) {
	reviewer, ok := l.reviewers.Reviewer(spec.Harness)
	if !ok {
		return LaunchResult{}, fmt.Errorf("no reviewer adapter for harness %q", spec.Harness)
	}
	if oneShot, ok := reviewer.(ports.OneShotReviewer); ok {
		return l.startOneShot(spec, oneShot)
	}
	inv, err := l.prepareInvocation(ctx, spec)
	if err != nil {
		return LaunchResult{}, err
	}
	return l.launchReviewerTerminal(ctx, spec, inv)
}

func (l *agentLauncher) RestoreTerminal(ctx context.Context, spec LaunchSpec) (LaunchResult, error) {
	if reviewer, ok := l.reviewers.Reviewer(spec.Harness); ok {
		if _, oneShot := reviewer.(ports.OneShotReviewer); oneShot {
			return LaunchResult{}, nil
		}
	}
	inv, err := l.prepareIdleInvocation(spec)
	if err != nil {
		return LaunchResult{}, err
	}
	return l.launchReviewerTerminalWithMode(ctx, spec, inv, true)
}

func (l *agentLauncher) launchReviewerTerminal(ctx context.Context, spec LaunchSpec, inv ports.ReviewInvocation) (LaunchResult, error) {
	return l.launchReviewerTerminalWithMode(ctx, spec, inv, false)
}

func (l *agentLauncher) launchReviewerTerminalWithMode(ctx context.Context, spec LaunchSpec, inv ports.ReviewInvocation, restoring bool) (LaunchResult, error) {
	reviewer, ok := l.reviewers.Reviewer(spec.Harness)
	if !ok {
		return LaunchResult{}, fmt.Errorf("no reviewer adapter for harness %q", spec.Harness)
	}
	if pl, ok := reviewer.(preLaunchReviewer); ok {
		if err := pl.PreLaunch(ctx, inv); err != nil {
			return LaunchResult{}, fmt.Errorf("reviewer pre-launch: %w", err)
		}
	}
	var cmd ports.ReviewCommandSpec
	if restoring {
		if restorer, ok := reviewer.(ports.ReviewerRestorer); ok {
			restoreCmd, restoreOK, err := restorer.ReviewRestoreCommand(ctx, inv)
			if err != nil {
				return LaunchResult{}, fmt.Errorf("reviewer restore command: %w", err)
			}
			if restoreOK {
				cmd = restoreCmd
			}
		}
	}
	if len(cmd.Argv) == 0 {
		var err error
		cmd, err = reviewer.ReviewCommand(ctx, inv)
		if err != nil {
			return LaunchResult{}, fmt.Errorf("reviewer command: %w", err)
		}
	}
	if spec.Harness == domain.ReviewerGreptile {
		if resolved, resolveErr := resolveReviewerCommand(ctx, reviewer, cmd); resolveErr == nil {
			cmd = resolved
		} else if ctx.Err() != nil {
			return LaunchResult{}, resolveErr
		}
	}
	handleID := reviewerHandleID(spec.WorkerID)
	// The reviewer handle is stable per worker, so a still-live pane from a
	// previous pass would otherwise block `tmux new-session` (duplicate name) or,
	// worse, keep serving under its old harness. Destroy any stale pane on this
	// handle first so the reviewer always (re)launches under spec.Harness's
	// sandbox/permissions/env — which are applied only here at Create, never by
	// Notify. Destroy is idempotent when no pane exists (first spawn / dead pane).
	if err := l.runtime.Destroy(ctx, ports.RuntimeHandle{ID: handleID}); err != nil {
		return LaunchResult{}, fmt.Errorf("reviewer replace stale pane: %w", err)
	}
	workingDirectory := cmd.WorkingDirectory
	if workingDirectory == "" {
		workingDirectory = spec.WorkspacePath
	}
	handle, err := l.runtime.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID(handleID),
		WorkspacePath: workingDirectory,
		Argv:          cmd.Argv,
		Env:           l.runtimeEnv(ctx, spec, cmd.Argv, cmd.Env),
	})
	if err != nil {
		return LaunchResult{}, fmt.Errorf("reviewer runtime: %w", err)
	}
	if cmd.InitialMessage != "" {
		if err := l.waitForPromptReadiness(ctx, reviewer, handle); err != nil {
			return LaunchResult{}, fmt.Errorf("reviewer prompt readiness: %w", err)
		}
		if err := l.runtime.SendMessage(ctx, handle, cmd.InitialMessage); err != nil {
			return LaunchResult{}, fmt.Errorf("reviewer initial message: %w", err)
		}
	}
	agentSessionID := strings.TrimSpace(cmd.AgentSessionID)
	if agentSessionID == "" {
		agentSessionID = strings.TrimSpace(spec.AgentSessionID)
	}
	return LaunchResult{HandleID: handle.ID, AgentSessionID: agentSessionID}, nil
}

func (l *agentLauncher) waitForPromptReadiness(ctx context.Context, reviewer ports.Reviewer, handle ports.RuntimeHandle) error {
	hints := ports.PromptReadinessHints{InitialDelay: defaultReviewerInitialDelay}
	if provider, ok := reviewer.(ports.ReviewerPromptReadinessProvider); ok {
		provided, err := provider.ReviewPromptReadinessHints(ctx)
		if err != nil {
			return err
		}
		hints = provided
	}
	if hints.InitialDelay > 0 {
		timer := time.NewTimer(hints.InitialDelay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	if len(hints.Patterns) == 0 || hints.Timeout <= 0 {
		return nil
	}
	poll := hints.PollInterval
	if poll <= 0 {
		poll = 200 * time.Millisecond
	}
	lines := hints.Lines
	if lines <= 0 {
		lines = 80
	}
	deadline := time.NewTimer(hints.Timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(poll)
	defer ticker.Stop()
	for {
		output, err := l.runtime.GetOutput(ctx, handle, lines)
		if err == nil && outputContainsAny(output, hints.Patterns) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			// Readiness is best-effort: never block a review forever when a CLI
			// changes its prompt marker. The startup delay still prevents an
			// immediate write into process initialization.
			return nil
		case <-ticker.C:
		}
	}
}

func outputContainsAny(output string, patterns []string) bool {
	for _, pattern := range patterns {
		if pattern != "" && strings.Contains(output, pattern) {
			return true
		}
	}
	return false
}

func (l *agentLauncher) runtimeEnv(ctx context.Context, spec LaunchSpec, argv []string, base map[string]string) map[string]string {
	env := make(map[string]string, len(base)+3)
	for k, v := range base {
		env[k] = v
	}
	delete(env, sessionmanager.EnvSessionID)
	env["AO_REVIEW_SESSION_ID"] = spec.ReviewSessionID
	env["AO_REVIEW_WORKER_SESSION_ID"] = string(spec.WorkerID)
	env["AO_REVIEW_HARNESS"] = string(spec.Harness)
	env[sessionmanager.EnvProjectID] = string(spec.ProjectID)
	env[sessionmanager.EnvDataDir] = l.dataDir
	path, err := sessionmanager.HookPATH(os.Executable, os.Getenv, env)
	if err == nil {
		env["PATH"] = path
	}
	sessionmanager.AugmentRuntimePATHForLaunchBinary(ctx, env, argv, exec.LookPath)
	return env
}

func (l *agentLauncher) Notify(ctx context.Context, handleID string, spec LaunchSpec) error {
	reviewer, ok := l.reviewers.Reviewer(spec.Harness)
	if !ok {
		return fmt.Errorf("no reviewer adapter for harness %q", spec.Harness)
	}
	if oneShot, ok := reviewer.(ports.OneShotReviewer); ok {
		if err := l.Preflight(ctx, spec.Harness, spec.WorkspacePath); err != nil {
			return err
		}
		_, err := l.startOneShot(spec, oneShot)
		return err
	}
	inv, err := l.prepareInvocation(ctx, spec)
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

func (l *agentLauncher) Reusable(harness domain.ReviewerHarness) bool {
	reviewer, ok := l.reviewers.Reviewer(harness)
	if !ok {
		return false
	}
	policy, ok := reviewer.(ports.ReviewerReusePolicy)
	return !ok || policy.ReviewProcessReusable()
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
	case ports.ReviewCancelMessage:
		message := strings.TrimSpace(spec.Message)
		if message == "" {
			return fmt.Errorf("reviewer adapter %q returned empty cancel message", harness)
		}
		return l.runtime.SendMessage(ctx, ports.RuntimeHandle{ID: handleID}, message)
	case ports.ReviewCancelInput:
		inputs := spec.Inputs
		if len(inputs) == 0 && spec.Input != "" {
			inputs = []string{spec.Input}
		}
		if len(inputs) == 0 {
			return fmt.Errorf("reviewer adapter %q returned empty cancel input", harness)
		}
		for i, input := range inputs {
			if input == "" {
				return fmt.Errorf("reviewer adapter %q returned empty cancel input", harness)
			}
			if err := l.runtime.SendInput(ctx, ports.RuntimeHandle{ID: handleID}, input); err != nil {
				return err
			}
			if i < len(inputs)-1 && spec.InputDelay > 0 {
				timer := time.NewTimer(spec.InputDelay)
				select {
				case <-ctx.Done():
					timer.Stop()
					return ctx.Err()
				case <-timer.C:
				}
			}
		}
		return nil
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

func (l *agentLauncher) Destroy(ctx context.Context, handleID string) error {
	if handleID == "" {
		return nil
	}
	if handled, err := l.cancelOneShot(ctx, handleID); handled {
		return err
	}
	return l.runtime.Destroy(ctx, ports.RuntimeHandle{ID: handleID})
}

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
