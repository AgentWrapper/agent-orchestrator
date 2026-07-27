package ports

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// CandidateRunExecutionProfile is the exact coding-worker profile admitted for
// a candidate run. It contains no credential material.
type CandidateRunExecutionProfile struct {
	Harness        domain.AgentHarness
	Model          string
	Effort         string
	Sandbox        string
	ApprovalPolicy string
}

// CandidateRunClaimRequest identifies the tracker task AO is about to claim.
// RequestedBranch may be empty; a non-empty value must match the prepared task.
type CandidateRunClaimRequest struct {
	ProjectID       domain.ProjectID
	IssueID         domain.IssueID
	RequestedBranch string
}

// CandidateRunClaim is the synchronous observer acknowledgement AO must obtain
// before it creates a session row or allocates a worktree.
type CandidateRunClaim struct {
	Slot                 string
	ClaimID              string
	ControllerInstanceID string
	Repository           string
	IssueNumber          int
	Branch               string
	AllocationKey        string
	IdempotencyKey       string
	SourceWriterMode     string
}

// CandidateRunAllocationReceipt is the complete AO-native allocation identity
// recorded after worktree creation and before provisioning or runtime launch.
type CandidateRunAllocationReceipt struct {
	SchemaVersion   int     `json:"schemaVersion"`
	Slot            string  `json:"slot"`
	AllocationKey   string  `json:"allocationKey"`
	ClaimID         string  `json:"claimId"`
	RuntimeTaskID   string  `json:"runtimeTaskId"`
	RuntimeHostID   *string `json:"runtimeHostId"`
	Workspace       string  `json:"workspace"`
	RequestedBranch string  `json:"requestedBranch"`
	SourceWriter    string  `json:"sourceWriter"`
	AllocatedAt     string  `json:"allocatedAt"`
}

// RuntimeStopProof binds a destroyed runtime process to the complete set of
// descendants observed at teardown and proves none remain running.
type RuntimeStopProof struct {
	ProcessID          string
	DescendantIDs      []string
	DescendantsRunning int
}

// RuntimeStopProver is an optional runtime capability required by admitted
// candidate runs. Normal AO sessions may continue using Runtime.Destroy.
type RuntimeStopProver interface {
	DestroyWithProof(ctx context.Context, handle RuntimeHandle) (RuntimeStopProof, error)
}

// CandidateRunClaimer is the pre-allocation portion of the candidate-run
// observer boundary.
type CandidateRunClaimer interface {
	ExecutionProfile() CandidateRunExecutionProfile
	Claim(ctx context.Context, request CandidateRunClaimRequest) (CandidateRunClaim, error)
}

// CandidateRunStarter records the AO-native allocation and runtime start
// boundary. Each call is synchronous and fail-closed.
type CandidateRunStarter interface {
	CandidateRunClaimer
	RecordAllocation(ctx context.Context, claim CandidateRunClaim, sessionID domain.SessionID, workspace string) error
	RecordSessionStartRequested(ctx context.Context, sessionID domain.SessionID) error
	RecordSessionStarted(ctx context.Context, sessionID domain.SessionID) error
	RecordPullRequest(ctx context.Context, sessionID domain.SessionID, observation SCMObservation) error
	RecordStopped(ctx context.Context, sessionID domain.SessionID, reason string, proof RuntimeStopProof) error
}
