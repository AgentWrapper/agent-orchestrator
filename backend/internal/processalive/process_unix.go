//go:build !windows

// Package processalive probes whether an operating-system process id still
// maps to a live process.
package processalive

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"syscall"
)

// Alive reports whether pid maps to a running process. EPERM counts as alive:
// the process exists even if the current user cannot signal it. Zombies are
// treated as not alive because the executable has already exited; only its
// parent has not reaped the process table entry yet.
func Alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	if err != nil && !errors.Is(err, syscall.EPERM) {
		return false
	}
	return !isZombie(pid)
}

func isZombie(pid int) bool {
	if runtime.GOOS == "linux" {
		state, err := linuxProcState(pid)
		if err == nil {
			return state == 'Z'
		}
		return false
	}
	out, err := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return false
	}
	return bytes.HasPrefix(bytes.TrimSpace(out), []byte("Z"))
}

func linuxProcState(pid int) (byte, error) {
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, err
	}
	return procStatState(stat)
}

func procStatState(stat []byte) (byte, error) {
	closeParen := bytes.LastIndexByte(stat, ')')
	if closeParen < 0 || closeParen+2 >= len(stat) || stat[closeParen+1] != ' ' {
		return 0, errors.New("malformed proc stat")
	}
	return stat[closeParen+2], nil
}
