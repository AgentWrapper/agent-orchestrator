package kimchi

import (
	"context"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// captureAgent is a stub ports.Agent that records the LaunchConfig the reviewer
// builds, so the test asserts the reviewer's tool policy without needing the
// real kimchi binary on PATH.
type captureAgent struct {
	got ports.LaunchConfig
}

func (a *captureAgent) GetConfigSpec(context.Context) (ports.ConfigSpec, error) {
	return ports.ConfigSpec{}, nil
}
func (a *captureAgent) GetLaunchCommand(_ context.Context, cfg ports.LaunchConfig) ([]string, error) {
	a.got = cfg
	return []string{"kimchi"}, nil
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
	// explicit non-bypass mode: --yolo (bypassPermissions) ignores allow/deny
	// rules entirely, and an empty mode would defer to Kimchi's default.
	if agent.got.Permissions != ports.PermissionModeAuto {
		t.Fatalf("reviewer must launch in auto permission mode; got %q", agent.got.Permissions)
	}
	if !contains(agent.got.AllowedTools, "read") || !contains(agent.got.AllowedTools, "bash(ao review submit:*)") {
		t.Fatalf("allowlist missing read-only review tools: %#v", agent.got.AllowedTools)
	}
	for _, denied := range []string{
		"edit",
		"write",
		"bash(git push:*)",
		"bash(git commit:*)",
		"bash(git show:*)",
		"bash(gh:*)",
	} {
		if !contains(agent.got.DisallowedTools, denied) {
			t.Fatalf("disallow list missing %q: %#v", denied, agent.got.DisallowedTools)
		}
	}
}

func TestAllowlistExcludesWriteAndExfilTools(t *testing.T) {
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

	// printf, gh, and git show must NOT be in the allow list — printf is a
	// write primitive, gh exposes the full mutation surface, and git show can
	// read arbitrary tracked content.
	for _, tool := range []string{"bash(printf:*)", "bash(gh:*)", "bash(git show:*)"} {
		if contains(agent.got.AllowedTools, tool) {
			t.Fatalf("allowlist unexpectedly contains %q: %#v", tool, agent.got.AllowedTools)
		}
	}

	// gh and git show must be in the deny list as defense in depth.
	for _, denied := range []string{"bash(gh:*)", "bash(git show:*)"} {
		if !contains(agent.got.DisallowedTools, denied) {
			t.Fatalf("disallow list missing %q: %#v", denied, agent.got.DisallowedTools)
		}
	}

	// The reviewer can still submit verdicts via ao review submit.
	if !contains(agent.got.AllowedTools, "bash(ao review submit:*)") {
		t.Fatalf("allowlist missing ao review submit: %#v", agent.got.AllowedTools)
	}

	// printf-based commands must NOT be covered since printf was removed.
	disallowed := "printf '%s' '{ \"reviews\": [] }' | ao review submit --session sess-1 --reviews -"
	if compoundCommandCovered(agent.got.AllowedTools, disallowed) {
		t.Fatalf("allowlist unexpectedly covers printf-based command %q with tools %#v", disallowed, agent.got.AllowedTools)
	}

	// gh-based commands must NOT be covered since gh was removed.
	disallowedGh := "gh api --method POST repos/o/r/pulls/1/reviews --input - --jq '.id'"
	if bashSegmentCovered(agent.got.AllowedTools, disallowedGh) {
		t.Fatalf("allowlist unexpectedly covers gh-based command %q with tools %#v", disallowedGh, agent.got.AllowedTools)
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
		cmd, ok := strings.CutPrefix(tool, "bash(")
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
