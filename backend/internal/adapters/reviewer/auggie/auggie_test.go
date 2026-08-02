package auggie

import (
	"context"
	"slices"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestReviewCommandUsesRulesAndUserPermissions(t *testing.T) {
	r := &Reviewer{resolveBinary: func(context.Context) (string, error) { return "/opt/auggie", nil }}
	spec, err := r.ReviewCommand(context.Background(), ports.ReviewInvocation{
		TaskPromptRoot: "/ao/prompts", SystemPromptFile: "/ao/prompts/system.md", Prompt: "read task",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"/opt/auggie", "--print", "--rules", "/ao/prompts/system.md", "--", "read task"}
	if !slices.Equal(spec.Argv, want) {
		t.Fatalf("argv = %#v, want %#v", spec.Argv, want)
	}
	if r.ReviewProcessReusable() {
		t.Fatal("Auggie print reviewer must respawn for each task")
	}
}
