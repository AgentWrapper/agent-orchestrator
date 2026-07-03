package domain

import "time"

// CollisionSeverity grades how strongly two parallel sessions overlap in the
// code they are changing. The convergence observer computes it from each
// session's worktree diff before either has opened a PR.
type CollisionSeverity string

const (
	// CollisionSoft means two sessions changed the same file(s) but their
	// changed line ranges do not intersect — a likely-resolvable overlap worth
	// surfacing but not worth interrupting an agent over.
	CollisionSoft CollisionSeverity = "soft"
	// CollisionHot means two sessions changed overlapping line ranges in the
	// same file — a near-certain future merge conflict. Hot collisions drive the
	// proactive agent nudge.
	CollisionHot CollisionSeverity = "hot"
)

// Valid reports whether s is a known severity.
func (s CollisionSeverity) Valid() bool {
	switch s {
	case CollisionSoft, CollisionHot:
		return true
	default:
		return false
	}
}

// CollisionFile is one file two sessions both changed, with the line ranges
// (in the newer revision) that overlap when the collision is hot. For soft
// collisions Ranges is empty.
type CollisionFile struct {
	Path   string   `json:"path"`
	Ranges [][2]int `json:"ranges,omitempty"`
}

// SessionCollision is the durable fact that two non-terminated worker sessions
// in the same project are concurrently editing overlapping code. SessionA and
// SessionB are stored in a stable lexical order (A < B) so each unordered pair
// has exactly one row.
type SessionCollision struct {
	ProjectID ProjectID
	SessionA  SessionID
	SessionB  SessionID
	Severity  CollisionSeverity
	// Files lists every overlapping path (for hot collisions, with the
	// overlapping line ranges). It is what the agent nudge and the dashboard
	// render.
	Files []CollisionFile
	// Signature is a content hash of (severity + files). The observer writes a
	// row only when the signature changes, and lifecycle nudges only when a
	// freshly hot signature appears, so a stable overlap is reported once.
	Signature   string
	FirstSeenAt time.Time
	UpdatedAt   time.Time
}

// DisplayNames is an optional, non-persisted enrichment the observer can attach
// before handing a collision to lifecycle so a nudge can name the peer session
// without an extra store read. Keyed by SessionID.
type CollisionWithNames struct {
	SessionCollision
	NameA string
	NameB string
}
