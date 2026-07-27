//go:build windows

package ptyregistry

import (
	"github.com/aoagents/agent-orchestrator/backend/internal/processalive"
)

// defaultPidAlive probes PID liveness on Windows.
func defaultPidAlive(pid int) bool {
	return processalive.Alive(pid)
}
