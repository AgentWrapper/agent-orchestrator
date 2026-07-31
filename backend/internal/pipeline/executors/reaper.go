package executors

import "time"

// ProcessGroupReaper terminates a process group a previous daemon started and
// then lost. Restart reconciliation settles such a stage, but the handle that
// could stop it died with the process that held it (decision D16), so without
// this the settled stage's work keeps running unowned.
//
// Reap is deliberately timid about pid reuse: a pgid recorded before a reboot
// can name something else entirely afterwards, and killing a stranger's process
// group is far worse than leaking one of ours. When it cannot confirm the group
// is the one the stage launched, it leaves it running and says so.
type ProcessGroupReaper interface {
	// Reap terminates process group pgid when its leader still looks like the
	// process launched at startedAt. clause is the honest phrase for the
	// stage's settle reason, empty when there was no group to reap at all;
	// leaked is true when a live group had to be left running.
	Reap(pgid int, startedAt time.Time) (clause string, leaked bool)
}

// reapStartSkew is how far the OS-reported start time of a process group's
// leader may sit from the moment the engine recorded launching it before the
// group counts as somebody else's. The two are stamped within milliseconds of
// each other, so the window only has to cover spawn latency and the one-second
// resolution ps reports a start time at. Anything wider starts admitting the
// reused pid it exists to exclude.
const reapStartSkew = 5 * time.Second
