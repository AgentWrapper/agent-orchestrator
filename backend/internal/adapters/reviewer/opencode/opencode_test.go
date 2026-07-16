package opencode

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
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
	if bash["*"] != "deny" || bash["ao review publish *"] != "allow" {
		t.Fatalf("bash policy = %#v", bash)
	}
	for _, unwanted := range []string{"gh api *", "glab *", "ao review submit *"} {
		if _, ok := bash[unwanted]; ok {
			t.Fatalf("bash policy contains obsolete provider command %q: %#v", unwanted, bash)
		}
	}
}

func TestBashAllowlistCoversPromptRequiredCommands(t *testing.T) {
	bash := reviewerConfigBashPolicy(t)

	tests := []struct {
		name    string
		command string
		allowed bool
	}{
		{
			name:    "provider-neutral review publication",
			command: `printf '%s' '{ "reviews": [] }' | ao review publish --session sess-1 --reviews -`,
			allowed: true,
		},
		{
			name:    "github provider CLI",
			command: `printf '%s' '{}' | gh api --method POST repos/o/r/pulls/1/reviews --input -`,
			allowed: false,
		},
		{
			name:    "gitlab provider CLI",
			command: `printf '%s' '{}' | glab api projects/o%2Fr/merge_requests/1/notes`,
			allowed: false,
		},
		{
			name:    "legacy local review submit",
			command: `printf '%s' '{ "reviews": [] }' | ao review submit --session sess-1 --reviews -`,
			allowed: false,
		},
		{
			name:    "arbitrary shell command",
			command: `rm -rf /`,
			allowed: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := bashAllowsCommand(t, bash, tt.command); got != tt.allowed {
				t.Fatalf("bashAllowsCommand(%q) = %v, want %v", tt.command, got, tt.allowed)
			}
		})
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

func reviewerConfigBashPolicy(t *testing.T) map[string]string {
	t.Helper()

	var config struct {
		Permission struct {
			Bash map[string]string `json:"bash"`
		} `json:"permission"`
	}
	if err := json.Unmarshal([]byte(reviewerConfig), &config); err != nil {
		t.Fatalf("reviewerConfig is invalid JSON: %v", err)
	}
	if len(config.Permission.Bash) == 0 {
		t.Fatal("reviewerConfig permission.bash is empty")
	}
	return config.Permission.Bash
}

func bashAllowsCommand(t *testing.T, bash map[string]string, command string) bool {
	t.Helper()

	for pattern, action := range bash {
		if action == "deny" {
			continue
		}
		if simplePicomatchGlobMatches(t, pattern, command) {
			return true
		}
	}
	return false
}

func simplePicomatchGlobMatches(t *testing.T, pattern, command string) bool {
	t.Helper()

	parts := strings.Split(pattern, "*")
	for i, part := range parts {
		parts[i] = regexp.QuoteMeta(part)
	}
	re, err := regexp.Compile("^" + strings.Join(parts, ".*") + "$")
	if err != nil {
		t.Fatalf("compile pattern %q: %v", pattern, err)
	}
	return re.MatchString(command)
}
