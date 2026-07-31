package ports

import (
	"errors"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ErrSessionNotFound reports an observation for an unknown session id.
var ErrSessionNotFound = errors.New("session not found")

// SpawnConfig is the request to start a new session: which project/issue, which
// agent harness, and the branch/prompt the agent launches with.
type SpawnConfig struct {
	ProjectID domain.ProjectID
	IssueID   domain.IssueID
	// IssueContext is optional pre-fetched tracker context for the task prompt.
	// Standing rules stay in SystemPrompt; issue facts belong to the user task.
	IssueContext string
	Kind         domain.SessionKind
	Harness      domain.AgentHarness
	Branch       string
	// BaseBranch overrides the base the new session branch is created from. Empty
	// falls back to the project's default branch. The pipeline spawn path sets it
	// to a PR source branch so a fallback derived branch starts at the PR head when
	// the source branch is already checked out in another worktree.
	BaseBranch string
	Prompt     string

	// DisplayName is the user-facing sidebar label. Empty falls back to the
	// session id in the read model (e.g. orchestrator sessions).
	DisplayName string

	// PipelineRunID marks the session as spawned by a pipeline run. It lands on
	// the session's metadata and is read as the pipeline session trigger bridge's
	// loop guard: a pipeline agent going idle must not fire the session
	// pipelines. Empty for every human or orchestrator spawn.
	PipelineRunID string

	// WorkspacePath adopts an existing tree instead of creating a session
	// worktree: the session runs there, and its lifecycle stays with whoever
	// provisioned it. The pipeline driver sets it to the workspace it resolved
	// for the stage, which is what makes `workspace: run` and `inherit` mean
	// something for an agent stage. An adopted tree is never created, restored
	// or destroyed by session teardown; the record carries
	// SessionMetadata.WorkspaceAdopted so every teardown path can see that.
	// Empty is the ordinary path: the session gets, and owns, its own worktree.
	WorkspacePath string

	// Env is extra environment for the spawned session, merged over the
	// project's env vars (an entry here wins on collision, so a caller's
	// ambient identity cannot be masked by project config). AO-internal vars
	// (AO_SESSION_ID and friends) still win over everything. Nil means no
	// extra env.
	Env map[string]string

	// Attachments are images pasted or dropped into the task brief. They are
	// written into the session worktree and referenced by path in the prompt so
	// the agent can read them (CLI agents receive the prompt as text and cannot
	// consume inline binary data).
	Attachments []SpawnAttachment
}

// SpawnAttachment is a single image attached to a spawn request. Data holds the
// already-decoded bytes; the manager derives the on-disk filename.
type SpawnAttachment struct {
	// Ext is the file extension (including the leading dot, e.g. ".png")
	// inferred from the attachment's declared MIME type, or empty when unknown.
	Ext  string
	Data []byte
}
