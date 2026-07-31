//go:build !windows

package executors

import (
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// psStartLayout is the format `ps -o lstart=` prints under LC_ALL=C on both
// macOS and Linux, for instance "Mon Jul 27 19:27:59 2026". The day of month is
// space padded, which _2 accepts.
const psStartLayout = "Mon Jan _2 15:04:05 2006"

// osProcessGroupReaper is the production ProcessGroupReaper.
type osProcessGroupReaper struct{}

// NewProcessGroupReaper builds the production reaper.
func NewProcessGroupReaper() ProcessGroupReaper { return osProcessGroupReaper{} }

// Reap kills the group only when the group leader's start time, which the
// kernel keeps across an exec, matches the moment the stage was launched. That
// is the identity check: `sh -c cmd` usually execs into cmd, so the leader's
// argv is not stable across the life of a stage, but its start time is.
func (osProcessGroupReaper) Reap(pgid int, startedAt time.Time) (string, bool) {
	if pgid <= 0 {
		return "", false
	}
	// Signal 0 against the whole group. ESRCH means every member is gone, so
	// there is nothing to reap and nothing to be careful about. EPERM means the
	// group exists but belongs to another user, which the identity check below
	// is about to reject anyway.
	if err := syscall.Kill(-pgid, 0); err != nil && !errors.Is(err, syscall.EPERM) {
		return fmt.Sprintf("its process group %d had already exited", pgid), false
	}
	started, ok := processStartTime(pgid)
	if !ok {
		// The group still has members but its leader is gone, so nothing is
		// left to identify it by. Leak it rather than guess.
		return fmt.Sprintf("its process group %d is still alive but its leader is gone, so it could not be identified and was left running", pgid), true
	}
	if skew := started.Sub(startedAt); skew > reapStartSkew || skew < -reapStartSkew {
		return fmt.Sprintf("process group %d now leads a process started at %s, not the one launched at %s, so it was left running",
			pgid, started.UTC().Format(time.RFC3339), startedAt.UTC().Format(time.RFC3339)), true
	}
	killProcessGroup(pgid)
	return fmt.Sprintf("its process group %d was still alive and has been killed", pgid), false
}

// processStartTime asks ps when pid started. LC_ALL=C pins lstart's format,
// which is otherwise locale dependent. A pid with no row, or a row that does
// not parse, reports not-found: every caller treats that as "cannot identify".
func processStartTime(pid int) (time.Time, bool) {
	cmd := exec.Command("ps", "-o", "lstart=", "-p", strconv.Itoa(pid))
	cmd.Env = append(cmd.Environ(), "LC_ALL=C")
	out, err := cmd.Output()
	if err != nil {
		return time.Time{}, false
	}
	started, err := time.ParseInLocation(psStartLayout, strings.TrimSpace(string(out)), time.Local)
	if err != nil {
		return time.Time{}, false
	}
	return started, true
}
