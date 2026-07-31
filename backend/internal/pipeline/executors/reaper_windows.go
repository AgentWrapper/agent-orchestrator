//go:build windows

package executors

import "time"

// osProcessGroupReaper is the production ProcessGroupReaper.
type osProcessGroupReaper struct{}

// NewProcessGroupReaper builds the production reaper.
func NewProcessGroupReaper() ProcessGroupReaper { return osProcessGroupReaper{} }

// Reap does nothing on Windows: configureProcAttr puts a command stage in no
// process group there, so processGroupID never records one and pgid is always
// 0. A Job Object would be the way to make this reapable, the same gap
// killProcessTree already has.
func (osProcessGroupReaper) Reap(int, time.Time) (string, bool) { return "", false }
