package ports

import (
	"context"
	"errors"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// Reviewer is the contract a code-review adapter satisfies. It is deliberately
// separate from Agent: a reviewer is invoked once over a checkout to review a
// PR, and need not be a prompt-fed interactive agent. A prompt-driven reviewer
// (claude-code) builds its own prompt internally; a one-shot CLI (greptile)
// returns its own argv with no prompt at all.
type Reviewer interface {
	// ReviewCommand builds the command (and any extra env) AO should run to
	// spawn a fresh reviewer over the worker's checkout for a PR.
	ReviewCommand(ctx context.Context, inv ReviewInvocation) (ReviewCommandSpec, error)
	// ReviewMessage builds the text AO injects into an already-running reviewer
	// pane to ask it to review a new commit. It must be self-contained (carry
	// the ids the reviewer needs to submit) since AO passes no environment.
	ReviewMessage(ctx context.Context, inv ReviewInvocation) (string, error)
}

// ReviewerBinaryResolver is the optional capability a reviewer adapter exposes
// when its CLI binary can be checked without launching a review. The result is
// advisory UI metadata; the review launch remains the authoritative check.
type ReviewerBinaryResolver interface {
	ResolveBinary(ctx context.Context) (path string, err error)
}

// ErrReviewerNotAuthenticated is returned when a reviewer auth probe
// conclusively reports that the CLI is signed out or its credentials are
// invalid. Probe failures that cannot distinguish auth from connectivity stay
// advisory and do not use this sentinel.
var ErrReviewerNotAuthenticated = errors.New("reviewer: not authenticated")

// ReviewerAuthChecker is the optional capability a reviewer adapter exposes
// when its CLI has a cheap, non-interactive authentication probe.
type ReviewerAuthChecker interface {
	AuthStatus(ctx context.Context) (AgentAuthStatus, error)
}

// OneShotReviewer is a non-interactive reviewer that exits after emitting one
// machine-readable result. The review launcher owns its subprocess lifecycle
// and feeds the normalized result back through AO's existing review service.
// Interactive reviewers deliberately do not implement this interface.
type OneShotReviewer interface {
	Reviewer
	ParseReviewResult(output []byte) (ReviewResult, error)
}

// TerminalOneShotReviewer is a one-shot reviewer that can run through AO's
// display-only terminal runner. The runner keeps the review visible in the
// same terminal surface as interactive reviewers while the daemon still
// receives structured results from a small result file.
type TerminalOneShotReviewer interface {
	OneShotReviewer
	PrepareTerminalRequest(path string, tasks []ReviewTask) (ReviewCommandSpec, error)
	TerminalResultPath(requestPath string) string
	ParseTerminalResult(output []byte) (TerminalReviewResult, error)
}

// TerminalReviewRequestReader is an optional capability for durable
// output-only reviewers. It lets the launcher recover an AO-owned request
// after a daemon restart without coupling the generic review package to a
// reviewer's private JSON schema.
type TerminalReviewRequestReader interface {
	ReadTerminalRequest(path string) (TerminalReviewRequest, error)
}

// TerminalReviewRequest is the normalized subset of a reviewer's private
// request file needed for restart recovery.
type TerminalReviewRequest struct {
	Version    int
	WorkerID   domain.SessionID
	BatchID    string
	Harness    domain.ReviewerHarness
	ResultPath string
	CreatedAt  time.Time
	DeadlineAt time.Time
	Tasks      []ReviewTask
}

// ReviewResult is the reviewer-neutral result of a one-shot review.
type ReviewResult struct {
	Verdict  domain.ReviewVerdict
	Body     string
	Comments []ReviewComment
}

// ReviewComment is a normalized inline finding emitted by a reviewer.
type ReviewComment struct {
	Path          string
	StartLine     int
	EndLine       int
	Side          string
	Body          string
	Suggestion    string
	Severity      string
	SecurityIssue bool
}

// TerminalReviewResult is the durable result written by a display-only
// one-shot reviewer terminal. Results are written incrementally, so Complete
// is the only field the daemon uses to decide that the whole batch finished.
type TerminalReviewResult struct {
	Complete bool
	Results  []TerminalReviewItem
}

// TerminalReviewItem is one queued review result, or one queued failure.
type TerminalReviewItem struct {
	RunID     string
	PRURL     string
	TargetSHA string
	Verdict   domain.ReviewVerdict
	Body      string
	Comments  []ReviewComment
	Error     string
}

// ReviewCancelMode names how AO should stop a running reviewer.
type ReviewCancelMode string

const (
	// ReviewCancelInterrupt sends the terminal interrupt key sequence to the
	// reviewer process while preserving the terminal pane.
	ReviewCancelInterrupt ReviewCancelMode = "interrupt"
)

// ReviewCancelSpec is the adapter-selected cancellation behavior for a running
// reviewer.
type ReviewCancelSpec struct {
	Mode       ReviewCancelMode
	Interrupts int
}

// ReviewerCanceller is implemented by reviewer adapters that explicitly define
// how their running CLI should be cancelled.
type ReviewerCanceller interface {
	ReviewCancel(ctx context.Context) (ReviewCancelSpec, error)
}

// ReviewInvocation describes one review pass for a reviewer to act on. All ids
// the reviewer needs are passed explicitly here (and embedded in the prompt /
// message), never through environment variables.
type ReviewInvocation struct {
	// ReviewerID is a stable id for the reviewer's runtime instance (pane,
	// native session id), derived from the worker session.
	ReviewerID string
	// RunID is the review_run this pass completes; the reviewer passes it to
	// `ao review submit`.
	RunID string
	// WorkerSessionID is the worker whose PR is under review.
	WorkerSessionID domain.SessionID
	// PRURL is the pull request to review.
	PRURL string
	// TargetSHA is the PR head commit under review.
	TargetSHA string
	// ReviewQueue lists all review tasks created by the same trigger so a shared
	// reviewer pane can review multiple PRs and submit the results together.
	ReviewQueue []ReviewTask
	// ReviewIndex is this invocation's zero-based position in ReviewQueue.
	ReviewIndex int
	// WorkspacePath is the worker's checkout the reviewer reads.
	WorkspacePath string
	// Prompt and SystemPrompt are the review instructions AO authored centrally,
	// mirroring the worker's LaunchConfig.Prompt / SystemPrompt split: SystemPrompt
	// carries the standing reviewer role, Prompt the per-pass task. A prompt-driven
	// adapter (claude-code) feeds them to the agent; a one-shot CLI reviewer may
	// ignore them.
	Prompt       string
	SystemPrompt string
	// SystemPromptFile is the AO-owned file form of SystemPrompt. Reviewer
	// launchers use it to keep standing instructions out of the shared terminal
	// stream while preserving their system-level role in agent harnesses that
	// support prompt files.
	SystemPromptFile string
	// TaskPromptFile is the AO-owned file containing the full per-pass task.
	// Prompt carries only a short reference to this file so the instructions do
	// not enter the shared terminal stream.
	TaskPromptFile string
	// TaskPromptRoot is the stable AO-owned directory containing task prompt
	// files for this reviewer. Adapters use it when a long-lived reviewer needs
	// permission to read request-scoped task files created after launch.
	TaskPromptRoot string
}

// ReviewTask is one PR/run in a multi-PR review trigger queue.
type ReviewTask struct {
	RunID         string
	PRURL         string
	TargetSHA     string
	TargetBranch  string
	WorkspacePath string
}

// ReviewCommandSpec is how to launch a reviewer: the argv and any extra env the
// adapter needs. AO supplies the workspace and review-tracking env around it.
type ReviewCommandSpec struct {
	Argv []string
	Env  map[string]string
}

// ReviewerResolver maps a reviewer harness onto its adapter. ok=false means no
// adapter is registered for that harness.
type ReviewerResolver interface {
	Reviewer(harness domain.ReviewerHarness) (Reviewer, bool)
}
