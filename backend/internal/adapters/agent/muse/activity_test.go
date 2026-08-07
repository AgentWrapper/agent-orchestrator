package muse

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestDeriveActivityState(t *testing.T) {
	tests := []struct {
		name   string
		event  string
		want   domain.ActivityState
		wantOK bool
	}{
		{"prompt submitted", "user-prompt-submit", domain.ActivityActive, true},
		{"permission requested", "permission-request", domain.ActivityBlocked, true},
		{"turn stopped", "stop", domain.ActivityIdle, true},
		{"session start is metadata only", "session-start", "", false},
		{"unknown", "unknown", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := DeriveActivityState(tt.event, nil)
			if got != tt.want || ok != tt.wantOK {
				t.Fatalf("DeriveActivityState(%q) = (%q, %v), want (%q, %v)", tt.event, got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

func TestDetectTerminalActivityCapturedMuseFrames(t *testing.T) {
	tests := []struct {
		name    string
		fixture string
		want    domain.ActivityState
		wantOK  bool
	}{
		{"awaiting structured input", "awaiting_user_input.txt", domain.ActivityWaitingInput, true},
		{"awaiting compact structured input", "awaiting_user_input_compact.txt", domain.ActivityWaitingInput, true},
		{"resumed generation", "active_generation.txt", domain.ActivityActive, true},
		{"plain idle composer", "idle_composer.txt", domain.ActivityIdle, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			output, err := os.ReadFile(filepath.Join("testdata", tt.fixture))
			if err != nil {
				t.Fatal(err)
			}
			got, ok := (&Plugin{}).DetectTerminalActivity(string(output))
			if got != tt.want || ok != tt.wantOK {
				t.Fatalf("DetectTerminalActivity(%s) = (%q, %v), want (%q, %v)", tt.fixture, got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

func TestDetectTerminalActivityPrefersResumedGenerationOverPickerScrollback(t *testing.T) {
	waiting, err := os.ReadFile(filepath.Join("testdata", "awaiting_user_input.txt"))
	if err != nil {
		t.Fatal(err)
	}
	active, err := os.ReadFile(filepath.Join("testdata", "active_generation.txt"))
	if err != nil {
		t.Fatal(err)
	}
	got, ok := (&Plugin{}).DetectTerminalActivity(string(waiting) + "\n" + string(active))
	if !ok || got != domain.ActivityActive {
		t.Fatalf("DetectTerminalActivity(scrollback + active) = (%q, %v), want (%q, true)", got, ok, domain.ActivityActive)
	}
}

func TestDetectTerminalActivityPrefersNewPickerOverGenerationScrollback(t *testing.T) {
	active, err := os.ReadFile(filepath.Join("testdata", "active_generation.txt"))
	if err != nil {
		t.Fatal(err)
	}
	waiting, err := os.ReadFile(filepath.Join("testdata", "awaiting_user_input.txt"))
	if err != nil {
		t.Fatal(err)
	}
	got, ok := (&Plugin{}).DetectTerminalActivity(string(active) + "\n" + string(waiting))
	if !ok || got != domain.ActivityWaitingInput {
		t.Fatalf("DetectTerminalActivity(active scrollback + picker) = (%q, %v), want (%q, true)", got, ok, domain.ActivityWaitingInput)
	}
}

func TestDetectTerminalActivityRejectsTranscriptText(t *testing.T) {
	got, ok := (&Plugin{}).DetectTerminalActivity("The documentation says Enter to select an optional note.\n")
	if ok {
		t.Fatalf("DetectTerminalActivity(transcript) = (%q, true), want no signal", got)
	}
}
