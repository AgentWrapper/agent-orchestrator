package controllers

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestSessionViewReportsConfiguredObservedProfileDrift(t *testing.T) {
	profile, _ := domain.NewExecutionProfile(domain.AgentConfig{Model: "gpt-5"}, "project_config")
	s := domain.Session{SessionRecord: domain.SessionRecord{Metadata: domain.SessionMetadata{ExecutionProfile: profile, ObservedExecutionProfileHash: "different"}}}
	view := sessionView(s)
	if !view.ExecutionProfileDrift || view.ExecutionProfile.Hash != profile.Hash || view.ObservedExecutionProfileHash != "different" {
		t.Fatalf("view = %#v", view)
	}
	s.Metadata.ObservedExecutionProfileHash = profile.Hash
	if view := sessionView(s); view.ExecutionProfileDrift {
		t.Fatalf("matching profile reported drift: %#v", view)
	}
}
