package session

import (
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// workspaceCacheTTL bridges the short window between a session's workspace
// file list loading and the user immediately expanding a file, so the
// expansion doesn't redundantly re-resolve the compare base and re-run the
// same git status/diff/numstat calls the list request just made. It is not
// the primary correctness mechanism for freshness — the filesystem watcher
// that powers the workspace SSE stream invalidates entries the instant a
// real change is observed (see Service.InvalidateWorkspaceCache). The TTL
// only matters as a backstop for the brief window before that watcher
// connects.
const workspaceCacheTTL = 3 * time.Second

type workspaceCacheKey struct {
	session domain.SessionID
	root    string
}

// String gives workspaceCacheKey a stable identity for use as a
// singleflight.Group key. NUL can't appear in a session ID or filesystem
// path, so it's a safe separator against collisions between the two fields.
func (k workspaceCacheKey) String() string {
	return string(k.session) + "\x00" + k.root
}

type workspaceCacheEntry struct {
	at      time.Time
	compare workspaceCompareTarget
	changes workspaceChangeSet
}

type workspaceCache struct {
	mu      sync.Mutex
	ttl     time.Duration
	now     func() time.Time
	entries map[workspaceCacheKey]workspaceCacheEntry
}

func newWorkspaceCache(ttl time.Duration, now func() time.Time) *workspaceCache {
	if now == nil {
		now = time.Now
	}
	return &workspaceCache{ttl: ttl, now: now, entries: make(map[workspaceCacheKey]workspaceCacheEntry)}
}

// get, set, and invalidateSession are nil-receiver-safe: a *Service built via
// a bare struct literal (common in this package's tests) leaves
// workspaceCache nil, and a nil cache should behave as permanently empty
// rather than panicking or requiring every construction site to remember
// initialization — the same nil-safe idiom Go gives nil maps and slices.
func (c *workspaceCache) get(key workspaceCacheKey) (workspaceCacheEntry, bool) {
	if c == nil {
		return workspaceCacheEntry{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if !ok {
		return workspaceCacheEntry{}, false
	}
	if c.now().Sub(entry.at) > c.ttl {
		delete(c.entries, key)
		return workspaceCacheEntry{}, false
	}
	return entry, true
}

func (c *workspaceCache) set(key workspaceCacheKey, entry workspaceCacheEntry) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = entry
}

// invalidateSession purges every cached entry for a session, across every
// worktree root it spans (workspace projects can span several repos).
func (c *workspaceCache) invalidateSession(id domain.SessionID) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for key := range c.entries {
		if key.session == id {
			delete(c.entries, key)
		}
	}
}
