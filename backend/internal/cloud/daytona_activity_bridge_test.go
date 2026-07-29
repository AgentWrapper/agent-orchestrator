package cloud

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/daytona"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeDaytonaActivityClient struct {
	sandboxes []daytona.Sandbox
	result    daytona.ExecResult
	commands  []daytona.ExecRequest
}

func (f *fakeDaytonaActivityClient) ListSandboxes(context.Context, map[string]string) ([]daytona.Sandbox, error) {
	return f.sandboxes, nil
}

func (f *fakeDaytonaActivityClient) Exec(_ context.Context, _ string, req daytona.ExecRequest) (daytona.ExecResult, error) {
	f.commands = append(f.commands, req)
	return f.result, nil
}

type fakeActivityApplier struct {
	signals []ports.ActivitySignal
}

func (f *fakeActivityApplier) ApplyActivitySignal(_ context.Context, _ domain.SessionID, s ports.ActivitySignal) error {
	f.signals = append(f.signals, s)
	return nil
}

func TestDaytonaActivityBridgePollsSpoolAndAppliesSignals(t *testing.T) {
	client := &fakeDaytonaActivityClient{
		sandboxes: []daytona.Sandbox{{ID: "sandbox-1", State: daytona.StateStarted}},
		result: daytona.ExecResult{
			ExitCode: 0,
			Result: `{"state":"active","event":"user-prompt-submit","launchId":"launch-1","timestamp":"2026-07-29T22:00:00Z"}` + "\n" +
				`{"state":"idle","event":"stop","launchId":"launch-1","timestamp":"2026-07-29T22:00:02Z"}` + "\n",
		},
	}
	applier := &fakeActivityApplier{}
	bridge := newDaytonaActivityBridge(client, applier, nil)

	done, err := bridge.poll(context.Background(), "sess-1", "handle-1", "launch-1", map[string]bool{})
	if err != nil {
		t.Fatal(err)
	}
	if !done {
		t.Fatal("done = false, want true after idle event")
	}
	if len(applier.signals) != 2 {
		t.Fatalf("signals = %d, want 2", len(applier.signals))
	}
	if applier.signals[0].State != domain.ActivityActive || applier.signals[0].Event != "user-prompt-submit" {
		t.Fatalf("active signal = %#v", applier.signals[0])
	}
	if applier.signals[1].State != domain.ActivityIdle || applier.signals[1].Event != "stop" {
		t.Fatalf("idle signal = %#v", applier.signals[1])
	}
	if len(client.commands) != 1 || client.commands[0].Command != "test -f '/tmp/ao-cloud-activity-sess-1.ndjson' && cat '/tmp/ao-cloud-activity-sess-1.ndjson' || true" {
		t.Fatalf("commands = %#v", client.commands)
	}
}

func TestDaytonaActivityBridgeSkipsStaleLaunch(t *testing.T) {
	client := &fakeDaytonaActivityClient{
		sandboxes: []daytona.Sandbox{{ID: "sandbox-1", State: daytona.StateStarted}},
		result: daytona.ExecResult{
			ExitCode: 0,
			Result:   `{"state":"active","event":"user-prompt-submit","launchId":"old-launch"}` + "\n",
		},
	}
	applier := &fakeActivityApplier{}
	bridge := newDaytonaActivityBridge(client, applier, nil)

	done, err := bridge.poll(context.Background(), "sess-1", "handle-1", "launch-1", map[string]bool{})
	if err != nil {
		t.Fatal(err)
	}
	if done {
		t.Fatal("done = true, want false")
	}
	if len(applier.signals) != 0 {
		t.Fatalf("signals = %#v, want none", applier.signals)
	}
}
