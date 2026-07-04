package cursor

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/authprobe"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestCursorCLIAuthStatusAuthorizedFromStatus(t *testing.T) {
	restore := stubCursorAuthCommand(t, []string{"status"}, []byte("✓ Logged in as user@example.com\n"), nil)
	defer restore()

	status, err := cursorCLIAuthStatus(context.Background(), "cursor-agent")
	if err != nil {
		t.Fatal(err)
	}
	if status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = %q, want %q", status, ports.AgentAuthStatusAuthorized)
	}
}

func TestCursorCLIAuthStatusUnknownFromKeychainError(t *testing.T) {
	restore := stubCursorAuthCommand(t, []string{"status"}, []byte("ERROR: SecItemCopyMatching failed -50\n"), assertErr("exit status 139"))
	defer restore()

	status, err := cursorCLIAuthStatus(context.Background(), "cursor-agent")
	if err != nil {
		t.Fatal(err)
	}
	if status != ports.AgentAuthStatusUnknown {
		t.Fatalf("status = %q, want %q", status, ports.AgentAuthStatusUnknown)
	}
}

func TestCursorConfigAuthStatusAuthorizedWithAuthInfo(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cli-config.json")
	if err := os.WriteFile(path, []byte(`{"authInfo":{"email":"user@example.com","userId":"user-1","authId":"auth-1"}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	status, ok, err := cursorConfigAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusAuthorized)
	}
}

func TestCursorConfigAuthStatusUnknownWithoutAuthInfo(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cli-config.json")
	if err := os.WriteFile(path, []byte(`{"model":{"modelId":"cursor-default"}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	status, ok, err := cursorConfigAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if ok || status != ports.AgentAuthStatusUnknown {
		t.Fatalf("status = (%q, %v), want (%q, false)", status, ok, ports.AgentAuthStatusUnknown)
	}
}

type assertErr string

func (e assertErr) Error() string {
	return string(e)
}

func stubCursorAuthCommand(t *testing.T, wantArgs []string, out []byte, err error) func() {
	t.Helper()
	previous := authprobe.CmdRunner
	authprobe.CmdRunner = func(ctx context.Context, name string, arg ...string) ([]byte, error) {
		if name != "cursor-agent" || !reflect.DeepEqual(arg, wantArgs) {
			t.Fatalf("command = %s %#v, want cursor-agent %#v", name, arg, wantArgs)
		}
		return out, err
	}
	return func() { authprobe.CmdRunner = previous }
}

func TestCursorConfigAuthStatusUnknownWhenMissing(t *testing.T) {
	status, ok, err := cursorConfigAuthStatus(filepath.Join(t.TempDir(), "missing.json"))
	if err != nil {
		t.Fatal(err)
	}
	if ok || status != ports.AgentAuthStatusUnknown {
		t.Fatalf("status = (%q, %v), want (%q, false)", status, ok, ports.AgentAuthStatusUnknown)
	}
}
