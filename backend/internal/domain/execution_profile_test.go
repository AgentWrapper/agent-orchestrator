package domain

import (
	"errors"
	"testing"
	"time"
)

func TestExecutionProfileHashDeterministicAndComplete(t *testing.T) {
	config := AgentConfig{Model: "gpt-5", ReasoningEffort: "high", FastMode: true, ReviewModel: "gpt-5-review", AllowNativeSubagents: false}
	a, err := NewExecutionProfile(config, "project_config")
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewExecutionProfile(config, "project_config")
	if err != nil {
		t.Fatal(err)
	}
	if a.Hash == "" || a.Hash != b.Hash {
		t.Fatalf("hashes = %q %q", a.Hash, b.Hash)
	}
	if a.ReviewModelPolicy != ReviewModelExplicit || a.EffectiveReviewModel() != "gpt-5-review" {
		t.Fatalf("review policy = %#v", a)
	}
	a.FastMode = false
	if !errors.Is(a.Validate(), ErrExecutionProfileDrift) {
		t.Fatalf("tampered profile error = %v", a.Validate())
	}
}

func TestExecutionProfileChangeRequiresHumanAuthority(t *testing.T) {
	oldProfile, _ := NewExecutionProfile(AgentConfig{Model: "gpt-5"}, "project_config")
	requested, _ := NewExecutionProfile(AgentConfig{Model: "gpt-5.1", FastMode: true}, "project_config")
	if _, err := AuthorizeExecutionProfileChange("ao-1", oldProfile, requested, "orchestrator", "try fallback", time.Unix(1, 0)); !errors.Is(err, ErrExecutionProfileUnauthorized) {
		t.Fatalf("unauthorized error = %v", err)
	}
	change, err := AuthorizeExecutionProfileChange("ao-1", oldProfile, requested, "human", "operator approved upgrade", time.Unix(2, 0))
	if err != nil {
		t.Fatal(err)
	}
	if change.NewProfile.AuthoritySource != "human" || change.NewProfile.Hash == oldProfile.Hash || change.Reason == "" {
		t.Fatalf("change = %#v", change)
	}
}
