package droid

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestReviewCommandUsesRestrictedInteractiveSettings(t *testing.T) {
	r := &Reviewer{resolveBinary: func(context.Context) (string, error) { return "/opt/droid", nil }}
	root := t.TempDir()
	inv := ports.ReviewInvocation{
		TaskPromptRoot: root, SystemPromptFile: filepath.Join(root, "system.md"), Prompt: "Read task.",
	}
	spec, err := r.ReviewCommand(context.Background(), inv)
	if err != nil {
		t.Fatal(err)
	}
	settingsPath := filepath.Join(root, settingsFilename)
	want := []string{"/opt/droid", "--settings", settingsPath, "--append-system-prompt-file", inv.SystemPromptFile}
	if !slices.Equal(spec.Argv, want) || spec.InitialMessage != inv.Prompt {
		t.Fatalf("spec = %#v, want argv %#v", spec, want)
	}
	raw, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	var settings struct {
		Session struct {
			InteractionMode string `json:"interactionMode"`
			AutonomyLevel   string `json:"autonomyLevel"`
		} `json:"sessionDefaultSettings"`
		CloudSessionSync bool `json:"cloudSessionSync"`
		IDEAutoConnect   bool `json:"ideAutoConnect"`
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		t.Fatal(err)
	}
	if settings.Session.InteractionMode != "spec" || settings.Session.AutonomyLevel != "off" || settings.CloudSessionSync || settings.IDEAutoConnect {
		t.Fatalf("settings = %#v", settings)
	}
}

func TestReviewCommandPreflightValidationAndCancel(t *testing.T) {
	r := &Reviewer{resolveBinary: func(context.Context) (string, error) { return "/opt/droid", nil }}
	spec, err := r.ReviewCommand(context.Background(), ports.ReviewInvocation{})
	if err != nil || !slices.Equal(spec.Argv, []string{"/opt/droid"}) {
		t.Fatalf("spec = %#v, %v", spec, err)
	}
	r.resolveBinary = func(context.Context) (string, error) { return "droid", nil }
	if _, err := r.ReviewCommand(context.Background(), ports.ReviewInvocation{}); err == nil {
		t.Fatal("expected relative binary rejection")
	}
	cancel, err := r.ReviewCancel(context.Background())
	if err != nil || cancel.Mode != ports.ReviewCancelInterrupt || cancel.Interrupts != 1 {
		t.Fatalf("cancel = %#v, %v", cancel, err)
	}
}
