//go:build !linux

package metrics

import "context"

// stubScopeCollector reports no per-session scopes on non-Linux platforms:
// cgroup-per-session accounting is a Linux-specific mechanism.
type stubScopeCollector struct{}

// NewScopeCollector returns a stub collector on non-Linux platforms. The
// tmuxBinary argument is accepted for signature parity and ignored.
func NewScopeCollector(_ string) ScopeCollector { return stubScopeCollector{} }

// Scopes returns unavailable: cgroup-per-session accounting is unsupported, so
// callers must not treat an empty map as authoritative zero zombies.
func (stubScopeCollector) Scopes(_ context.Context) (map[string]uint64, bool, error) {
	return map[string]uint64{}, false, nil
}
