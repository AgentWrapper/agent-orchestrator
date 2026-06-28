// Package convergence implements the cross-session edit-collision observer. It
// is the proactive counterpart to the SCM observer's reactive merge-conflict
// handling: where the SCM lane learns about a conflict only after two agents
// have opened PRs that GitHub reports as conflicting, this lane watches the live
// worktree diffs of all parallel sessions in a project and detects that two
// agents are editing overlapping code BEFORE either opens a PR.
//
// The loop follows the repository's OBSERVE → UPDATE → DERIVE/ACT pipeline:
// OBSERVE each session's changed files/ranges via the workspace differ, UPDATE
// the durable session_collision facts, and ACT by nudging the colliding agents
// through lifecycle. It reuses observe.StartPollLoop for the polling goroutine.
package convergence

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/observe"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	// DefaultTickInterval is how often the observer recomputes cross-session
	// overlap. Worktree diffs are local git operations, so this is faster than
	// the SCM observer's network-bound cadence but slow enough to stay cheap.
	DefaultTickInterval = 20 * time.Second
	// maxFilesPerCollision bounds the per-pair file list so a sweeping refactor
	// in two sessions cannot produce an unbounded collision payload.
	maxFilesPerCollision = 50
)

// Differ reports the files (and changed line ranges) a session's worktree has
// modified relative to its base. ports.WorkspaceDiffer satisfies it.
type Differ interface {
	ChangedRegions(ctx context.Context, info ports.WorkspaceInfo) (map[string][]ports.LineRange, error)
}

// Store supplies the live session set and persists collision facts.
type Store interface {
	ListAllSessions(ctx context.Context) ([]domain.SessionRecord, error)
	ListAllCollisions(ctx context.Context) ([]domain.SessionCollision, error)
	UpsertCollision(ctx context.Context, c domain.SessionCollision) error
	DeleteCollision(ctx context.Context, a, b domain.SessionID) error
}

// Lifecycle is notified when a hot collision first appears (or its content
// changes) so it can send the coordinating agent nudge. It is optional; a nil
// Lifecycle disables nudging while still persisting facts.
type Lifecycle interface {
	ApplyCollision(ctx context.Context, c domain.CollisionWithNames) error
}

// Config holds optional observer knobs. Zero values use production defaults.
type Config struct {
	Tick   time.Duration
	Clock  func() time.Time
	Logger *slog.Logger
}

// Observer coordinates worktree diffing, overlap computation, persistence, and
// lifecycle nudges for cross-session edit collisions.
type Observer struct {
	differ    Differ
	store     Store
	lifecycle Lifecycle
	tick      time.Duration
	clock     func() time.Time
	logger    *slog.Logger
}

// New constructs an Observer, applying defaults for zero-valued cfg fields.
func New(differ Differ, store Store, lifecycle Lifecycle, cfg Config) *Observer {
	o := &Observer{differ: differ, store: store, lifecycle: lifecycle, tick: cfg.Tick, clock: cfg.Clock, logger: cfg.Logger}
	if o.tick <= 0 {
		o.tick = DefaultTickInterval
	}
	if o.clock == nil {
		o.clock = time.Now
	}
	if o.logger == nil {
		o.logger = slog.Default()
	}
	return o
}

// Start launches the polling loop and returns a channel closed when it exits.
func (o *Observer) Start(ctx context.Context) <-chan struct{} {
	return observe.StartPollLoop(ctx, o.tick, o.Poll, o.logger, "convergence observer")
}

// Poll runs one synchronous collision-detection cycle: diff every eligible
// session, compute pairwise overlaps per project, then reconcile the durable
// collision set (upsert changed pairs, delete pairs that no longer overlap) and
// nudge agents on hot collisions.
func (o *Observer) Poll(ctx context.Context) error {
	now := o.clock().UTC()
	sessions, err := o.store.ListAllSessions(ctx)
	if err != nil {
		return fmt.Errorf("convergence: list sessions: %w", err)
	}

	byProject := map[domain.ProjectID][]domain.SessionRecord{}
	for _, s := range sessions {
		if !eligible(s) {
			continue
		}
		byProject[s.ProjectID] = append(byProject[s.ProjectID], s)
	}

	desired := map[pairKey]domain.CollisionWithNames{}
	for project, group := range byProject {
		if len(group) < 2 {
			continue
		}
		o.collisionsForProject(ctx, project, group, now, desired)
	}

	existing, err := o.store.ListAllCollisions(ctx)
	if err != nil {
		return fmt.Errorf("convergence: list collisions: %w", err)
	}
	o.reconcile(ctx, existing, desired)
	return nil
}

// collisionsForProject diffs each session in one project and records every
// overlapping pair into desired.
func (o *Observer) collisionsForProject(ctx context.Context, project domain.ProjectID, group []domain.SessionRecord, now time.Time, desired map[pairKey]domain.CollisionWithNames) {
	regions := make(map[domain.SessionID]map[string][]ports.LineRange, len(group))
	for _, s := range group {
		r, err := o.differ.ChangedRegions(ctx, workspaceInfo(s))
		if err != nil {
			o.logger.Warn("convergence: diff failed", "session", string(s.ID), "err", err)
			continue
		}
		if len(r) > 0 {
			regions[s.ID] = r
		}
	}

	for i := 0; i < len(group); i++ {
		for j := i + 1; j < len(group); j++ {
			a, b := group[i], group[j]
			ra, okA := regions[a.ID]
			rb, okB := regions[b.ID]
			if !okA || !okB {
				continue
			}
			files, severity := overlap(ra, rb)
			if len(files) == 0 {
				continue
			}
			sa, sb, na, nb := canonicalPair(a, b)
			c := domain.SessionCollision{
				ProjectID:   project,
				SessionA:    sa,
				SessionB:    sb,
				Severity:    severity,
				Files:       files,
				Signature:   signature(severity, files),
				FirstSeenAt: now,
				UpdatedAt:   now,
			}
			desired[pairKey{sa, sb}] = domain.CollisionWithNames{SessionCollision: c, NameA: na, NameB: nb}
		}
	}
}

// reconcile makes the stored collision set match desired: upsert pairs that are
// new or whose signature changed (preserving the original FirstSeenAt), delete
// pairs that no longer overlap, and notify lifecycle for hot collisions whose
// content changed.
func (o *Observer) reconcile(ctx context.Context, existing []domain.SessionCollision, desired map[pairKey]domain.CollisionWithNames) {
	prev := make(map[pairKey]domain.SessionCollision, len(existing))
	for _, c := range existing {
		prev[pairKey{c.SessionA, c.SessionB}] = c
	}

	for key, want := range desired {
		old, had := prev[key]
		if had && old.Signature == want.Signature {
			continue // unchanged overlap: nothing to write or re-nudge.
		}
		if err := o.store.UpsertCollision(ctx, want.SessionCollision); err != nil {
			o.logger.Error("convergence: upsert collision failed", "pair", key.String(), "err", err)
			continue
		}
		if want.Severity == domain.CollisionHot && o.lifecycle != nil {
			if err := o.lifecycle.ApplyCollision(ctx, want); err != nil {
				o.logger.Error("convergence: lifecycle apply failed", "pair", key.String(), "err", err)
			}
		}
	}

	for key := range prev {
		if _, ok := desired[key]; ok {
			continue
		}
		if err := o.store.DeleteCollision(ctx, key.a, key.b); err != nil {
			o.logger.Error("convergence: delete collision failed", "pair", key.String(), "err", err)
		}
	}
}

type pairKey struct {
	a domain.SessionID
	b domain.SessionID
}

func (k pairKey) String() string { return string(k.a) + "|" + string(k.b) }

// eligible reports whether a session participates in collision detection: a live
// (non-terminated) worker with a materialised worktree. Orchestrators and seed
// rows (empty workspace path) are excluded.
func eligible(s domain.SessionRecord) bool {
	return s.Kind == domain.KindWorker && !s.IsTerminated && strings.TrimSpace(s.Metadata.WorkspacePath) != ""
}

func workspaceInfo(s domain.SessionRecord) ports.WorkspaceInfo {
	return ports.WorkspaceInfo{
		Path:      s.Metadata.WorkspacePath,
		Branch:    s.Metadata.Branch,
		SessionID: s.ID,
		ProjectID: s.ProjectID,
	}
}

// canonicalPair orders two sessions by ID so an unordered pair maps to one row,
// returning the ordered IDs and their matching display names.
func canonicalPair(x, y domain.SessionRecord) (a, b domain.SessionID, nameA, nameB string) {
	if x.ID <= y.ID {
		return x.ID, y.ID, displayName(x), displayName(y)
	}
	return y.ID, x.ID, displayName(y), displayName(x)
}

func displayName(s domain.SessionRecord) string {
	if n := strings.TrimSpace(s.DisplayName); n != "" {
		return n
	}
	return string(s.ID)
}

// overlap computes the shared changed files between two sessions' region maps.
// A file both touched is "hot" when their changed line ranges intersect (or
// either side changed the whole file, e.g. a deletion) and "soft" otherwise.
// The pair's severity is hot if any shared file is hot. The returned files are
// sorted by path and capped at maxFilesPerCollision.
func overlap(a, b map[string][]ports.LineRange) ([]domain.CollisionFile, domain.CollisionSeverity) {
	var paths []string
	for p := range a {
		if _, ok := b[p]; ok {
			paths = append(paths, p)
		}
	}
	if len(paths) == 0 {
		return nil, ""
	}
	sort.Strings(paths)
	if len(paths) > maxFilesPerCollision {
		paths = paths[:maxFilesPerCollision]
	}

	files := make([]domain.CollisionFile, 0, len(paths))
	severity := domain.CollisionSoft
	for _, p := range paths {
		inter := intersectRanges(a[p], b[p])
		hot := len(a[p]) == 0 || len(b[p]) == 0 || len(inter) > 0
		f := domain.CollisionFile{Path: p}
		if hot {
			severity = domain.CollisionHot
			f.Ranges = inter
		}
		files = append(files, f)
	}
	return files, severity
}

// intersectRanges returns the overlapping segments between two sets of line
// ranges, as [start,end] pairs sorted by start.
func intersectRanges(a, b []ports.LineRange) [][2]int {
	var out [][2]int
	for _, ra := range a {
		for _, rb := range b {
			start := max(ra.Start, rb.Start)
			end := min(ra.End, rb.End)
			if start <= end {
				out = append(out, [2]int{start, end})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i][0] < out[j][0] })
	return out
}

// signature is a stable content hash of a collision's severity and overlapping
// files/ranges. The observer writes a row only when this changes, and lifecycle
// nudges only when a hot signature is new, so a steady overlap is reported once.
func signature(severity domain.CollisionSeverity, files []domain.CollisionFile) string {
	var sb strings.Builder
	sb.WriteString(string(severity))
	for _, f := range files {
		sb.WriteByte('\n')
		sb.WriteString(f.Path)
		for _, r := range f.Ranges {
			sb.WriteByte(':')
			sb.WriteString(strconv.Itoa(r[0]))
			sb.WriteByte('-')
			sb.WriteString(strconv.Itoa(r[1]))
		}
	}
	sum := sha256.Sum256([]byte(sb.String()))
	return hex.EncodeToString(sum[:])
}
