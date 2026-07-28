package preview

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// DefaultPollInterval is the preview poller's scan interval when none is configured.
const DefaultPollInterval = 250 * time.Millisecond

type sessionPreviewSource interface {
	ListAllSessions(ctx context.Context) ([]domain.SessionRecord, error)
}

type previewSetter interface {
	SetPreview(ctx context.Context, id domain.SessionID, previewURL string) (domain.Session, error)
}

// PollerConfig configures preview poller timing and logging.
type PollerConfig struct {
	Interval time.Duration
	Logger   *slog.Logger
}

// Poller watches active worker workspaces for static frontend entrypoints and
// persists preview URL refreshes through the normal session service path.
type Poller struct {
	source   sessionPreviewSource
	setter   previewSetter
	baseURL  string
	interval time.Duration
	logger   *slog.Logger
	seen     map[domain.SessionID]entryState
}

type entryState struct {
	path         string
	signature    uint64
	entryModUnix int64
	entrySize    int64
	// pending records a relevant file change observed while the worker was
	// active. The final target is persisted only after the worker reaches an
	// end-of-work activity state.
	pending bool
	// missing baselines a workspace before any previewable file exists. A file
	// created later is a real change, unlike a Markdown file already present
	// when the daemon first observes the session.
	missing bool
	// cleared is set when the poller itself cleared the preview URL because the
	// workspace entry was missing. When the file reappears, shouldRefresh uses
	// this to re-discover even though the revision was bumped by the clear.
	cleared bool
}

// NewPoller constructs a preview poller over the supplied session source and setter.
func NewPoller(source sessionPreviewSource, setter previewSetter, baseURL string, cfg PollerConfig) *Poller {
	p := &Poller{
		source:   source,
		setter:   setter,
		baseURL:  baseURL,
		interval: cfg.Interval,
		logger:   cfg.Logger,
		seen:     map[domain.SessionID]entryState{},
	}
	if p.interval <= 0 {
		p.interval = DefaultPollInterval
	}
	if p.logger == nil {
		p.logger = slog.Default()
	}
	return p
}

// Start runs an immediate poll followed by interval polling until ctx is
// cancelled. The returned channel closes after the goroutine exits.
func (p *Poller) Start(ctx context.Context) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		p.pollAndLog(ctx)
		ticker := time.NewTicker(p.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				p.pollAndLog(ctx)
			}
		}
	}()
	return done
}

func (p *Poller) pollAndLog(ctx context.Context) {
	if err := p.Poll(ctx); err != nil {
		p.logger.Error("preview poller: poll failed", "err", err)
	}
}

// Poll performs one deterministic scan of active worker sessions.
func (p *Poller) Poll(ctx context.Context) error {
	if p.source == nil || p.setter == nil {
		return nil
	}
	sessions, err := p.source.ListAllSessions(ctx)
	if err != nil {
		return fmt.Errorf("preview poller list sessions: %w", err)
	}
	activeIDs := make(map[domain.SessionID]struct{}, len(sessions))
	for _, sess := range sessions {
		if sess.IsTerminated {
			continue
		}
		activeIDs[sess.ID] = struct{}{}
		if sess.Kind != domain.KindWorker {
			continue
		}
		storedEntry, workspaceOwned := StoredWorkspaceEntry(sess.Metadata.PreviewURL, sess.ID)
		entry, ok := Entry{}, false
		if workspaceOwned {
			entry, ok = EntryAtPath(sess.Metadata.WorkspacePath, storedEntry)
		}
		if !ok {
			// A session the user has never explicitly previewed
			// (workspaceOwned == false) is only auto-previewed when it has a
			// real static-frontend entrypoint (index.html variants). The
			// mostRecentPreviewable .md/.html fallback is intentionally NOT
			// applied here, otherwise every new session in a Markdown-rich repo
			// auto-opens its browser to an arbitrary repo doc. Once a session
			// has been explicitly previewed (workspaceOwned == true), full
			// DiscoverEntry — including the document fallback — keeps the
			// preview fresh. See issue #2859.
			if workspaceOwned {
				entry, ok = DiscoverEntry(sess.Metadata.WorkspacePath)
			} else {
				entry, ok = DiscoverWebEntrypoint(sess.Metadata.WorkspacePath)
				if !ok {
					// Track fallback documents without initially surfacing an
					// arbitrary repo doc. A later creation or edit is a real
					// session change and may then open the preview.
					entry, ok = DiscoverEntry(sess.Metadata.WorkspacePath)
				}
			}
		}
		if !ok {
			if workspaceOwned {
				if _, err := p.setter.SetPreview(ctx, sess.ID, ""); err != nil {
					p.logger.Error("preview poller: failed to clear stale preview",
						"session", sess.ID, "err", err)
				}
				p.seen[sess.ID] = entryState{cleared: true}
			} else if previous, exists := p.seen[sess.ID]; !exists || !previous.cleared {
				p.seen[sess.ID] = entryState{missing: true}
			}
			continue
		}
		target, err := FileURL(p.baseURL, sess.ID, entry.Path)
		if err != nil {
			p.logger.Error("preview poller: cannot build isolated preview URL", "session", sess.ID, "err", err)
			p.seen[sess.ID] = stateFor(entry, false)
			continue
		}
		current := strings.TrimSpace(sess.Metadata.PreviewURL)
		// Recursively fingerprint assets only while this exact workspace-owned
		// static preview is active. Hidden entries and external dev servers do
		// not need a full workspace walk on every poll.
		state := stateFor(entry, workspaceOwned && current == target)
		previous, seenBefore := p.seen[sess.ID]
		if seenBefore && previous == state {
			continue
		}
		entryChanged := seenBefore &&
			(previous.path != state.path ||
				previous.entryModUnix != state.entryModUnix ||
				previous.entrySize != state.entrySize)
		pending := seenBefore && previous.pending
		if !p.shouldRefresh(sess, target, seenBefore, workspaceOwned, entryChanged, pending) {
			p.seen[sess.ID] = state
			continue
		}
		if !previewReady(sess.Activity.State) {
			state.pending = true
			p.seen[sess.ID] = state
			continue
		}
		if _, err := p.setter.SetPreview(ctx, sess.ID, target); err != nil {
			return fmt.Errorf("preview poller set preview %s: %w", sess.ID, err)
		}
		// The preview is active after a successful set, so baseline its served
		// tree now and avoid a redundant refresh on the next poll.
		p.seen[sess.ID] = stateFor(entry, true)
	}
	for id := range p.seen {
		if _, ok := activeIDs[id]; !ok {
			delete(p.seen, id)
		}
	}
	return nil
}

func (p *Poller) shouldRefresh(
	sess domain.SessionRecord,
	target string,
	seenBefore bool,
	workspaceOwned bool,
	entryChanged bool,
	pending bool,
) bool {
	if pending {
		return true
	}
	current := strings.TrimSpace(sess.Metadata.PreviewURL)
	if current == "" {
		if !seenBefore {
			return false
		}
		if entryChanged {
			return true
		}
		previous := p.seen[sess.ID]
		return previous.cleared || previous.missing
	}
	if current == target {
		return seenBefore
	}
	return workspaceOwned
}

func previewReady(state domain.ActivityState) bool {
	return state == domain.ActivityIdle ||
		state == domain.ActivityWaitingInput ||
		state == domain.ActivityExited
}

func stateFor(entry Entry, includeAssets bool) entryState {
	state := entryState{
		path:         entry.Path,
		entryModUnix: entry.ModTime.UnixNano(),
		entrySize:    entry.Size,
	}
	if includeAssets {
		state.signature = staticTreeSignature(entry)
	}
	return state
}
