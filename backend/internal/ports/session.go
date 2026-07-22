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
}
