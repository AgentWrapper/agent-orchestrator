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
	Prompt       string

	// DisplayName is the user-facing sidebar label. Empty falls back to the
	// session id in the read model (e.g. orchestrator sessions).
	DisplayName string
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
