package cursor

import (
	"context"
	"errors"
	"reflect"
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

func TestReviewCommandBuildsHeadlessAskInvocation(t *testing.T) {
	agent := &captureAgent{}
	r := &Reviewer{agent: agent}

	got, err := r.ReviewCommand(context.Background(), ports.ReviewInvocation{
		ReviewerID:       "review-w1",
		WorkspacePath:    "/ws/w1",
		Prompt:           "Read the AO review task.",
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
		"--print", "--output-format", "text", "--mode=ask",
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
}

func TestReviewerPaneIsOneShot(t *testing.T) {
	if (&Reviewer{}).ReuseReviewerPane() {
		t.Fatal("headless Cursor reviewer pane must not be reused")
	}
}

func TestReviewCommandFallsBackToInlinePrompts(t *testing.T) {
	agent := &captureAgent{}
	r := &Reviewer{agent: agent}

	if _, err := r.ReviewCommand(context.Background(), ports.ReviewInvocation{
		SystemPrompt: "review only",
		Prompt:       "review it",
	}); err != nil {
		t.Fatalf("ReviewCommand: %v", err)
	}
	if agent.got.Prompt != "review only\n\nreview it" {
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
