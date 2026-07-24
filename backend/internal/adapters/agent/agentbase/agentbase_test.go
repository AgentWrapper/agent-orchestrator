package agentbase

import (
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestAppendModelFlagAppendsTrimmedModel(t *testing.T) {
	cmd := []string{"agent", "--force"}
	AppendModelFlag(&cmd, ports.AgentConfig{Model: "  gpt-5  "})

	want := []string{"agent", "--force", "--model", "gpt-5"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd\nwant: %#v\n got: %#v", want, cmd)
	}
}

func TestAppendModelFlagNoOpForBlankModel(t *testing.T) {
	for _, model := range []string{"", " \t "} {
		cmd := []string{"agent"}
		AppendModelFlag(&cmd, ports.AgentConfig{Model: model})

		want := []string{"agent"}
		if !reflect.DeepEqual(cmd, want) {
			t.Fatalf("model %q: cmd\nwant: %#v\n got: %#v", model, want, cmd)
		}
	}
}

func TestModelConfigField(t *testing.T) {
	got := ModelConfigField("Model override passed to `x --model`.")

	want := ports.ConfigField{
		Key:         "model",
		Type:        ports.ConfigFieldString,
		Description: "Model override passed to `x --model`.",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("field\nwant: %#v\n got: %#v", want, got)
	}
}
