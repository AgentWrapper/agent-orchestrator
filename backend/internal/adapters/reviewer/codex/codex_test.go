package codex

import (
	"context"
	"slices"
	"testing"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

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

func TestReviewCommandUsesReadOnlySandbox(t *testing.T) {
	t.Setenv("AO_PORT", "3103")
	t.Setenv("AO_DATA_DIR", "/tmp/ao data")
	t.Setenv("AO_RUN_FILE", "/tmp/ao data/running.json")
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

	want := []string{
		"agent",
		"--sandbox", "read-only",
		"-c", `shell_environment_policy.set.AO_PORT="3103"`,
		"-c", `shell_environment_policy.set.AO_DATA_DIR="/tmp/ao data"`,
		"-c", `shell_environment_policy.set.AO_RUN_FILE="/tmp/ao data/running.json"`,
		"--", "",
	}
	if !slices.Equal(got.Argv, want) {
		t.Fatalf("argv = %#v, want %#v", got.Argv, want)
	}
	if agent.got.Permissions != ports.PermissionModeAuto {
		t.Fatalf("permissions = %q, want auto", agent.got.Permissions)
	}
	if agent.got.SystemPrompt != "review only\n\nreview it" {
		t.Fatalf("system prompt = %q", agent.got.SystemPrompt)
	}
}

func TestReviewMessageReturnsTaskPrompt(t *testing.T) {
	got, err := (&Reviewer{}).ReviewMessage(context.Background(), ports.ReviewInvocation{Prompt: "next review"})
	if err != nil {
		t.Fatalf("ReviewMessage: %v", err)
	}
	if got != "next review" {
		t.Fatalf("message = %q", got)
	}
}


func TestReviewCommandMovesInitialPromptToSystemPrompt(t *testing.T) {
	agent := &captureAgent{}
	r := &Reviewer{agent: agent}

	inv := ports.ReviewInvocation{
		ReviewerID:    "review-w1",
		WorkspacePath: "/ws/w1",
		Prompt:        "Review the requested pull request for worker session worker-123",
		SystemPrompt:  "You are an AO reviewer.",
	}

	if _, err := r.ReviewCommand(context.Background(), inv); err != nil {
		t.Fatalf("ReviewCommand returned error: %v", err)
	}

	// Initial prompt must be hidden from the terminal.
	if agent.got.Prompt != "" {
		t.Fatalf(
			"expected launch Prompt to be empty so Codex doesn't echo it.\n"+
				"Expected: %q\nActual:   %q",
			"",
			agent.got.Prompt,
		)
	}

	// The hidden system prompt should contain BOTH pieces of information.
	expectedSystemPrompt := combineSystemPrompt(inv.SystemPrompt, inv.Prompt)

	if agent.got.SystemPrompt != expectedSystemPrompt {
		t.Fatalf(
			"unexpected SystemPrompt passed to GetLaunchCommand.\n\n"+
				"Expected:\n%s\n\n"+
				"Actual:\n%s",
			expectedSystemPrompt,
			agent.got.SystemPrompt,
		)
	}

	// Ensure the reviewer instructions weren't lost.
	if !strings.Contains(agent.got.SystemPrompt, inv.SystemPrompt) {
		t.Fatalf(
			"reviewer instructions disappeared from SystemPrompt.\n\n"+
				"Expected to contain:\n%s\n\n"+
				"Actual:\n%s",
			inv.SystemPrompt,
			agent.got.SystemPrompt,
		)
	}

	// Ensure the review task is still delivered.
	if !strings.Contains(agent.got.SystemPrompt, inv.Prompt) {
		t.Fatalf(
			"review task disappeared from SystemPrompt.\n\n"+
				"Expected to contain:\n%s\n\n"+
				"Actual:\n%s",
			inv.Prompt,
			agent.got.SystemPrompt,
		)
	}

	// Ensure the prompt wasn't duplicated.
	if strings.Count(agent.got.SystemPrompt, inv.Prompt) != 1 {
		t.Fatalf(
			"review task should appear exactly once in SystemPrompt.\n\n"+
				"SystemPrompt:\n%s",
			agent.got.SystemPrompt,
		)
	}

	// ReviewMessage must continue returning the prompt for re-review.
	msg, err := r.ReviewMessage(context.Background(), inv)
	if err != nil {
		t.Fatalf("ReviewMessage returned error: %v", err)
	}

	if msg != inv.Prompt {
		t.Fatalf(
			"ReviewMessage must still return the review prompt.\n"+
				"Expected: %q\nActual:   %q",
			inv.Prompt,
			msg,
		)
	}
}