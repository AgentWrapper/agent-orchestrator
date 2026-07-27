//go:build windows

package conpty

import (
	"os/exec"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestPidAliveReportsExitedUnreapedProcessAsDead(t *testing.T) {
	cmd := exec.Command("cmd", "/c", "exit 0")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start child: %v", err)
	}
	defer func() { _ = cmd.Wait() }()

	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(cmd.Process.Pid))
	if err != nil {
		t.Fatalf("open child process: %v", err)
	}
	defer windows.CloseHandle(handle)

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		status, err := windows.WaitForSingleObject(handle, 0)
		if err != nil {
			t.Fatalf("wait for child process: %v", err)
		}
		if status == uint32(windows.WAIT_OBJECT_0) {
			if pidAlive(cmd.Process.Pid) {
				t.Fatal("pidAlive returned true for exited unreaped process")
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("child process did not exit before timeout")
}
