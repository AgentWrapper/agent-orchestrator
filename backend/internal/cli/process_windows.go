//go:build windows

package cli

import (
	"syscall"

	"golang.org/x/sys/windows"
)

// detachSysProcAttr starts the daemon in a new process group so it does not
// receive the console's CTRL_C/CTRL_BREAK while `ao start` waits for readiness.
func detachSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
}

// terminateProcessGroup asks pid's process group to exit gracefully via
// CTRL_BREAK_EVENT (the daemon was spawned with CREATE_NEW_PROCESS_GROUP, so
// this reaches the whole group without also breaking the ensure process).
// There is no POSIX-style SIGTERM on Windows, so this is the closest
// equivalent; killProcessGroup is the hard fallback.
func terminateProcessGroup(pid int) error {
	return windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, uint32(pid))
}

// killProcessGroup force-terminates pid directly (no process-group
// broadcast primitive is used here; TerminateProcess is unconditional).
func killProcessGroup(pid int) error {
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer func() { _ = windows.CloseHandle(handle) }()
	return windows.TerminateProcess(handle, 1)
}
