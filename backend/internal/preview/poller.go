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

// DefaultAssetScanInterval limits recursive static-asset fingerprints. Entry
// metadata is still checked every poll, but nested assets are scanned at this
// substantially coarser cadence.
const DefaultAssetScanInterval = 5 * time.Second

type sessionPreviewSource interface {
	ListAllSessions(ctx context.Context) ([]domain.SessionRecord, error)
}

type previewSetter interface {
	CompareAndSetPreview(ctx context.Context, id domain.SessionID, expectedURL string, expectedRevision int64, previewURL string) (int64, bool, error)
	RefreshPreview(ctx context.Context, id domain.SessionID, expectedURL string, expectedRevision int64) (bool, error)
}

// PollerConfig configures preview poller timing and logging.
type PollerConfig struct {
	Interval          time.Duration
	AssetScanInterval time.Duration
	Logger            *slog.Logger
}

// Poller watches explicitly selected workspace previews and persists refreshes
// through the normal session service path. It never chooses a preview for a
// fresh worker: selection belongs to `ao preview`, a managed server start, or
// deliberate user navigation.
type Poller struct {
	source            sessionPreviewSource
	setter            previewSetter
	baseURL           string
	interval          time.Duration
	assetScanInterval time.Duration
	logger            *slog.Logger
	seen              map[domain.SessionID]entryState
	now               func() time.Time
	fingerprint       func(Entry) uint64
}

type entryState struct {
	path           string
	signature      uint64
	signatureValid bool
	lastAssetScan  time.Time
	entryModUnix   int64
	entrySize      int64
	// pending records a relevant file change observed while the worker was
	// active. The final target is persisted only after the worker reaches an
	// end-of-work activity state.
	pending                bool
	pendingPreviewURL      string
	pendingPreviewRevision int64
	// cleared is set when the poller itself cleared the preview URL because the
	// explicitly selected workspace entry was missing. The retained path lets
	// the poller restore that same entry if it reappears.
	cleared       bool
	clearRevision int64
}

// NewPoller constructs a preview poller over the supplied session source and setter.
func NewPoller(source sessionPreviewSource, setter previewSetter, baseURL string, cfg PollerConfig) *Poller {
	p := &Poller{
		source:            source,
		setter:            setter,
		baseURL:           baseURL,
		interval:          cfg.Interval,
		assetScanInterval: cfg.AssetScanInterval,
		logger:            cfg.Logger,
		seen:              map[domain.SessionID]entryState{},
		now:               time.Now,
		fingerprint:       staticTreeSignature,
	}
	if p.interval <= 0 {
		p.interval = DefaultPollInterval
	}
	if p.assetScanInterval <= 0 {
		p.assetScanInterval = DefaultAssetScanInterval
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
	now := p.now()
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
				previous.path == "" ||
				sess.Metadata.PreviewRevision != previous.clearRevision {
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
				if restoringCleared {
					continue
				}
				clearRevision, applied, err := p.setter.CompareAndSetPreview(
					ctx,
					sess.ID,
					sess.Metadata.PreviewURL,
					sess.Metadata.PreviewRevision,
					"",
				)
				if err != nil {
					p.logger.Error("preview poller: failed to clear stale preview",
						"session", sess.ID, "err", err)
					delete(p.seen, sess.ID)
					continue
				}
				if !applied {
					delete(p.seen, sess.ID)
					continue
				}
				p.seen[sess.ID] = entryState{
					path:          storedEntry,
					cleared:       true,
					clearRevision: clearRevision,
				}
			}
			continue
		}
		target, err := FileURL(p.baseURL, sess.ID, entry.Path)
		if err != nil {
			p.logger.Error("preview poller: cannot build isolated preview URL", "session", sess.ID, "err", err)
			state, _ := p.stateFor(entry, false, previous, seenBefore, now)
			p.seen[sess.ID] = state
			continue
		}
		current := strings.TrimSpace(sess.Metadata.PreviewURL)
		// Recursively fingerprint assets only while this exact workspace-owned
		// static preview is active. The fingerprint is rate-limited separately
		// from the cheap entry metadata check.
		state, changed := p.stateFor(entry, workspaceOwned && current == target, previous, seenBefore, now)
		if !changed && (!seenBefore || !previous.pending) {
			p.seen[sess.ID] = state
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
		var applied bool
		if current == target && !restoringCleared {
			applied, err = p.setter.RefreshPreview(
				ctx,
				sess.ID,
				sess.Metadata.PreviewURL,
				sess.Metadata.PreviewRevision,
			)
		} else {
			_, applied, err = p.setter.CompareAndSetPreview(
				ctx,
				sess.ID,
				sess.Metadata.PreviewURL,
				sess.Metadata.PreviewRevision,
				target,
			)
		}
		if err != nil {
			return fmt.Errorf("preview poller update preview %s: %w", sess.ID, err)
		}
		if !applied {
			// The snapshot lost a race with an explicit user selection. Drop
			// local ownership so the next poll baselines the newer target.
			delete(p.seen, sess.ID)
			continue
		}
		state.pending = false
		state.pendingPreviewURL = ""
		state.pendingPreviewRevision = 0
		if !state.signatureValid {
			state.signature = p.fingerprint(entry)
			state.signatureValid = true
			state.lastAssetScan = now
		}
		p.seen[sess.ID] = state
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

func (p *Poller) stateFor(
	entry Entry,
	includeAssets bool,
	previous entryState,
	seenBefore bool,
	now time.Time,
) (entryState, bool) {
	state := entryState{
		path:         entry.Path,
		entryModUnix: entry.ModTime.UnixNano(),
		entrySize:    entry.Size,
	}
	changed := !seenBefore ||
		previous.path != state.path ||
		previous.entryModUnix != state.entryModUnix ||
		previous.entrySize != state.entrySize
	if !includeAssets {
		return state, changed
	}
	state.signature = previous.signature
	state.signatureValid = previous.signatureValid
	state.lastAssetScan = previous.lastAssetScan
	if !state.signatureValid || now.Sub(state.lastAssetScan) >= p.assetScanInterval {
		signature := p.fingerprint(entry)
		if state.signatureValid && signature != state.signature {
			changed = true
		}
		state.signature = signature
		state.signatureValid = true
		state.lastAssetScan = now
	}
	return state, changed
}
