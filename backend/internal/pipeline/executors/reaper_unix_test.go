//go:build !windows

package executors

import (
	"errors"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
)

// startGroup spawns a shell that sleeps in a process group of its own, the way
// a command stage's `run:` block does, and returns its pgid and the moment it
// was launched. The child is killed on cleanup whether or not the test reaps it.
func startGroup(t *testing.T) (pgid int, startedAt time.Time) {
	t.Helper()
	cmd := exec.Command("sh", "-c", "sleep 60")
	configureProcAttr(cmd)
	startedAt = time.Now().UTC()
	if err := cmd.Start(); err != nil {
		t.Fatalf("start group: %v", err)
	}
	pgid = processGroupID(cmd)
	// Reap the child as it exits, the way the real runner's wait goroutine
	// does. Without it a killed child lingers as a zombie, which still answers
	// signal 0 on Linux and would read as a group that survived the reap.
	waited := make(chan struct{})
	go func() { defer close(waited); _ = cmd.Wait() }()
	t.Cleanup(func() {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		<-waited
	})
	return pgid, startedAt
}

// groupAlive reports whether any member of the process group is still around,
// on the same terms the reaper reads: EPERM means it exists and is somebody
// else's, which is still alive.
func groupAlive(pgid int) bool {
	err := syscall.Kill(-pgid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// waitGroupGone polls for the group to disappear. The reaper's SIGTERM is
// asynchronous, so the assertion has to wait for the signal to land.
func waitGroupGone(t *testing.T, pgid int) bool {
	t.Helper()
	for range 100 {
		if !groupAlive(pgid) {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

func TestReapKillsALiveProcessGroup(t *testing.T) {
	pgid, startedAt := startGroup(t)

	clause, leaked := NewProcessGroupReaper().Reap(pgid, startedAt)

	if leaked {
		t.Fatalf("leaked a group it launched itself: %q", clause)
	}
	if !strings.Contains(clause, "killed") {
		t.Fatalf("clause = %q, want it to say the group was killed", clause)
	}
	if !waitGroupGone(t, pgid) {
		t.Fatal("process group survived the reap")
	}
}

// The pid-reuse guard. A pgid recorded before a reboot can name a stranger's
// process afterwards, and killing that is far worse than leaking ours: a start
// time that does not match what the stage recorded means hands off.
func TestReapLeavesAGroupWhoseStartTimeDoesNotMatch(t *testing.T) {
	pgid, startedAt := startGroup(t)

	clause, leaked := NewProcessGroupReaper().Reap(pgid, startedAt.Add(-2*time.Hour))

	if !leaked {
		t.Fatalf("reaped a group that failed the identity check: %q", clause)
	}
	if !strings.Contains(clause, "left running") {
		t.Fatalf("clause = %q, want it to say the group was left running", clause)
	}
	// Give any stray signal the same window a real kill would have needed.
	time.Sleep(100 * time.Millisecond)
	if !groupAlive(pgid) {
		t.Fatal("a group that failed the identity check was killed anyway")
	}
}

func TestReapOnAGroupThatAlreadyExited(t *testing.T) {
	cmd := exec.Command("sh", "-c", "exit 0")
	configureProcAttr(cmd)
	startedAt := time.Now().UTC()
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	pgid := processGroupID(cmd)
	if err := cmd.Wait(); err != nil {
		t.Fatalf("wait: %v", err)
	}

	clause, leaked := NewProcessGroupReaper().Reap(pgid, startedAt)

	if leaked {
		t.Fatalf("leaked = true for a group that is gone: %q", clause)
	}
	if !strings.Contains(clause, "already exited") {
		t.Fatalf("clause = %q, want it to say the group had already exited", clause)
	}
}

// A stage that recorded no group (an agent stage, or one that never launched)
// has nothing to reap and nothing to say about it.
func TestReapWithoutAProcessGroupIsSilent(t *testing.T) {
	clause, leaked := NewProcessGroupReaper().Reap(0, time.Now())
	if clause != "" || leaked {
		t.Fatalf("Reap(0) = %q, %v; want an empty clause and no leak", clause, leaked)
	}
}

func TestProcessStartTimeMatchesTheSpawnMoment(t *testing.T) {
	pgid, startedAt := startGroup(t)

	started, ok := processStartTime(pgid)
	if !ok {
		t.Fatal("ps reported no start time for a process that is running")
	}
	if skew := started.Sub(startedAt); skew > reapStartSkew || skew < -reapStartSkew {
		t.Fatalf("start time %s is %s from the spawn at %s, more than the %s the reaper allows",
			started, skew, startedAt, reapStartSkew)
	}
	if _, ok := processStartTime(-1); ok {
		t.Fatal("processStartTime(-1) reported a start time")
	}
}
