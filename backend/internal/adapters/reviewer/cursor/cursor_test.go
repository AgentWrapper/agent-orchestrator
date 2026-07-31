package cursor

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type captureAgent struct {
	got ports.LaunchConfig
	err error
}

func (a *captureAgent) GetConfigSpec(context.Context) (ports.ConfigSpec, error) {
	return ports.ConfigSpec{}, nil
}
func (a *captureAgent) GetLaunchCommand(_ context.Context, cfg ports.LaunchConfig) ([]string, error) {
	a.got = cfg
	if a.err != nil {
		return nil, a.err
	}
	return []string{"cursor-agent", "--force", "--", cfg.Prompt}, nil
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

func TestReviewCommandBuildsPersistentInteractiveAskInvocation(t *testing.T) {
	agent := &captureAgent{}
	r := &Reviewer{agent: agent}
	dataDir := t.TempDir()

	got, err := r.ReviewCommand(context.Background(), ports.ReviewInvocation{
		ReviewerID:       "review-w1",
		WorkspacePath:    "/ws/w1",
		DataDir:          dataDir,
		Prompt:           "Read the AO review task.",
		SystemPrompt:     "secret system content must not enter argv",
		SystemPromptFile: "/ao/prompts/reviewer/system.md",
		TaskPromptFile:   "/ao/prompts/reviewer/requests/batch-1/run-1/task.md",
		TaskPromptRoot:   "/ao/prompts/reviewer",
	})
	if err != nil {
		t.Fatalf("ReviewCommand: %v", err)
	}

	wantPrompt := "Read and follow the AO reviewer role in `/ao/prompts/reviewer/system.md`, then complete the AO review task in `/ao/prompts/reviewer/requests/batch-1/run-1/task.md`."
	want := []string{
		"cursor-agent", "--force",
		"--mode", "ask", "--sandbox", "enabled", "--trust",
		"--add-dir", "/ao/prompts/reviewer",
		"--", wantPrompt,
	}
	if !reflect.DeepEqual(got.Argv, want) {
		t.Fatalf("argv = %#v, want %#v", got.Argv, want)
	}
	if agent.got.Permissions != ports.PermissionModeAuto {
		t.Fatalf("permissions = %q, want auto", agent.got.Permissions)
	}
	if agent.got.WorkspacePath != "/ws/w1" || agent.got.SessionID != "review-w1" {
		t.Fatalf("launch config = %+v", agent.got)
	}
	for _, forbidden := range []string{"--print", "-p", "--output-format", "--plan", "--mode=plan"} {
		if slicesContain(got.Argv, forbidden) {
			t.Fatalf("argv contains non-interactive/plan flag %q: %#v", forbidden, got.Argv)
		}
	}
	if strings.Contains(strings.Join(got.Argv, " "), "secret system content") {
		t.Fatalf("argv exposes system prompt content: %#v", got.Argv)
	}
	profileDir := filepath.Join(dataDir, "cursor", "reviewers", "review-w1")
	if got.Env[cursorDataDirEnv] != profileDir || got.Env[cursorConfigDirEnv] != profileDir {
		t.Fatalf("env = %#v, want AO-owned profile %q", got.Env, profileDir)
	}
}

func TestReviewCommandNeverFallsBackToInlineSystemPrompt(t *testing.T) {
	agent := &captureAgent{}
	r := &Reviewer{agent: agent}

	if _, err := r.ReviewCommand(context.Background(), ports.ReviewInvocation{
		SystemPrompt: "review only",
		Prompt:       "review it",
	}); err != nil {
		t.Fatalf("ReviewCommand: %v", err)
	}
	if agent.got.Prompt != "review it" {
		t.Fatalf("prompt = %q", agent.got.Prompt)
	}
}

func TestReviewCommandPropagatesAgentFailure(t *testing.T) {
	r := &Reviewer{agent: &captureAgent{err: errors.New("cursor: binary unavailable")}}

	_, err := r.ReviewCommand(context.Background(), ports.ReviewInvocation{Prompt: "review it"})
	if err == nil || err.Error() != "cursor: binary unavailable" {
		t.Fatalf("err = %v, want binary-unavailable error", err)
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

func TestReviewCancelUsesTwoInterrupts(t *testing.T) {
	got, err := (&Reviewer{}).ReviewCancel(context.Background())
	if err != nil {
		t.Fatalf("ReviewCancel: %v", err)
	}
	if got.Mode != ports.ReviewCancelInterrupt || got.Interrupts != 2 {
		t.Fatalf("cancel = %+v, want two interrupts", got)
	}
}

func TestPreLaunchInstallsAOManagedReviewerPolicyAndPreservesUserConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv(cursorConfigDirEnv, "")
	t.Setenv("XDG_CONFIG_HOME", "")
	userConfigPath := filepath.Join(home, ".cursor", cursorConfigFileName)
	if err := os.MkdirAll(filepath.Dir(userConfigPath), 0o700); err != nil {
		t.Fatal(err)
	}
	userConfig := []byte(`{"version":1,"model":{"modelId":"kept"},"permissions":{"allow":["Shell(user-owned)"],"deny":[]}}`)
	if err := os.WriteFile(userConfigPath, userConfig, 0o600); err != nil {
		t.Fatal(err)
	}

	dataDir := t.TempDir()
	inv := ports.ReviewInvocation{
		ReviewerID:     "review/w1",
		DataDir:        dataDir,
		TaskPromptRoot: filepath.Join(dataDir, "prompts", "w1", "reviewer"),
	}
	if err := (&Reviewer{}).PreLaunch(context.Background(), inv); err != nil {
		t.Fatalf("PreLaunch: %v", err)
	}

	if got, err := os.ReadFile(userConfigPath); err != nil || !reflect.DeepEqual(got, userConfig) {
		t.Fatalf("user config changed: got %q err=%v", got, err)
	}
	profileDir := filepath.Join(dataDir, "cursor", "reviewers", "review-w1")
	if marker, err := os.ReadFile(filepath.Join(profileDir, cursorConfigMarkerName)); err != nil || string(marker) != cursorConfigMarkerContent {
		t.Fatalf("ownership marker = %q, err=%v", marker, err)
	}
	config := readReviewerConfig(t, filepath.Join(profileDir, cursorConfigFileName))
	if model := config["model"].(map[string]any)["modelId"]; model != "kept" {
		t.Fatalf("seeded model = %v, want kept", model)
	}
	permissions := config["permissions"].(map[string]any)
	assertJSONStrings(t, permissions["allow"], append(reviewerAllowedPermissions,
		"Read("+filepath.ToSlash(filepath.Join(inv.TaskPromptRoot, "**"))+")"))
	assertJSONStrings(t, permissions["deny"], reviewerDeniedPermissions)
	sandbox := config["sandbox"].(map[string]any)
	if sandbox["mode"] != "enabled" {
		t.Fatalf("sandbox = %#v, want enabled", sandbox)
	}
}

func TestPreLaunchPreservesAOProfileFieldsOnPolicyRefresh(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv(cursorConfigDirEnv, "")
	t.Setenv("XDG_CONFIG_HOME", "")
	inv := ports.ReviewInvocation{ReviewerID: "review-w1", DataDir: t.TempDir(), TaskPromptRoot: "/first/root"}
	r := &Reviewer{}
	if err := r.PreLaunch(context.Background(), inv); err != nil {
		t.Fatalf("first PreLaunch: %v", err)
	}
	configPath := filepath.Join(reviewerProfileDir(inv), cursorConfigFileName)
	config := readReviewerConfig(t, configPath)
	config["userPreference"] = "preserve"
	data, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, data, 0o600); err != nil {
		t.Fatal(err)
	}

	inv.TaskPromptRoot = "/second/root"
	if err := r.PreLaunch(context.Background(), inv); err != nil {
		t.Fatalf("second PreLaunch: %v", err)
	}
	refreshed := readReviewerConfig(t, configPath)
	if refreshed["userPreference"] != "preserve" {
		t.Fatalf("profile field was dropped: %#v", refreshed)
	}
	allow := refreshed["permissions"].(map[string]any)["allow"]
	assertJSONStrings(t, allow, append(reviewerAllowedPermissions, "Read(/second/root/**)"))
}

func TestPreLaunchRefusesNonAOReviewerConfig(t *testing.T) {
	inv := ports.ReviewInvocation{ReviewerID: "review-w1", DataDir: t.TempDir(), TaskPromptRoot: "/prompts"}
	configPath := filepath.Join(reviewerProfileDir(inv), cursorConfigFileName)
	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		t.Fatal(err)
	}
	foreign := []byte(`{"permissions":{"allow":["Shell(user-owned)"]}}`)
	if err := os.WriteFile(configPath, foreign, 0o600); err != nil {
		t.Fatal(err)
	}

	err := (&Reviewer{}).PreLaunch(context.Background(), inv)
	if err == nil || !strings.Contains(err.Error(), "refusing to overwrite non-AO") {
		t.Fatalf("PreLaunch err = %v, want ownership refusal", err)
	}
	if got, readErr := os.ReadFile(configPath); readErr != nil || !reflect.DeepEqual(got, foreign) {
		t.Fatalf("foreign config changed: got %q err=%v", got, readErr)
	}
}

func readReviewerConfig(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	return config
}

func assertJSONStrings(t *testing.T, got any, want []string) {
	t.Helper()
	values, ok := got.([]any)
	if !ok {
		t.Fatalf("value = %#v, want JSON string array", got)
	}
	actual := make([]string, len(values))
	for i, value := range values {
		actual[i], ok = value.(string)
		if !ok {
			t.Fatalf("value[%d] = %#v, want string", i, value)
		}
	}
	if !reflect.DeepEqual(actual, want) {
		t.Fatalf("strings = %#v, want %#v", actual, want)
	}
}

func slicesContain(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
