package claudecode

import (
	"context"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// captureAgent is a stub ports.Agent that records the LaunchConfig the reviewer
// builds, so the test asserts the reviewer's tool policy without needing the
// real claude binary on PATH.
type captureAgent struct {
	got ports.LaunchConfig
}

func (a *captureAgent) GetConfigSpec(context.Context) (ports.ConfigSpec, error) {
	return ports.ConfigSpec{}, nil
}
func (a *captureAgent) GetLaunchCommand(_ context.Context, cfg ports.LaunchConfig) ([]string, error) {
	a.got = cfg
	return []string{"claude"}, nil
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

func TestReviewCommandLaunchesReadOnlyOffBypass(t *testing.T) {
	agent := &captureAgent{}
	r := &Reviewer{agent: agent}

	if _, err := r.ReviewCommand(context.Background(), ports.ReviewInvocation{
		ReviewerID:    "review-w1",
		WorkspacePath: "/ws/w1",
		Prompt:        "review it",
		SystemPrompt:  "you are a reviewer",
	}); err != nil {
		t.Fatalf("ReviewCommand: %v", err)
	}

	// The allowlist is what enforces read-only, so it must launch in an
	// explicit non-bypass mode: bypassPermissions ignores allow/deny rules
	// entirely, and an empty mode would defer to a user's defaultMode.
	if agent.got.Permissions != ports.PermissionModeAuto {
		t.Fatalf("reviewer must launch in auto permission mode; got %q", agent.got.Permissions)
	}
	if !contains(agent.got.AllowedTools, "Read") || !contains(agent.got.AllowedTools, "Bash(ao review submit:*)") {
		t.Fatalf("allowlist missing read-only review tools: %#v", agent.got.AllowedTools)
	}
	for _, denied := range []string{"Edit", "Write", "Bash(git push:*)", "Bash(git commit:*)"} {
		if !contains(agent.got.DisallowedTools, denied) {
			t.Fatalf("disallow list missing %q: %#v", denied, agent.got.DisallowedTools)
		}
	}
}

func TestAllowlistCoversPromptRequiredPipedCommands(t *testing.T) {
	agent := &captureAgent{}
	r := &Reviewer{agent: agent}

	if _, err := r.ReviewCommand(context.Background(), ports.ReviewInvocation{
		ReviewerID:    "review-w1",
		WorkspacePath: "/ws/w1",
		Prompt:        "review it",
		SystemPrompt:  "you are a reviewer",
	}); err != nil {
		t.Fatalf("ReviewCommand: %v", err)
	}

	if !contains(agent.got.AllowedTools, "Bash(printf:*)") {
		t.Fatalf("allowlist missing printf for piped review commands: %#v", agent.got.AllowedTools)
	}

	for _, cmd := range []string{
		"printf '%s' '{ \"event\": \"COMMENT\", \"body\": \"x\" }' | gh api --method POST repos/o/r/pulls/1/reviews --input - --jq '.id'",
		"printf '%s' '{ \"reviews\": [] }' | ao review submit --session sess-1 --reviews -",
	} {
		if !compoundCommandCovered(agent.got.AllowedTools, cmd) {
			t.Fatalf("allowlist does not cover prompt-required command %q with tools %#v", cmd, agent.got.AllowedTools)
		}
	}

	disallowed := "printf x | rm -rf /"
	if compoundCommandCovered(agent.got.AllowedTools, disallowed) {
		t.Fatalf("allowlist unexpectedly covers disallowed command %q with tools %#v", disallowed, agent.got.AllowedTools)
	}
}

func compoundCommandCovered(allowedTools []string, cmd string) bool {
	for _, segment := range splitPipedCommand(cmd) {
		if !bashSegmentCovered(allowedTools, segment) {
			return false
		}
	}
	return true
}

func splitPipedCommand(cmd string) []string {
	rawSegments := strings.Split(cmd, "|")
	segments := make([]string, 0, len(rawSegments))
	for _, segment := range rawSegments {
		if trimmed := strings.TrimSpace(segment); trimmed != "" {
			segments = append(segments, trimmed)
		}
	}
	return segments
}

func bashSegmentCovered(allowedTools []string, segment string) bool {
	for _, tool := range allowedTools {
		cmd, ok := strings.CutPrefix(tool, "Bash(")
		if !ok {
			continue
		}
		cmd, ok = strings.CutSuffix(cmd, ":*)")
		if !ok {
			continue
		}
		if strings.HasPrefix(segment, cmd) {
			return true
		}
	}
	return false
}

func contains(values []string, needle string) bool {
	for _, v := range values {
		if v == needle {
			return true
		}
	}
	return false
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
			"expected launch Prompt to be empty so Claude Code doesn't echo it.\n"+
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