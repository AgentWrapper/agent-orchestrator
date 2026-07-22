package pipeline

import (
	"strings"
	"testing"
)

type fakeTaskModeResolver map[string][]TaskMode

func (r fakeTaskModeResolver) SupportedTaskModes(plugin string) ([]TaskMode, bool) {
	modes, ok := r[plugin]
	return modes, ok
}

func agentStage(name, plugin string, mode TaskMode) Stage {
	return Stage{
		Name: name,
		Executor: StageExecutor{
			Kind:   ExecutorAgent,
			Plugin: plugin,
			Mode:   mode,
		},
	}
}

func TestValidateAgentModes(t *testing.T) {
	resolver := fakeTaskModeResolver{
		"claude-code": {ModeReview, ModeCode},
		"codex":       {ModeAnswer},
		"no-modes":    {},
	}

	t.Run("accepts a supported mode", func(t *testing.T) {
		p := &Pipeline{
			Name:   "p",
			Stages: []Stage{agentStage("review", "claude-code", ModeReview)},
		}
		if err := ValidateAgentModes(p, resolver); err != nil {
			t.Fatalf("expected no error, got %v", err)
		}
	})

	t.Run("rejects unknown plugin", func(t *testing.T) {
		p := &Pipeline{
			Name:   "p",
			Stages: []Stage{agentStage("review", "nonexistent", ModeReview)},
		}
		err := ValidateAgentModes(p, resolver)
		if err == nil {
			t.Fatal("expected error")
		}
		if !strings.Contains(err.Error(), "unknown agent plugin") {
			t.Fatalf("error %q missing 'unknown agent plugin'", err.Error())
		}
	})

	t.Run("rejects unsupported mode", func(t *testing.T) {
		p := &Pipeline{
			Name:   "p",
			Stages: []Stage{agentStage("answer-stage", "claude-code", ModeAnswer)},
		}
		err := ValidateAgentModes(p, resolver)
		if err == nil {
			t.Fatal("expected error")
		}
		msg := err.Error()
		for _, want := range []string{"claude-code", "answer", "review", "code"} {
			if !strings.Contains(msg, want) {
				t.Fatalf("error %q missing %q", msg, want)
			}
		}
	})

	t.Run("empty supported list rejects", func(t *testing.T) {
		p := &Pipeline{
			Name:   "p",
			Stages: []Stage{agentStage("stage", "no-modes", ModeReview)},
		}
		err := ValidateAgentModes(p, resolver)
		if err == nil {
			t.Fatal("expected error")
		}
	})

	t.Run("command and builtin stages are ignored", func(t *testing.T) {
		p := &Pipeline{
			Name: "p",
			Stages: []Stage{
				{Name: "cmd", Executor: StageExecutor{Kind: ExecutorCommand, Command: "echo hi"}},
				{Name: "builtin", Executor: StageExecutor{Kind: ExecutorBuiltin, Name: BuiltinRouter}},
			},
		}
		if err := ValidateAgentModes(p, resolver); err != nil {
			t.Fatalf("expected no error, got %v", err)
		}
	})

	t.Run("multi-stage pipeline fails on first mismatch", func(t *testing.T) {
		p := &Pipeline{
			Name: "p",
			Stages: []Stage{
				agentStage("ok", "claude-code", ModeReview),
				agentStage("bad", "codex", ModeReview),
				agentStage("also-bad", "nonexistent", ModeReview),
			},
		}
		err := ValidateAgentModes(p, resolver)
		if err == nil {
			t.Fatal("expected error")
		}
		if !strings.Contains(err.Error(), `stage "bad"`) {
			t.Fatalf("expected error to name the first failing stage 'bad', got %q", err.Error())
		}
	})
}
