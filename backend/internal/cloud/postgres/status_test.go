package postgres

import (
	"testing"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/contract"
)

func TestDeriveCloudStatusUsesSharedPRContract(t *testing.T) {
	session := clouddomain.Session{ActivityState: string(contract.ActivityIdle)}
	got := deriveCloudStatus(session, []contract.PRFacts{{
		URL:            "https://github.com/example/repo/pull/1",
		CI:             contract.CIPassing,
		Mergeability:   contract.MergeMergeable,
		ReviewComments: true,
	}})
	if got != contract.StatusChangesRequested {
		t.Fatalf("deriveCloudStatus() = %q, want %q", got, contract.StatusChangesRequested)
	}
}

func TestDeriveCloudStatusPreservesActiveTurnPriority(t *testing.T) {
	session := clouddomain.Session{
		ActivityState: string(contract.ActivityIdle),
		ActiveTurn:    &clouddomain.Turn{},
	}
	got := deriveCloudStatus(session, []contract.PRFacts{{URL: "pr", CI: contract.CIFailing}})
	if got != contract.StatusWorking {
		t.Fatalf("deriveCloudStatus() = %q, want %q", got, contract.StatusWorking)
	}
}
