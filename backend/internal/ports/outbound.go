package ports

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// PRWriter records the PR facts a PR observation carries. The pr table's own DB
// triggers emit the CDC; this just writes the rows.
type PRWriter interface {
	// WritePR persists a full PR observation — scalar facts, check runs, and the
	// replacement comment set — in one transaction, so the rows and the CDC
	// events they emit are all-or-nothing.
	WritePR(ctx context.Context, pr domain.PullRequest, checks []domain.PullRequestCheck, comments []domain.PullRequestComment) error
}

// ReviewWriteMode describes how an SCM observation should update normalized
// review-thread/comment rows.
type ReviewWriteMode int

const (
	// ReviewWritePreserve leaves stored review rows untouched. Metadata/CI-only
	// refreshes and failed review fetches use this mode.
	ReviewWritePreserve ReviewWriteMode = iota
	// ReviewWriteReplace treats the fetched review rows as a complete snapshot
	// and replaces all stored review rows for the PR.
	ReviewWriteReplace
	// ReviewWriteMerge treats the fetched review rows as a partial window:
	// fetched threads/comments are updated while older unseen rows are preserved.
	ReviewWriteMerge
)

// SCMWriter records provider-neutral SCM observations. reviewMode decides
// whether review facts are preserved, replaced with a complete snapshot, or
// merged as a bounded partial window.
type SCMWriter interface {
	WriteSCMObservation(ctx context.Context, pr domain.PullRequest, checks []domain.PullRequestCheck, reviews []domain.PullRequestReview, threads []domain.PullRequestReviewThread, comments []domain.PullRequestComment, reviewMode ReviewWriteMode) error
}

// PRClaimer atomically moves (or creates) a PR row for a target session and
// persists the live SCM facts observed for that PR in the same transaction.
type PRClaimer interface {
	ClaimPR(ctx context.Context, pr domain.PullRequest, checks []domain.PullRequestCheck, reviews []domain.PullRequestReview, threads []domain.PullRequestReviewThread, comments []domain.PullRequestComment, reviewMode ReviewWriteMode, allowActiveTakeover bool) (ClaimOutcome, error)
}

// ErrPRClaimedByActiveSession is returned by PRClaimer.ClaimPR when takeover is
// explicitly disallowed and the existing owner is still alive.
var ErrPRClaimedByActiveSession = errors.New("pr claimed by active session")

// PRClaimedByActiveSessionError carries the active owner that blocked a claim.
type PRClaimedByActiveSessionError struct {
	Owner domain.SessionID
}

func (e PRClaimedByActiveSessionError) Error() string {
	return fmt.Sprintf("%s: %s", ErrPRClaimedByActiveSession, e.Owner)
}

func (e PRClaimedByActiveSessionError) Unwrap() error { return ErrPRClaimedByActiveSession }

// ClaimOutcome describes what owner, if any, a successful claim replaced.
type ClaimOutcome struct {
	PreviousOwner   domain.SessionID
	OwnerTerminated bool
}

// AgentMessenger injects a message into a running agent.
type AgentMessenger interface {
	Send(ctx context.Context, id domain.SessionID, message string) error
}

// ---- runtime / agent / workspace plugin ports ----

// Runtime is the full runtime adapter contract: session creation/teardown plus
// liveness probing for reapers and terminal attachment.
type Runtime interface {
	Create(ctx context.Context, cfg RuntimeConfig) (RuntimeHandle, error)
	Destroy(ctx context.Context, handle RuntimeHandle) error
	IsAlive(ctx context.Context, handle RuntimeHandle) (bool, error)
}

// RuntimeConfig is the spec for launching a session's process in a Runtime.
// Argv is the agent's launch command as discrete arguments; each Runtime
// shell-quotes it for its own shell, so the command survives args with spaces
// (e.g. a prompt) without the caller guessing the target shell's quoting.
type RuntimeConfig struct {
	SessionID     domain.SessionID
	WorkspacePath string
	Argv          []string
	Env           map[string]string
}

// RuntimeHandle identifies a live runtime instance. Its ID is opaque outside
// the concrete runtime adapter.
type RuntimeHandle struct {
	ID string
}

// Stream is one live terminal attach: PTY-like bytes plus resize. Returned
// already-open by a Runtime's Attach. tmux backs it with a local PTY around
// their attach CLI; conpty backs it with a loopback connection to the pty-host.
type Stream interface {
	io.ReadWriteCloser
	Resize(rows, cols uint16) error
}

// Attacher opens a fresh attach Stream for a session handle, sized rows x cols from
// birth (0 means size not yet known). ctx cancellation must terminate the stream.
type Attacher interface {
	Attach(ctx context.Context, handle RuntimeHandle, rows, cols uint16) (Stream, error)
}

// The Agent port and its supporting types live in agent.go.

// Workspace is the isolated checkout an agent works in (a git worktree or clone).
type Workspace interface {
	Create(ctx context.Context, cfg WorkspaceConfig) (WorkspaceInfo, error)
	Destroy(ctx context.Context, info WorkspaceInfo) error
	Restore(ctx context.Context, cfg WorkspaceConfig) (WorkspaceInfo, error)
	// ForceDestroy removes the worktree unconditionally, bypassing the
	// dirty-worktree refusal that Destroy enforces. It is only safe to call
	// AFTER the session's uncommitted work has been captured via StashUncommitted.
	// Never call it from interactive teardown paths.
	ForceDestroy(ctx context.Context, info WorkspaceInfo) error
	// StashUncommitted captures all uncommitted work in the worktree as a git
	// commit object stored at refs/ao/preserved/<session-id>, WITHOUT mutating
	// the working tree or the global stash stack. Tracked edits and new
	// non-ignored files are captured; .gitignore-d files are skipped (the count
	// of skipped ignored paths is logged). Returns the ref name on success, or
	// an empty string if the worktree is clean (nothing to preserve).
	StashUncommitted(ctx context.Context, info WorkspaceInfo) (ref string, err error)
	// ApplyPreserved replays a capture created by StashUncommitted onto the
	// worktree identified by info. On clean success the preserve ref is deleted.
	// On conflict, the ref is kept, conflict markers are left in the working
	// tree, and ErrPreservedConflict (wrapped) is returned. The ref must never
	// be deleted on a failed or conflicted apply.
	ApplyPreserved(ctx context.Context, info WorkspaceInfo, ref string) error
}

// Workspace-level sentinels surfaced through Create/Restore/Destroy so callers
// can map them to typed errors rather than collapsing every adapter failure
// into an opaque 500. Adapters wrap these via fmt.Errorf("...: %w", sentinel).
var (
	// ErrWorkspaceBranchCheckedOutElsewhere reports the requested branch is
	// already checked out in another worktree of the same repo.
	ErrWorkspaceBranchCheckedOutElsewhere = errors.New("workspace: branch is already checked out in another worktree")
	// ErrWorkspaceBranchNotFetched reports the requested branch exists nowhere
	// reachable (no local head, no remote-tracking branch, no tag).
	ErrWorkspaceBranchNotFetched = errors.New("workspace: branch is not fetched")
	// ErrWorkspaceBranchInvalid reports the requested branch name is not a valid
	// git ref (rejected by `git check-ref-format`).
	ErrWorkspaceBranchInvalid = errors.New("workspace: invalid branch name")
	// ErrWorkspaceDirty reports Destroy refused to remove a workspace because
	// it holds uncommitted changes or untracked files. Teardown is never
	// forced; callers treat the workspace as intentionally preserved.
	ErrWorkspaceDirty = errors.New("workspace: uncommitted changes present")
	// ErrPreservedConflict is returned by ApplyPreserved when replaying a
	// preserved ref onto the worktree produces merge conflicts. The ref is
	// kept intact (never deleted on conflict); the working tree is left with
	// conflict markers for manual resolution. Adapters wrap this sentinel via
	// fmt.Errorf so callers can match it with errors.Is.
	ErrPreservedConflict = errors.New("workspace: preserved apply produced conflicts")
	// ErrRuntimePrerequisite reports a missing host prerequisite for the selected
	// runtime before a session can be created.
	ErrRuntimePrerequisite = errors.New("runtime: prerequisite missing")
)

// WorkspaceConfig is the spec for creating or restoring a session's workspace.
type WorkspaceConfig struct {
	ProjectID domain.ProjectID
	SessionID domain.SessionID
	Kind      domain.SessionKind
	// SessionPrefix is the human-readable project prefix used to name the
	// orchestrator worktree. Defaults to a truncation of ProjectID when empty.
	SessionPrefix string
	Branch        string
	// BaseBranch is the per-project default branch new session branches are
	// created from. Empty falls back to the workspace adapter's own default.
	BaseBranch string
}

// WorkspaceInfo describes a created workspace — where it lives and its branch.
type WorkspaceInfo struct {
	Path      string
	Branch    string
	SessionID domain.SessionID
	ProjectID domain.ProjectID
}
