//go:build !linux

package metrics

import (
	"context"
	"runtime"
)

// stubHostCollector reports only the CPU count on non-Linux platforms. Load,
// memory, and disk are left zero (unknown), which the threshold evaluator treats
// as "not collected" and never trips.
type stubHostCollector struct{}

// NewHostCollector returns a stub collector on non-Linux platforms. The dataDir
// argument is accepted for signature parity with the Linux build and ignored.
func NewHostCollector(_ string) HostCollector { return stubHostCollector{} }

// Host returns a Host with only NumCPU populated.
func (stubHostCollector) Host(_ context.Context) (Host, error) {
	return Host{NumCPU: runtime.NumCPU()}, nil
}
