package auggie

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/authprobe"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestAuthStatusUsesAuggieAccountStatus(t *testing.T) {
	restore := stubAuggieAuthRunner(t, func(_ context.Context, name string, arg ...string) ([]byte, error) {
		if name != "auggie" {
			t.Fatalf("binary = %q, want auggie", name)
		}
		if !reflect.DeepEqual(arg, []string{"account", "status"}) {
			t.Fatalf("args = %#v, want [account status]", arg)
		}
		return []byte("Credits remaining: 42\n"), nil
	})
	defer restore()

	status, err := (&Plugin{resolvedBinary: "auggie"}).AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = %q, want %q", status, ports.AgentAuthStatusAuthorized)
	}
}

func TestAuthStatusUnauthorizedFromAuggieAccountStatus(t *testing.T) {
	restore := stubAuggieAuthRunner(t, func(context.Context, string, ...string) ([]byte, error) {
		return []byte("You are not currently logged in to Augment.\nRun 'auggie login' to authenticate first.\n"), errors.New("exit status 1")
	})
	defer restore()

	status, err := (&Plugin{resolvedBinary: "auggie"}).AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status != ports.AgentAuthStatusUnauthorized {
		t.Fatalf("status = %q, want %q", status, ports.AgentAuthStatusUnauthorized)
	}
}

func stubAuggieAuthRunner(t *testing.T, runner func(context.Context, string, ...string) ([]byte, error)) func() {
	t.Helper()
	previous := authprobe.CmdRunner
	authprobe.CmdRunner = runner
	return func() { authprobe.CmdRunner = previous }
}
