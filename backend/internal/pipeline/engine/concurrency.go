// Package engine runs pipelines. This file holds the concurrency table, the
// bookkeeping behind spec section 10: runs that share an effective concurrency
// key serialize, queue depth is 1, and `cancel-in-progress` lets a newcomer
// take the key from the run holding it.
package engine

import (
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/pipeline"
)

// groupKey is the effective concurrency key: the literal group name paired
// with the resolved scope identity. `group` decides which pipelines share a
// bucket, `scope` decides which runs collide (spec section 10).
type groupKey struct{ Group, ScopeIdentity string }

// keyFor builds the effective concurrency key for one definition and the
// subject a run is about. The group defaults to the pipeline name and the
// scope to the subject's natural scope, which Subject.ScopeIdentity already
// resolves for an unset value.
func keyFor(def pipeline.Definition, subject pipeline.Subject) groupKey {
	group := def.Config.Concurrency.Group
	if group == "" {
		group = def.Config.Name
	}
	return groupKey{
		Group:         group,
		ScopeIdentity: subject.ScopeIdentity(def.Config.Concurrency.Scope),
	}
}

// ungrouped reports whether the subject has no identity at the requested
// scope, for instance a project subject under `scope: pr`. Such a run
// serializes against nothing, per Subject.ScopeIdentity.
func (k groupKey) ungrouped() bool { return k.ScopeIdentity == "" }

// pendingTrigger is a trigger waiting for its key to free up. It carries what
// the supervisor needs to start the run once Release hands it back, which is
// the trigger request it arrived on plus the run id.
//
// The run id is allocated before admission so that admission and release are
// each a single atomic decision: the table can move a trigger from queued to
// running without a window where the key is held by nobody. A trigger evicted
// from the queue simply drops its id, which costs nothing.
type pendingTrigger struct {
	Definition pipeline.Definition
	Event      string
	Subject    pipeline.Subject
	RunID      pipeline.RunID
}

// AdmissionKind is what the supervisor must do with a trigger it just offered
// to the table.
type AdmissionKind string

// Every admission outcome.
const (
	// StartNow means the trigger holds the key and the run starts immediately.
	StartNow AdmissionKind = "start-now"
	// Queued means a run holds the key and the trigger waits for it. Queue
	// depth is 1, so this trigger replaced any previously queued one.
	Queued AdmissionKind = "queued"
	// CancelThenStart means `cancel-in-progress` is set and a run held the
	// key: cancel the victim, then start this trigger, which now holds it.
	CancelThenStart AdmissionKind = "cancel-then-start"
)

// Admission is the table's answer for one trigger.
type Admission struct {
	Kind AdmissionKind
	// Victim is the in-flight run to cancel, set only for CancelThenStart.
	Victim pipeline.RunID
}

// ConcurrencyTable tracks which run holds each effective concurrency key and
// which trigger is waiting for it. The supervisor calls it from more than one
// goroutine, so every method takes the mutex. The zero value is ready to use.
type ConcurrencyTable struct {
	mu      sync.Mutex
	running map[groupKey]pipeline.RunID
	queued  map[groupKey]pendingTrigger
}

// Admit decides what happens to a trigger that wants key. cancelInProgress is
// the arriving pipeline's `concurrency.cancel-in-progress`, read per arrival
// because two pipelines sharing a group need not agree on it.
func (t *ConcurrencyTable) Admit(key groupKey, cancelInProgress bool, trigger pendingTrigger) Admission {
	if key.ungrouped() {
		return Admission{Kind: StartNow}
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	victim, held := t.running[key]
	if !held {
		t.hold(key, trigger.RunID)
		return Admission{Kind: StartNow}
	}
	if cancelInProgress {
		// cancel-in-progress targets the in-flight run only. A trigger already
		// waiting keeps its place and starts when this one settles.
		t.hold(key, trigger.RunID)
		return Admission{Kind: CancelThenStart, Victim: victim}
	}
	// Queue depth is 1: this trigger replaces any previously queued one rather
	// than stacking behind it (spec section 10).
	if t.queued == nil {
		t.queued = make(map[groupKey]pendingTrigger)
	}
	t.queued[key] = trigger
	return Admission{Kind: Queued}
}

// Release gives up key on behalf of a settled run and returns the trigger that
// was waiting for it, if any. The returned trigger already holds the key, so
// the caller starts it without admitting it again.
//
// runID is the run that settled. A run that no longer holds the key releases
// nothing: that is the ordinary cancel-in-progress path, where the victim
// settles after its replacement has already taken the key.
func (t *ConcurrencyTable) Release(key groupKey, runID pipeline.RunID) (pendingTrigger, bool) {
	if key.ungrouped() {
		return pendingTrigger{}, false
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	if holder, held := t.running[key]; !held || holder != runID {
		return pendingTrigger{}, false
	}
	next, queued := t.queued[key]
	if !queued {
		delete(t.running, key)
		return pendingTrigger{}, false
	}
	delete(t.queued, key)
	t.hold(key, next.RunID)
	return next, true
}

// hold records runID as the holder of key. The caller holds the mutex.
func (t *ConcurrencyTable) hold(key groupKey, runID pipeline.RunID) {
	if t.running == nil {
		t.running = make(map[groupKey]pipeline.RunID)
	}
	t.running[key] = runID
}
