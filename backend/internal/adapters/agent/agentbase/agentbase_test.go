package agentbase

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestModelConfigSpecHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ModelConfigSpec(ctx, "model"); !errors.Is(err, context.Canceled) {
		t.Fatalf("ModelConfigSpec error = %v, want context canceled", err)
	}
}

func TestModelConfigSpecAndFlag(t *testing.T) {
	spec, err := ModelConfigSpec(context.Background(), "Model override.")
	if err != nil {
		t.Fatal(err)
	}
	if len(spec.Fields) != 1 || spec.Fields[0].Key != "model" || spec.Fields[0].Description != "Model override." {
		t.Fatalf("spec = %#v", spec)
	}

	cmd := []string{"agent"}
	AppendModelFlag(&cmd, ports.AgentConfig{Model: "  provider/model  "}, "--model")
	if want := []string{"agent", "--model", "provider/model"}; !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %q, want %q", cmd, want)
	}
	AppendModelFlag(&cmd, ports.AgentConfig{Model: "  "}, "--model")
	if len(cmd) != 3 {
		t.Fatalf("blank model changed cmd: %q", cmd)
	}
}
