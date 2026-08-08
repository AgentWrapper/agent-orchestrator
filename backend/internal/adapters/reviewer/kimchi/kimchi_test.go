package kimchi

import (
	"context"
	"slices"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// captureAgent is a ports.Agent stub that records the LaunchConfig handed to
// GetLaunchCommand and returns a deterministic argv.
type captureAgent struct {
	got ports.LaunchConfig
}

func (a *captureAgent) GetConfigSpec(context.Context) (ports.ConfigSpec, error) {
	return ports.ConfigSpec{}, nil
}
func (a *captureAgent) GetLaunchCommand(_ context.Context, cfg ports.LaunchConfig) ([]string, error) {
	a.got = cfg
	return []string{"agent", "--", cfg.Prompt}, nil
}
func (a *captureAgent) GetPromptDeliveryStrategy(context.Context, ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	return ports.PromptDeliveryInCommand, nil
}
func (a *captureAgent) GetAgentHooks(context.Context, ports.WorkspaceHookConfig) error { return nil }
func (a *captureAgent) GetRestoreCommand(context.Context, ports.RestoreConfig) ([]string, bool, error) {
	return nil, false, nil
}
func (a *captureAgent) SessionInfo(context.Context, ports.SessionRef) (ports.SessionInfo, bool, error) {
	return ports.SessionInfo{}, false, nil
}

func TestReviewCommandUsesAutoPermissions(t *testing.T) {
	agent := &captureAgent{}
	r := &Reviewer{agent: agent}

	_, err := r.ReviewCommand(context.Background(), ports.ReviewInvocation{
		ReviewerID:    "review-w1",
		WorkspacePath: "/ws/w1",
		Prompt:        "review it",
		SystemPrompt:  "review only",
	})
	if err != nil {
		t.Fatalf("ReviewCommand: %v", err)
	}

	if agent.got.Permissions != ports.PermissionModeAuto {
		t.Fatalf("permissions = %q, want %q (reviewers must not run in bypass mode)",
			agent.got.Permissions, ports.PermissionModeAuto)
	}
}

func TestReviewCommandPassesPromptAndSystemPrompt(t *testing.T) {
	agent := &captureAgent{}
	r := &Reviewer{agent: agent}

	_, err := r.ReviewCommand(context.Background(), ports.ReviewInvocation{
		ReviewerID:    "review-w1",
		WorkspacePath: "/ws/w1",
		Prompt:        "review the diff",
		SystemPrompt:  "you are a reviewer",
	})
	if err != nil {
		t.Fatalf("ReviewCommand: %v", err)
	}

	if agent.got.Prompt != "review the diff" {
		t.Fatalf("prompt = %q, want %q", agent.got.Prompt, "review the diff")
	}
	if agent.got.SystemPrompt != "you are a reviewer" {
		t.Fatalf("system prompt = %q, want %q", agent.got.SystemPrompt, "you are a reviewer")
	}
}

func TestReviewCommandReturnsArgv(t *testing.T) {
	agent := &captureAgent{}
	r := &Reviewer{agent: agent}

	got, err := r.ReviewCommand(context.Background(), ports.ReviewInvocation{
		ReviewerID:    "review-w1",
		WorkspacePath: "/ws/w1",
		Prompt:        "review it",
		SystemPrompt:  "review only",
	})
	if err != nil {
		t.Fatalf("ReviewCommand: %v", err)
	}

	want := []string{"agent", "--", "review it"}
	if !slices.Equal(got.Argv, want) {
		t.Fatalf("argv = %#v, want %#v", got.Argv, want)
	}
}

func TestReviewMessageReturnsTaskPrompt(t *testing.T) {
	got, err := (&Reviewer{}).ReviewMessage(context.Background(), ports.ReviewInvocation{Prompt: "next review"})
	if err != nil {
		t.Fatalf("ReviewMessage: %v", err)
	}
	if got != "next review" {
		t.Fatalf("message = %q, want %q", got, "next review")
	}
}

func TestReviewCancelUsesInterrupt(t *testing.T) {
	got, err := (&Reviewer{}).ReviewCancel(context.Background())
	if err != nil {
		t.Fatalf("ReviewCancel: %v", err)
	}
	if got.Mode != ports.ReviewCancelInterrupt {
		t.Fatalf("mode = %q, want %q", got.Mode, ports.ReviewCancelInterrupt)
	}
	if got.Interrupts != 2 {
		t.Fatalf("interrupts = %d, want 2", got.Interrupts)
	}
}
