//go:build !windows

package processalive

import (
	"os/exec"
	"testing"
	"time"
)

func TestProcStatStateParsesCommandWithSpacesAndParens(t *testing.T) {
	state, err := procStatState([]byte("123 (worker ) name) Z 1 2 3"))
	if err != nil {
		t.Fatalf("parse proc stat: %v", err)
	}
	if state != 'Z' {
		t.Fatalf("state = %q, want Z", state)
	}
}

func TestProcStatStateRejectsMalformedInput(t *testing.T) {
	if _, err := procStatState([]byte("123 worker Z")); err == nil {
		t.Fatal("expected malformed proc stat error")
	}
}

func TestAliveReportsZombieAsDead(t *testing.T) {
	cmd := exec.Command("sh", "-c", "exit 0")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start child: %v", err)
	}
	defer func() { _ = cmd.Wait() }()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if isZombie(cmd.Process.Pid) {
			if Alive(cmd.Process.Pid) {
				t.Fatal("Alive returned true for zombie process")
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("child did not become a zombie before timeout")
}
