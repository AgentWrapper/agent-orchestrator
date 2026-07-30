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

// Poller watches explicitly selected workspace previews and persists refreshes
// through the normal session service path. It never chooses a preview for a
// fresh worker: selection belongs to `ao preview`, a managed server start, or
// deliberate user navigation.
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
	pending                bool
	pendingPreviewURL      string
	pendingPreviewRevision int64
	// cleared is set when the poller itself cleared the preview URL because the
	// explicitly selected workspace entry was missing. The retained path lets
	// the poller restore that same entry if it reappears.
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
		previous, seenBefore := p.seen[sess.ID]
		restoringCleared := false
		if !workspaceOwned {
			// Only restore an entry after the poller itself cleared it because
			// the selected file temporarily disappeared. A blank fresh session
			// or an explicit user clear must remain blank.
			if strings.TrimSpace(sess.Metadata.PreviewURL) != "" ||
				!seenBefore ||
				!previous.cleared ||
				previous.path == "" {
				delete(p.seen, sess.ID)
				continue
			}
			storedEntry = previous.path
			workspaceOwned = true
			restoringCleared = true
		}
		entry, ok := EntryAtPath(sess.Metadata.WorkspacePath, storedEntry)
		if !ok {
			if workspaceOwned {
				if !restoringCleared {
					if _, err := p.setter.SetPreview(ctx, sess.ID, ""); err != nil {
						p.logger.Error("preview poller: failed to clear stale preview",
							"session", sess.ID, "err", err)
					}
				}
				p.seen[sess.ID] = entryState{path: storedEntry, cleared: true}
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
		if seenBefore && previous == state {
			continue
		}
		pending := seenBefore && previous.pending
		if !p.shouldRefresh(sess, target, seenBefore, workspaceOwned, pending) {
			p.seen[sess.ID] = state
			continue
		}
		automaticRefresh := current == target || restoringCleared || pending
		if automaticRefresh && !previewReady(sess.Activity.State) {
			state.pending = true
			state.pendingPreviewURL = current
			state.pendingPreviewRevision = sess.Metadata.PreviewRevision
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
	pending bool,
) bool {
	if pending {
		previous := p.seen[sess.ID]
		if strings.TrimSpace(sess.Metadata.PreviewURL) != previous.pendingPreviewURL ||
			sess.Metadata.PreviewRevision != previous.pendingPreviewRevision {
			return false
		}
		return true
	}
	current := strings.TrimSpace(sess.Metadata.PreviewURL)
	if current == "" {
		return seenBefore && p.seen[sess.ID].cleared
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
