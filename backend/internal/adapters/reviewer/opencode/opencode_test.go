package opencode

import (
	"context"
	"encoding/json"
	"testing"

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
	return []string{"agent", "--prompt", cfg.Prompt}, nil
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

func TestReviewCommandUsesReadOnlyPermissionPolicy(t *testing.T) {
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

	if agent.got.Prompt != "review only\n\nreview it" {
		t.Fatalf("prompt = %q", agent.got.Prompt)
	}
	if agent.got.Permissions != ports.PermissionModeAuto {
		t.Fatalf("permissions = %q, want auto", agent.got.Permissions)
	}
	config := map[string]any{}
	if err := json.Unmarshal([]byte(got.Env["OPENCODE_CONFIG_CONTENT"]), &config); err != nil {
		t.Fatalf("inline config is invalid JSON: %v", err)
	}
	permission := config["permission"].(map[string]any)
	if permission["*"] != "deny" || permission["read"] != "allow" {
		t.Fatalf("permission policy = %#v", permission)
	}
	bash := permission["bash"].(map[string]any)
	if bash["*"] != "deny" || bash["gh api *"] != "allow" || bash["ao review submit *"] != "allow" {
		t.Fatalf("bash policy = %#v", bash)
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
