package metrics

import (
	"context"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/observe"
)

// DefaultTickInterval is the coarse cadence used when Config.Tick is zero. The
// design sketch calls for a ~30s tick: this is telemetry, not an interactive
// liveness probe.
const DefaultTickInterval = 30 * time.Second

// DefaultHistory is how many recent snapshots the observer retains for the
// /api/v1/metrics short-history payload when Config.History is zero.
const DefaultHistory = 20

// DefaultCostWindow is the rolling window used for token/cost aggregation when
// Config.CostWindow is zero.
const DefaultCostWindow = time.Hour

// SessionSource lists the current session rows so the observer can compute
// per-project counts and match cgroup scopes to live sessions.
type SessionSource interface {
	ListAllSessions(ctx context.Context) ([]domain.SessionRecord, error)
}

// HostCollector reads machine-wide host facts (load, memory, disk-free on the
// data-dir volume). Implementations are platform-specific; a stub returns a
// zero Host on unsupported platforms.
type HostCollector interface {
	Host(ctx context.Context) (Host, error)
}

// ScopeCollector reads per-session cgroup-scope memory. It returns one reading
// per live runtime scope keyed by the scope's runtime handle id (the tmux
// session name), which the observer matches against session rows.
type ScopeCollector interface {
	Scopes(ctx context.Context) (map[string]uint64, error)
}

// CostAggregator sums token/cost telemetry over a rolling window ending now.
type CostAggregator interface {
	Aggregate(ctx context.Context, since time.Time) (Cost, error)
}

// AlertSink receives one call per alert state transition (firing or cleared).
// It is best-effort: a slow or failing sink must never stall the tick.
type AlertSink interface {
	EmitAlert(ctx context.Context, t AlertTransition)
}

// AlertSinkFunc adapts a function to AlertSink.
type AlertSinkFunc func(ctx context.Context, t AlertTransition)

// EmitAlert calls f.
func (f AlertSinkFunc) EmitAlert(ctx context.Context, t AlertTransition) { f(ctx, t) }

// Config holds the observer's tunable knobs. Zero values fall back to defaults.
type Config struct {
	// Tick is the poll cadence. <=0 uses DefaultTickInterval.
	Tick time.Duration
	// History is the number of retained snapshots. <=0 uses DefaultHistory.
	History int
	// CostWindow is the rolling window for cost aggregation. <=0 uses
	// DefaultCostWindow.
	CostWindow time.Duration
	// Thresholds configures alerting; a zero field disables that alert.
	Thresholds Thresholds
	// Clock supplies snapshot timestamps. nil means time.Now.
	Clock func() time.Time
	// Logger receives operational diagnostics. nil means slog.Default.
	Logger *slog.Logger
}

// Deps bundles the collectors the observer reads from. Any nil collector is
// treated as "not available" and contributes zero/empty facts rather than an
// error, so the observer degrades cleanly on platforms or hosts missing a
// source.
type Deps struct {
	Sessions SessionSource
	Host     HostCollector
	Scopes   ScopeCollector
	Cost     CostAggregator
	Alerts   AlertSink
}

// Observer polls the collectors, computes a Snapshot, folds thresholds, retains
// a bounded history, and emits alert transitions.
type Observer struct {
	deps       Deps
	tick       time.Duration
	maxHistory int
	costWindow time.Duration
	clock      func() time.Time
	logger     *slog.Logger

	evalMu sync.Mutex // guards eval; Tick may be driven from tests concurrently
	eval   *evaluator

	mu      sync.RWMutex
	history []Snapshot
}

// New constructs an Observer with safe defaults.
func New(deps Deps, cfg Config) *Observer {
	o := &Observer{
		deps:       deps,
		tick:       cfg.Tick,
		maxHistory: cfg.History,
		costWindow: cfg.CostWindow,
		clock:      cfg.Clock,
		logger:     cfg.Logger,
		eval:       newEvaluator(cfg.Thresholds),
	}
	if o.tick <= 0 {
		o.tick = DefaultTickInterval
	}
	if o.maxHistory <= 0 {
		o.maxHistory = DefaultHistory
	}
	if o.costWindow <= 0 {
		o.costWindow = DefaultCostWindow
	}
	if o.clock == nil {
		o.clock = time.Now
	}
	if o.logger == nil {
		o.logger = slog.Default()
	}
	return o
}

// Start launches the poll loop; the first poll runs immediately inside the
// goroutine so daemon startup is not blocked. The returned channel closes when
// the loop exits.
func (o *Observer) Start(ctx context.Context) <-chan struct{} {
	return observe.StartPollLoop(ctx, o.tick, o.pollErr, o.logger, "metrics observer")
}

// pollErr adapts Tick to the poll-loop signature. Tick never returns an error
// (per-collector failures are logged and degrade to zero facts), so this always
// returns nil; the signature exists only to satisfy StartPollLoop.
func (o *Observer) pollErr(ctx context.Context) error {
	o.Tick(ctx)
	return nil
}

// Tick runs one observation cycle synchronously: collect, aggregate, evaluate
// thresholds, retain, and emit transitions. Exported so the daemon and tests can
// drive cycles deterministically. It returns the snapshot it produced.
func (o *Observer) Tick(ctx context.Context) Snapshot {
	now := o.clock().UTC()
	snap := Snapshot{CollectedAt: now}

	if o.deps.Host != nil {
		// The collector returns a partially-filled Host plus the first error; a
		// single failing source (e.g. a transient statfs) must not discard the
		// load/memory it did read. Zero fields already read as "unknown"
		// everywhere downstream, so assign the Host regardless and just log.
		host, err := o.deps.Host.Host(ctx)
		if err != nil {
			o.logger.Warn("metrics observer: host collect failed (best-effort)", "err", err)
		}
		snap.Host = host
	}

	var scopeMem map[string]uint64
	// scopesKnown is false when a wired scope collector failed this tick. The
	// zombie count is derived from scopes with no live session; if scope
	// collection failed we cannot judge zombies, so a scope error must not be
	// read as "zero scopes / zero zombies" and spuriously CLEAR a firing zombie
	// alert (the mirror of the sessions-error case). A nil collector is a valid
	// "no scopes" configuration and stays known.
	scopesKnown := true
	if o.deps.Scopes != nil {
		if scopes, err := o.deps.Scopes.Scopes(ctx); err != nil {
			o.logger.Warn("metrics observer: scope collect failed", "err", err)
			scopesKnown = false
		} else {
			scopeMem = scopes
		}
	}

	var sessions []domain.SessionRecord
	// sessionsKnown is false when we have no reliable view of the live session
	// set this tick (no source wired, or the query failed). Without it, an empty
	// sessions slice would mark every live scope as unmatched and fabricate a
	// zombie per scope, firing a fleet-wide leak alert on a mere DB hiccup.
	sessionsKnown := false
	if o.deps.Sessions != nil {
		if rows, err := o.deps.Sessions.ListAllSessions(ctx); err != nil {
			o.logger.Warn("metrics observer: list sessions failed", "err", err)
		} else {
			sessions = rows
			sessionsKnown = true
		}
	}

	// Zombies are trustworthy only when BOTH the live session set and the scope
	// set are known this tick.
	zombiesKnown := sessionsKnown && scopesKnown
	snap.zombiesKnown = zombiesKnown
	snap.Projects, snap.Scopes, snap.Zombies = aggregateSessions(sessions, scopeMem, zombiesKnown)

	if o.deps.Cost != nil {
		if cost, err := o.deps.Cost.Aggregate(ctx, now.Add(-o.costWindow)); err != nil {
			o.logger.Warn("metrics observer: cost aggregate failed", "err", err)
		} else {
			cost.WindowSeconds = int64(o.costWindow / time.Second)
			snap.Cost = cost
		}
	}

	o.evalMu.Lock()
	alerts, transitions := o.eval.evaluate(snap)
	o.evalMu.Unlock()
	snap.Alerts = alerts

	o.retain(snap)

	for _, t := range transitions {
		if o.deps.Alerts != nil {
			o.deps.Alerts.EmitAlert(ctx, t)
		}
		o.logAlert(t)
	}
	return snap
}

func (o *Observer) logAlert(t AlertTransition) {
	if t.Firing {
		o.logger.Warn("metrics observer: alert firing", "kind", t.Alert.Kind, "value", t.Alert.Value, "threshold", t.Alert.Threshold)
		return
	}
	o.logger.Info("metrics observer: alert cleared", "kind", t.Alert.Kind)
}

func (o *Observer) retain(s Snapshot) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.history = append(o.history, s)
	if len(o.history) > o.maxHistory {
		o.history = o.history[len(o.history)-o.maxHistory:]
	}
}

// Latest returns the most recent snapshot and whether one has been produced.
func (o *Observer) Latest() (Snapshot, bool) {
	o.mu.RLock()
	defer o.mu.RUnlock()
	if len(o.history) == 0 {
		return Snapshot{}, false
	}
	return o.history[len(o.history)-1], true
}

// History returns a copy of the retained snapshots, oldest-first.
func (o *Observer) History() []Snapshot {
	o.mu.RLock()
	defer o.mu.RUnlock()
	out := make([]Snapshot, len(o.history))
	copy(out, o.history)
	return out
}

// Snapshots returns the retained history (oldest-first) and the latest snapshot
// under a single read lock, so a tick landing between two separate calls cannot
// yield a latest that is newer than the last history element. hasLatest is false
// before the first tick.
func (o *Observer) Snapshots() (history []Snapshot, latest Snapshot, hasLatest bool) {
	o.mu.RLock()
	defer o.mu.RUnlock()
	history = make([]Snapshot, len(o.history))
	copy(history, o.history)
	if len(o.history) == 0 {
		return history, Snapshot{}, false
	}
	return history, o.history[len(o.history)-1], true
}

// aggregateSessions computes per-project counts, per-scope memory (matched to
// live sessions), and the machine-wide zombie count. A scope with no matching
// non-terminated session row is a zombie (leaked runtime / orphaned process).
//
// sessionsKnown reports whether the live session set is trustworthy this tick.
// When it is false (no session source, or the query failed) the live-handle set
// is unreliable, so scopes are reported as unmatched=unknown and NO zombies are
// counted — a DB hiccup must not masquerade as a fleet-wide leak.
func aggregateSessions(sessions []domain.SessionRecord, scopeMem map[string]uint64, sessionsKnown bool) ([]Project, []Scope, int) {
	byProject := map[string]*Project{}
	// handle id -> project id, for matching cgroup scopes to live sessions.
	liveHandles := map[string]string{}

	for _, s := range sessions {
		if s.IsTerminated {
			continue
		}
		pid := string(s.ProjectID)
		p := byProject[pid]
		if p == nil {
			p = &Project{ProjectID: pid, ByActivity: map[string]int{}}
			byProject[pid] = p
		}
		p.Sessions++
		state := string(s.Activity.State)
		if state == "" {
			state = string(domain.ActivityIdle)
		}
		p.ByActivity[state]++
		if h := s.Metadata.RuntimeHandleID; h != "" {
			liveHandles[h] = pid
		}
	}

	scopes := make([]Scope, 0, len(scopeMem))
	zombies := 0
	for name, mem := range scopeMem {
		_, matched := liveHandles[name]
		// When the session set is unknown we cannot judge a scope as matched;
		// report it unmatched but do not count it toward zombies.
		reportMatched := sessionsKnown && matched
		scopes = append(scopes, Scope{
			SessionID: name, // scope handle id == tmux session name == ao session id
			Name:      name,
			MemBytes:  mem,
			Matched:   reportMatched,
		})
		if sessionsKnown && !matched {
			zombies++
		}
	}
	sort.Slice(scopes, func(i, j int) bool { return scopes[i].Name < scopes[j].Name })

	projects := make([]Project, 0, len(byProject))
	for _, p := range byProject {
		projects = append(projects, *p)
	}
	sort.Slice(projects, func(i, j int) bool { return projects[i].ProjectID < projects[j].ProjectID })

	return projects, scopes, zombies
}
