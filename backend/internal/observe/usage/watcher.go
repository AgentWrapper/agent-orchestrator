package usage

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/fsnotify/fsnotify"
)

const (
	transcriptEventBuffer = 256
	watcherErrorBuffer    = 16
)

// TranscriptEvent reports a transcript path whose contents or filesystem
// identity may have changed.
type TranscriptEvent struct {
	Path      string
	Discovery bool
}

// TranscriptWatcher recursively watches transcript roots while keeping all
// fsnotify mutations serialized with Rebuild.
type TranscriptWatcher struct {
	mu      sync.Mutex
	watcher *fsnotify.Watcher
	roots   []string
	watched map[string]struct{}
	closed  bool

	events chan TranscriptEvent
	errors chan error
	done   chan struct{}

	startOnce sync.Once
}

// NewTranscriptWatcher creates a watcher and registers every currently
// available directory. A missing root is represented by a watch on its nearest
// existing ancestor until directory creation events make the root available.
func NewTranscriptWatcher(roots []string) (*TranscriptWatcher, error) {
	normalized, err := normalizeTranscriptRoots(roots)
	if err != nil {
		return nil, err
	}
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("create transcript watcher: %w", err)
	}
	result := &TranscriptWatcher{
		watcher: watcher,
		roots:   normalized,
		watched: make(map[string]struct{}),
		events:  make(chan TranscriptEvent, transcriptEventBuffer),
		errors:  make(chan error, watcherErrorBuffer),
		done:    make(chan struct{}),
	}
	if err := result.Rebuild(); err != nil {
		_ = watcher.Close()
		return nil, err
	}
	return result, nil
}

// Events returns filesystem-triggered transcript changes.
func (w *TranscriptWatcher) Events() <-chan TranscriptEvent {
	return w.events
}

// Errors returns watcher errors, including fsnotify queue-overflow errors and
// failures encountered while rebuilding the recursive watch set.
func (w *TranscriptWatcher) Errors() <-chan error {
	return w.errors
}

// Start begins forwarding watcher events until ctx is cancelled. Start is
// idempotent; subsequent calls return the completion channel for the original
// run.
func (w *TranscriptWatcher) Start(ctx context.Context) <-chan struct{} {
	w.startOnce.Do(func() {
		go w.run(ctx)
	})
	return w.done
}

// Rebuild replaces the current watch set with watches derived from the desired
// roots. It is safe to call while event handling is active.
func (w *TranscriptWatcher) Rebuild() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return errors.New("transcript watcher is closed")
	}
	return w.rebuildLocked()
}

func (w *TranscriptWatcher) run(ctx context.Context) {
	defer close(w.done)
	defer close(w.events)
	defer close(w.errors)

	for {
		select {
		case <-ctx.Done():
			w.close()
			return
		case event, ok := <-w.watcher.Events:
			if !ok {
				w.close()
				return
			}
			emit, discovery, rebuildErr := w.handleEvent(event)
			if rebuildErr != nil && !w.sendError(ctx, rebuildErr) {
				w.close()
				return
			}
			if emit != "" && !w.sendEvent(ctx, TranscriptEvent{Path: emit, Discovery: discovery}) {
				w.close()
				return
			}
		case err, ok := <-w.watcher.Errors:
			if !ok {
				w.close()
				return
			}
			if err != nil && !w.sendError(ctx, err) {
				w.close()
				return
			}
		}
	}
}

func (w *TranscriptWatcher) close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	w.closed = true
	_ = w.watcher.Close()
	clear(w.watched)
}

func (w *TranscriptWatcher) handleEvent(event fsnotify.Event) (string, bool, error) {
	path := filepath.Clean(event.Name)
	emit := ""
	discovery := false
	if event.Op&(fsnotify.Create|fsnotify.Write|fsnotify.Rename|fsnotify.Remove) != 0 &&
		filepath.Ext(path) == ".jsonl" &&
		w.withinDesiredRoot(path) {
		emit = path
		discovery = event.Op&(fsnotify.Create|fsnotify.Rename) != 0
	}

	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed || !w.directoryEventRequiresRebuildLocked(path, event.Op) {
		return emit, discovery, nil
	}
	if err := w.rebuildLocked(); err != nil {
		return emit, discovery, fmt.Errorf("rebuild transcript watcher after %s: %w", event.Op, err)
	}
	return emit, discovery, nil
}

func (w *TranscriptWatcher) directoryEventRequiresRebuildLocked(path string, op fsnotify.Op) bool {
	if op&fsnotify.Create != 0 && w.directoryRelevant(path) {
		info, err := os.Stat(path)
		if err == nil && info.IsDir() {
			return true
		}
	}
	if op&(fsnotify.Rename|fsnotify.Remove) == 0 {
		return false
	}
	for watched := range w.watched {
		if pathWithin(watched, path) {
			return true
		}
	}
	return false
}

func (w *TranscriptWatcher) rebuildLocked() error {
	desired, err := w.desiredWatchSetLocked()
	if err != nil {
		return err
	}

	// Keep ancestor watches active while descendants are being created. After
	// each add pass, scan again to close the stat-to-watch race where another
	// directory appears before its parent watch is installed.
	const maxTopologyPasses = 16
	var addedPaths []string
	for pass := 0; pass < maxTopologyPasses; pass++ {
		paths := unwatchedPaths(desired, w.watched)
		for _, path := range paths {
			if err := w.watcher.Add(path); err != nil {
				return fmt.Errorf("watch transcript directory: %w", redactFilesystemError(err))
			}
			w.watched[path] = struct{}{}
			addedPaths = append(addedPaths, path)
		}

		refreshed, err := w.desiredWatchSetLocked()
		if err != nil {
			return err
		}
		if samePaths(desired, refreshed) {
			desired = refreshed
			break
		}
		desired = refreshed
		if pass == maxTopologyPasses-1 {
			return errors.New("transcript directory topology did not stabilize during rebuild")
		}
	}

	removedStale := false
	for path := range w.watched {
		if _, keep := desired[path]; keep {
			continue
		}
		if err := w.watcher.Remove(path); err != nil &&
			!errors.Is(err, fsnotify.ErrNonExistentWatch) {
			return fmt.Errorf("remove stale transcript watch: %w", redactFilesystemError(err))
		}
		delete(w.watched, path)
		removedStale = true
	}

	// On Linux, a directory rename can leave the old and new paths referring
	// to the same inotify watch. Removing the stale path can then remove the
	// watch just added for the new path. Re-add new paths after stale removals
	// so the kernel watch set and w.watched cannot diverge.
	if removedStale {
		sort.Strings(addedPaths)
		for _, path := range addedPaths {
			if _, keep := desired[path]; !keep {
				continue
			}
			if err := w.watcher.Add(path); err != nil {
				return fmt.Errorf("refresh transcript watch: %w", redactFilesystemError(err))
			}
		}
	}
	return nil
}

func (w *TranscriptWatcher) desiredWatchSetLocked() (map[string]struct{}, error) {
	result := make(map[string]struct{})
	for _, root := range w.roots {
		walkRoot, err := resolveTranscriptRoot(root)
		if err != nil {
			return nil, fmt.Errorf("resolve transcript root: %w", redactFilesystemError(err))
		}
		info, err := os.Stat(walkRoot)
		switch {
		case err == nil && !info.IsDir():
			return nil, errors.New("transcript root is not a directory")
		case err == nil:
			if err := filepath.WalkDir(walkRoot, func(path string, entry fs.DirEntry, walkErr error) error {
				if walkErr != nil {
					return walkErr
				}
				if entry.IsDir() {
					result[filepath.Clean(path)] = struct{}{}
				}
				return nil
			}); err != nil {
				return nil, fmt.Errorf("walk transcript root: %w", redactFilesystemError(err))
			}
		case errors.Is(err, os.ErrNotExist):
			ancestor, ancestorErr := nearestExistingDirectory(root)
			if ancestorErr != nil {
				return nil, fmt.Errorf("locate transcript root ancestor: %w", redactFilesystemError(ancestorErr))
			}
			result[ancestor] = struct{}{}
		default:
			return nil, fmt.Errorf("inspect transcript root: %w", redactFilesystemError(err))
		}
	}
	return result, nil
}

func (w *TranscriptWatcher) withinDesiredRoot(path string) bool {
	for _, root := range w.roots {
		if pathWithin(path, root) {
			return true
		}
		resolved, err := resolveTranscriptRoot(root)
		if err == nil && pathWithin(path, resolved) {
			return true
		}
	}
	return false
}

func (w *TranscriptWatcher) directoryRelevant(path string) bool {
	for _, root := range w.roots {
		if pathWithin(path, root) || pathWithin(root, path) {
			return true
		}
		resolved, err := resolveTranscriptRoot(root)
		if err == nil && (pathWithin(path, resolved) || pathWithin(resolved, path)) {
			return true
		}
	}
	return false
}

func (w *TranscriptWatcher) sendEvent(ctx context.Context, event TranscriptEvent) bool {
	select {
	case w.events <- event:
		return true
	case <-ctx.Done():
		return false
	}
}

func (w *TranscriptWatcher) sendError(ctx context.Context, err error) bool {
	select {
	case w.errors <- err:
		return true
	case <-ctx.Done():
		return false
	}
}

func normalizeTranscriptRoots(roots []string) ([]string, error) {
	seen := make(map[string]struct{}, len(roots))
	result := make([]string, 0, len(roots))
	for _, root := range roots {
		if strings.TrimSpace(root) == "" {
			return nil, errors.New("transcript root cannot be empty")
		}
		absolute, err := filepath.Abs(root)
		if err != nil {
			return nil, fmt.Errorf("normalize transcript root: %w", redactFilesystemError(err))
		}
		absolute = filepath.Clean(absolute)
		if _, ok := seen[absolute]; ok {
			continue
		}
		seen[absolute] = struct{}{}
		result = append(result, absolute)
	}
	sort.Strings(result)
	return result, nil
}

func resolveTranscriptRoot(path string) (string, error) {
	info, err := os.Lstat(path)
	switch {
	case err == nil && info.Mode()&os.ModeSymlink != 0:
		resolved, err := filepath.EvalSymlinks(path)
		if errors.Is(err, os.ErrNotExist) {
			return filepath.Clean(path), nil
		}
		if err != nil {
			return "", err
		}
		return filepath.Clean(resolved), nil
	case err == nil:
		return filepath.Clean(path), nil
	case errors.Is(err, os.ErrNotExist):
		return filepath.Clean(path), nil
	default:
		return "", err
	}
}

func nearestExistingDirectory(path string) (string, error) {
	current := filepath.Clean(path)
	for {
		info, err := os.Stat(current)
		if err == nil {
			if !info.IsDir() {
				return "", errors.New("transcript root ancestor is not a directory")
			}
			return current, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", redactFilesystemError(err)
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", errors.New("no existing transcript root ancestor")
		}
		current = parent
	}
}

func redactFilesystemError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, os.ErrNotExist):
		return os.ErrNotExist
	case errors.Is(err, os.ErrPermission):
		return os.ErrPermission
	default:
		return errors.New("filesystem operation failed")
	}
}

func pathWithin(path, root string) bool {
	relative, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	return relative == "." ||
		(relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
}

func pathDepth(path string) int {
	cleaned := filepath.Clean(path)
	if volume := filepath.VolumeName(cleaned); volume != "" {
		cleaned = strings.TrimPrefix(cleaned, volume)
	}
	return strings.Count(cleaned, string(filepath.Separator))
}

func unwatchedPaths(desired, watched map[string]struct{}) []string {
	paths := make([]string, 0, len(desired))
	for path := range desired {
		if _, ok := watched[path]; !ok {
			paths = append(paths, path)
		}
	}
	sort.Slice(paths, func(i, j int) bool {
		leftDepth := pathDepth(paths[i])
		rightDepth := pathDepth(paths[j])
		if leftDepth == rightDepth {
			return paths[i] < paths[j]
		}
		return leftDepth < rightDepth
	})
	return paths
}

func samePaths(left, right map[string]struct{}) bool {
	if len(left) != len(right) {
		return false
	}
	for path := range left {
		if _, ok := right[path]; !ok {
			return false
		}
	}
	return true
}
