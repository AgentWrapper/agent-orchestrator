package cloud

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
)

func TestCloudClaudeAgentAugmentsRuntimeEnvWithSessionToken(t *testing.T) {
	issuer, err := auth.NewIssuer(auth.IssuerConfig{
		Secret: "test-secret",
		Now:    func() time.Time { return time.Unix(100, 0) },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLAUDE_CODE_OAUTH_TOKEN", "oauth-token")
	env := map[string]string{
		sessionmanager.EnvSessionID: "sess-1",
		"AO_CLOUD_ORG_ID":           "org-1",
	}

	cloudClaudeAgent{issuer: issuer, publicAPIBase: "https://ao.example"}.AugmentRuntimeEnv(env, "")

	if env["AO_API_BASE"] != "https://ao.example" {
		t.Fatalf("AO_API_BASE = %q", env["AO_API_BASE"])
	}
	if env["CLAUDE_CODE_OAUTH_TOKEN"] != "oauth-token" {
		t.Fatalf("CLAUDE_CODE_OAUTH_TOKEN not forwarded")
	}
	claims, err := issuer.VerifyAccessToken(env["AO_API_TOKEN"])
	if err != nil {
		t.Fatalf("VerifyAccessToken: %v", err)
	}
	if claims.SessionID != "sess-1" || claims.OrgIDs[0] != "org-1" {
		t.Fatalf("claims = %#v", claims)
	}
}

func TestCloudClaudeAgentLaunchUsesPrintModeForInitialPrompt(t *testing.T) {
	cmd, err := (cloudClaudeAgent{}).GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Prompt:      "say hi",
		Permissions: ports.PermissionModeBypassPermissions,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(cmd) != 3 || cmd[0] != "sh" || cmd[1] != "-lc" {
		t.Fatalf("cmd = %#v", cmd)
	}
	for _, want := range []string{
		"printf '{}' | ao hooks claude-code user-prompt-submit",
		"'claude' '--permission-mode' 'bypassPermissions' '-p' 'say hi'",
		"printf '{}' | ao hooks claude-code stop",
	} {
		if !strings.Contains(cmd[2], want) {
			t.Fatalf("script missing %q: %s", want, cmd[2])
		}
	}
}
