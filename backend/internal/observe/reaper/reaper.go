// Package reaper implements the OBSERVE-layer polling timer that supplies the
// LCM with per-session runtime liveness probes.
//
// The reaper only reports facts — it never writes session rows directly. The LCM
// consumes these facts through ApplyRuntimeObservation. A probe error is
// reported as a probe-failure fact, never collapsed to "alive" or "dead".
package reaper

import (
	"context"
	"log/slog"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// DefaultTickInterval is the cadence used when Config.Tick is zero. It mirrors
// the design doc's 5s sampling window for runtime liveness.
const DefaultTickInterval = 5 * time.Second

// Config holds the externally-tunable knobs for a Reaper. Every field is
// optional; zero values fall back to safe defaults so production wiring and
// tests can both stay terse.
type Config struct {
	// Tick is the interval between ticks. <=0 means DefaultTickInterval.
	Tick time.Duration
	// Clock supplies ObservedAt stamps. nil means time.Now. Injected in tests so
	// assertions don't race wallclock.
	Clock func() time.Time
	// Logger receives operational diagnostics (probe errors, skipped sessions,
	// LCM call failures). The reaper logs but does not propagate these errors
	// because a single failed probe must not kill the loop. nil means
	// slog.Default.
	Logger *slog.Logger
}

type sessionSource interface {
	ListAllSessions(ctx context.Context) ([]domain.SessionRecord, error)
}

type runtimeObservationSink interface {
	ApplyRuntimeObservation(ctx context.Context, id domain.SessionID, f ports.RuntimeFacts) error
}

type runtimeProber interface {
	IsAlive(context.Context, ports.RuntimeHandle) (bool, error)
}

// Reaper is the polling timer. Construct it with New; start the background
// goroutine with Start, or drive a single cycle synchronously with Tick.
type Reaper struct {
	sink     runtimeObservationSink
	sessions sessionSource
	runtime  runtimeProber
	workload ports.SupervisedProcessInspector
	tick     time.Duration
	clock    func() time.Time
	logger   *slog.Logger
}

// New constructs a Reaper. sink is the lifecycle fact destination; sessions
// supplies the rows to probe; runtime checks whether a stored handle is alive.
func New(sink runtimeObservationSink, sessions sessionSource, runtime runtimeProber, cfg Config) *Reaper {
	r := &Reaper{
		sink:     sink,
		sessions: sessions,
		runtime:  runtime,
		tick:     cfg.Tick,
		clock:    cfg.Clock,
		logger:   cfg.Logger,
	}
	if workload, ok := runtime.(ports.SupervisedProcessInspector); ok {
		r.workload = workload
	}
	if r.tick <= 0 {
		r.tick = DefaultTickInterval
	}
	if r.clock == nil {
		r.clock = time.Now
	}
	if r.logger == nil {
		r.logger = slog.Default()
	}
	return r
}

// Start launches the background goroutine and returns a channel that closes
// once the loop has exited. The loop exits on ctx cancellation; the channel
// gives the daemon a clean shutdown hook (wait on it after cancel to confirm
// the reaper has stopped before tearing down dependencies).
func (r *Reaper) Start(ctx context.Context) <-chan struct{} {
	done := make(chan struct{})
	go r.loop(ctx, done)
	return done
}

func (r *Reaper) loop(ctx context.Context, done chan<- struct{}) {
	defer close(done)
	t := time.NewTicker(r.tick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := r.Tick(ctx); err != nil {
				r.logger.Error("reaper: tick failed", "err", err)
			}
		}
	}
}

// Tick runs one observation cycle: it enumerates non-terminated sessions,
// probes each one's runtime, and reports each result back as a fact.
//
// Tick is exported so the daemon (and tests) can drive cycles synchronously,
// and so the Start goroutine has a single chokepoint to log against.
//
// Errors: only the session-listing failure is propagated, since it short-
// circuits the rest of the cycle. Per-session ApplyRuntimeObservation failures
// are logged but never propagated — one failed call must not bring down the loop.
func (r *Reaper) Tick(ctx context.Context) error {
	now := r.clock()

	sessions, err := r.sessions.ListAllSessions(ctx)
	if err != nil {
		return err
	}

	for _, sess := range sessions {
		if sess.IsTerminated {
			continue
		}
		r.probeOne(ctx, sess, now)
	}
	return nil
}

// probeOne handles a single session's probe + fact-report. Every probe result —
// alive, dead, or failed — is reported as a fact to the LCM. The reaper does
// not optimize away the "alive" case; the reaper has no business deciding what
// counts as a no-op. The LCM diffs and only writes on actual change.
func (r *Reaper) probeOne(ctx context.Context, sess domain.SessionRecord, now time.Time) {
	handle, ok := handleFromRecord(sess)
	if !ok {
		// A session in the running-set without a handle is an anomaly worth
		// surfacing (MarkSpawned should have set both keys). Warn rather
		// than Debug so it doesn't hide behind a noisy log level.
		r.logger.Warn("reaper: session has no runtime handle metadata, skipping",
			"session", sess.ID)
		return
	}
	alive, probeErr := r.runtime.IsAlive(ctx, handle)
	facts := ports.RuntimeFacts{ObservedAt: now, LaunchID: sess.Metadata.RuntimeLaunchID, Workload: ports.ProbeFailed}
	switch {
	case probeErr != nil:
		// Failed probe must NOT be collapsed to alive — that would let a
		// transient tmux outage hide a really-dead session, and a
		// transient adapter bug terminate a really-alive one. Report failed
		// and let the LCM arbitrate.
		facts.Runtime = ports.ProbeFailed
		r.logger.Debug("reaper: probe error reported as failed fact",
			"session", sess.ID, "err", probeErr)
	case !alive:
		facts.Runtime = ports.ProbeDead
	default:
		facts.Runtime = ports.ProbeAlive
		if facts.LaunchID != "" && r.workload != nil {
			workloadAlive, workloadErr := r.workload.IsSupervisedProcessAlive(ctx, handle, ports.SupervisedProcessRef{
				SessionID: sess.ID,
				LaunchID:  facts.LaunchID,
			})
			switch {
			case workloadErr != nil:
				facts.Workload = ports.ProbeFailed
				r.logger.Debug("reaper: workload probe error reported as failed fact",
					"session", sess.ID, "launch", facts.LaunchID, "err", workloadErr)
			case workloadAlive:
				facts.Workload = ports.ProbeAlive
			default:
				facts.Workload = ports.ProbeDead
			}
		}
	}

	if err := r.sink.ApplyRuntimeObservation(ctx, sess.ID, facts); err != nil {
		r.logger.Error("reaper: ApplyRuntimeObservation failed",
			"session", sess.ID, "err", err)
	}
}

// handleFromRecord reconstructs the RuntimeHandle stored on the session by
// MarkSpawned. An empty handle id means the session cannot be probed.
func handleFromRecord(rec domain.SessionRecord) (ports.RuntimeHandle, bool) {
	id := rec.Metadata.RuntimeHandleID
	if id == "" {
		return ports.RuntimeHandle{}, false
	}
	return ports.RuntimeHandle{ID: id}, true
}
