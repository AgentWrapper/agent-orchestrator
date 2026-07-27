//go:build !windows

package daemon

import (
	"os"
	"os/exec"
	"testing"
)

func TestIgnoreBrokenPipeSignalAllowsClosedStdoutStderr(t *testing.T) {
	if os.Getenv("AO_SIGPIPE_HELPER") == "1" {
		ignoreBrokenPipeSignal()
		_, _ = os.Stderr.Write([]byte("closed pipe\n"))
		os.Exit(0)
	}

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=TestIgnoreBrokenPipeSignalAllowsClosedStdoutStderr")
	cmd.Env = append(os.Environ(), "AO_SIGPIPE_HELPER=1")
	cmd.Stdout = w
	cmd.Stderr = w
	if err := cmd.Start(); err != nil {
		t.Fatalf("start helper: %v", err)
	}
	_ = w.Close()
	_ = r.Close()

	if err := cmd.Wait(); err != nil {
		t.Fatalf("helper exited after writing to closed stderr: %v", err)
	}
}
