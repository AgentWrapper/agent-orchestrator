package worker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	cloudpostgres "github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
)

func TestPrepareClaudeCloudExperienceSkipsFirstRunPrompts(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(home, ".claude.json"),
		[]byte(`{"custom":"preserved"}`),
		0o600,
	); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if err := prepareClaudeCloudExperience(home); err != nil {
		t.Fatalf("prepareClaudeCloudExperience() error = %v", err)
	}

	root := readJSONObject(t, filepath.Join(home, ".claude.json"))
	if root["hasCompletedOnboarding"] != true ||
		root["theme"] != "dark" ||
		root["custom"] != "preserved" {
		t.Fatalf("Claude root config = %#v", root)
	}
	settings := readJSONObject(t, filepath.Join(home, ".claude", "settings.json"))
	permissions, _ := settings["permissions"].(map[string]any)
	if settings["theme"] != "dark" ||
		settings["skipDangerousModePermissionPrompt"] != true ||
		permissions["defaultMode"] != "bypassPermissions" {
		t.Fatalf("Claude settings = %#v", settings)
	}
}

func readJSONObject(t *testing.T, path string) map[string]any {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%q) error = %v", path, err)
	}
	var object map[string]any
	if err := json.Unmarshal(contents, &object); err != nil {
		t.Fatalf("Unmarshal(%q) error = %v", path, err)
	}
	return object
}

func TestPrepareAgentCredentialEnvironment(t *testing.T) {
	tests := []struct {
		name           string
		harness        string
		credentialType string
		environmentKey string
	}{
		{
			name:           "Claude OAuth token",
			harness:        "claude-code",
			credentialType: "oauth_token",
			environmentKey: "CLAUDE_CODE_OAUTH_TOKEN",
		},
		{
			name:           "Claude API key",
			harness:        "claude-code",
			credentialType: "api_key",
			environmentKey: "ANTHROPIC_API_KEY",
		},
		{
			name:           "Cursor API key",
			harness:        "cursor",
			credentialType: "api_key",
			environmentKey: "CURSOR_API_KEY",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			credential := &AgentCredential{
				Provider:       test.harness,
				CredentialType: test.credentialType,
				Secret:         "test-secret",
			}
			runner := runnerWithCredential(test.harness, credential)
			environment := map[string]string{}

			name, err := runner.prepareAgentCredential(context.Background(), environment)
			if err != nil {
				t.Fatalf("prepareAgentCredential() error = %v", err)
			}
			if name != test.environmentKey {
				t.Fatalf("environment name = %q, want %q", name, test.environmentKey)
			}
			if environment[test.environmentKey] != "test-secret" {
				t.Fatalf("credential environment was not populated")
			}
			if credential.Secret != "" {
				t.Fatalf("credential secret was not cleared")
			}
		})
	}
}

func TestPrepareAgentCredentialCodexLoginUsesStdin(t *testing.T) {
	for _, credentialType := range []string{"api_key", "access_token"} {
		t.Run(credentialType, func(t *testing.T) {
			credential := &AgentCredential{
				Provider:       "codex",
				CredentialType: credentialType,
				Secret:         "codex-secret",
			}
			runner := runnerWithCredential("codex", credential)
			var gotName string
			var gotArguments []string
			var gotStdin string
			runner.credentialCommand = func(
				_ context.Context,
				name string,
				arguments []string,
				stdin io.Reader,
			) error {
				gotName = name
				gotArguments = append([]string(nil), arguments...)
				encoded, err := io.ReadAll(stdin)
				if err != nil {
					return err
				}
				gotStdin = string(encoded)
				return nil
			}
			environment := map[string]string{}

			name, err := runner.prepareAgentCredential(context.Background(), environment)
			if err != nil {
				t.Fatalf("prepareAgentCredential() error = %v", err)
			}
			wantOption := "--with-api-key"
			if credentialType == "access_token" {
				wantOption = "--with-access-token"
			}
			if gotName != "codex" || !reflect.DeepEqual(gotArguments, []string{"login", wantOption}) {
				t.Fatalf("command = %q %#v, want codex login %s", gotName, gotArguments, wantOption)
			}
			if gotStdin != "codex-secret" {
				t.Fatalf("stdin = %q, want credential", gotStdin)
			}
			if name != "" || len(environment) != 0 {
				t.Fatalf("Codex credential leaked into environment: name=%q env=%#v", name, environment)
			}
			if credential.Secret != "" {
				t.Fatalf("credential secret was not cleared")
			}
		})
	}
}

func TestPrepareAgentCredentialCodexLoginFailure(t *testing.T) {
	credential := &AgentCredential{
		Provider:       "codex",
		CredentialType: "api_key",
		Secret:         "codex-secret",
	}
	runner := runnerWithCredential("codex", credential)
	runner.credentialCommand = func(context.Context, string, []string, io.Reader) error {
		return errors.New("codex login failed")
	}

	if _, err := runner.prepareAgentCredential(context.Background(), map[string]string{}); err == nil {
		t.Fatal("prepareAgentCredential() error = nil, want login failure")
	}
	if credential.Secret != "" {
		t.Fatalf("credential secret was not cleared after failure")
	}
}

func runnerWithCredential(harness string, credential *AgentCredential) *Runner {
	return &Runner{
		bootstrap: BootstrapResponse{
			Launch: cloudpostgres.WorkerLaunchSpec{
				Session: clouddomain.Session{Harness: harness},
			},
			AgentCredential: credential,
		},
	}
}
