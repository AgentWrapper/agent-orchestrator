package opencodeacp

import (
	"encoding/json"
	"testing"

	acpdriver "github.com/aoagents/agent-orchestrator/backend/internal/adapters/chatdriver/acp"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestConfigureUsesNativeACPAndMergesSystemPromptConfig(t *testing.T) {
	args, env, err := configure(acpdriver.LaunchConfig{
		SessionID: "worker-1", SystemPrompt: "Follow AO worker rules.",
		Permissions: ports.PermissionModeBypassPermissions,
		Env: map[string]string{
			"OPENCODE_CONFIG":         "/user/custom.json",
			"OPENCODE_CONFIG_CONTENT": `{"provider":{"local":{"name":"Local"}},"agent":{"mine":{"mode":"primary"}}}`,
		},
	})
	if err != nil {
		t.Fatalf("configure: %v", err)
	}
	if len(args) != 1 || args[0] != "acp" {
		t.Fatalf("args = %#v", args)
	}
	var config struct {
		DefaultAgent string         `json:"default_agent"`
		Provider     map[string]any `json:"provider"`
		Permission   string         `json:"permission"`
		Agent        map[string]struct {
			Mode   string `json:"mode"`
			Prompt string `json:"prompt"`
		} `json:"agent"`
	}
	if err := json.Unmarshal([]byte(env["OPENCODE_CONFIG_CONTENT"]), &config); err != nil {
		t.Fatalf("decode config: %v", err)
	}
	if config.DefaultAgent != "ao-worker-1" {
		t.Fatalf("default agent = %q", config.DefaultAgent)
	}
	if got := config.Agent[config.DefaultAgent]; got.Mode != "primary" || got.Prompt != "Follow AO worker rules." {
		t.Fatalf("AO agent config = %#v", got)
	}
	if _, ok := config.Agent["mine"]; !ok || config.Provider["local"] == nil {
		t.Fatalf("user inline config was not preserved: %#v", config)
	}
	if config.Permission != "allow" {
		t.Fatalf("permission = %q, want allow", config.Permission)
	}
}

func TestConfigureWithoutSystemPromptWritesNoAOConfig(t *testing.T) {
	args, env, err := configure(acpdriver.LaunchConfig{})
	if err != nil {
		t.Fatalf("configure: %v", err)
	}
	if len(args) != 1 || args[0] != "acp" || env != nil {
		t.Fatalf("args/env = %#v, %#v", args, env)
	}
}

func TestSessionOptionsUseProviderAdvertisedModelOption(t *testing.T) {
	if got := sessionOptions(ports.ChatTurnSettings{}); got != nil {
		t.Fatalf("empty settings = %#v", got)
	}
	got := sessionOptions(ports.ChatTurnSettings{Model: "anthropic/claude-sonnet"})
	if len(got) != 1 || got[0].ID != "model" || got[0].Value != "anthropic/claude-sonnet" {
		t.Fatalf("model settings = %#v", got)
	}
}
