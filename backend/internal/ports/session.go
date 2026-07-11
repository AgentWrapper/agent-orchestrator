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
	// IssueTitle is the tracker title for IssueID when the daemon already has
	// it (for example tracker intake). It feeds daemon-owned semantic naming but
	// is not delivered to the worker prompt.
	IssueTitle string
	Kind       domain.SessionKind
	Harness    domain.AgentHarness
	Branch     string
	Prompt     string
	Model      string
	// IntakePoolBypass marks tracker-intake workers that should not consume the
	// normal per-project intake pool/cap.
	IntakePoolBypass bool
	// Force overrides the fleet-pause admission guard so a deliberate manual
	// spawn (`ao spawn --force`) can start a worker on a paused project.
	Force bool
	// DisplayName is the user-facing sidebar label. Empty falls back to the
	// session id in the read model (e.g. orchestrator sessions).
	DisplayName string
}
