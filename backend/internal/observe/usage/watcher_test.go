package usage

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

const watcherTestTimeout = 5 * time.Second

func TestTranscriptWatcherExistingRootWrite(t *testing.T) {
	root := t.TempDir()
	watcher, cancel := startTranscriptWatcher(t, root)
	defer stopTranscriptWatcher(t, watcher, cancel)

	transcript := filepath.Join(root, "session.jsonl")
	if err := os.WriteFile(transcript, []byte("{\"type\":\"message\"}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitForTranscriptEvent(t, watcher.Events(), transcript)

	ignored := filepath.Join(root, "notes.txt")
	if err := os.WriteFile(ignored, []byte("not a transcript"), 0o600); err != nil {
		t.Fatal(err)
	}
	assertNoTranscriptEvent(t, watcher.Events(), ignored)
}

func TestTranscriptWatcherErrorsRedactRootPath(t *testing.T) {
	root := filepath.Join(t.TempDir(), "private-transcript-root")
	if err := os.WriteFile(root, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := NewTranscriptWatcher([]string{root})
	if err == nil {
		t.Fatal("expected file transcript root to be rejected")
	}
	if strings.Contains(err.Error(), root) {
		t.Fatalf("watcher error exposed transcript root: %v", err)
	}
}

func TestTranscriptWatcherResolvesSymlinkedRoot(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "transcripts")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "linked-transcripts")
	if err := os.Symlink(root, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	resolvedRoot, err := filepath.EvalSymlinks(link)
	if err != nil {
		t.Fatal(err)
	}

	watcher, cancel := startTranscriptWatcher(t, link)
	defer stopTranscriptWatcher(t, watcher, cancel)
	waitForWatchedDirectory(t, watcher, resolvedRoot)

	transcript := filepath.Join(resolvedRoot, "session.jsonl")
	if err := os.WriteFile(transcript, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitForTranscriptEvent(t, watcher.Events(), transcript)
}

func TestTranscriptWatcherAddsNestedDirectories(t *testing.T) {
	root := t.TempDir()
	watcher, cancel := startTranscriptWatcher(t, root)
	defer stopTranscriptWatcher(t, watcher, cancel)

	nested := filepath.Join(root, "one", "two")
	if err := os.MkdirAll(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	waitForWatchedDirectory(t, watcher, nested)

	transcript := filepath.Join(nested, "nested.jsonl")
	if err := os.WriteFile(transcript, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitForTranscriptEvent(t, watcher.Events(), transcript)
}

func TestTranscriptWatcherTransitionsFromMissingRoot(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "provider", "sessions")
	watcher, cancel := startTranscriptWatcher(t, root)
	defer stopTranscriptWatcher(t, watcher, cancel)

	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	waitForWatchedDirectory(t, watcher, root)

	transcript := filepath.Join(root, "started-later.jsonl")
	if err := os.WriteFile(transcript, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitForTranscriptEvent(t, watcher.Events(), transcript)
}

func TestTranscriptWatcherRenameAndReplacement(t *testing.T) {
	root := t.TempDir()
	watcher, cancel := startTranscriptWatcher(t, root)
	defer stopTranscriptWatcher(t, watcher, cancel)

	oldDirectory := filepath.Join(root, "old-generation")
	if err := os.Mkdir(oldDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	waitForWatchedDirectory(t, watcher, oldDirectory)

	newDirectory := filepath.Join(root, "new-generation")
	if err := os.Rename(oldDirectory, newDirectory); err != nil {
		t.Fatal(err)
	}
	waitForWatchedDirectory(t, watcher, newDirectory)
	waitForUnwatchedDirectory(t, watcher, oldDirectory)

	transcript := filepath.Join(newDirectory, "rollout.jsonl")
	if err := os.WriteFile(transcript, []byte("{\"generation\":1}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitForTranscriptEvent(t, watcher.Events(), transcript)

	renamed := filepath.Join(root, "rollout.old")
	if err := os.Rename(transcript, renamed); err != nil {
		t.Fatal(err)
	}
	waitForTranscriptEvent(t, watcher.Events(), transcript)

	replacement := filepath.Join(root, "replacement.tmp")
	if err := os.WriteFile(replacement, []byte("{\"generation\":2}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, transcript); err != nil {
		t.Fatal(err)
	}
	waitForTranscriptEvent(t, watcher.Events(), transcript)
}

func TestTranscriptWatcherCleanShutdown(t *testing.T) {
	root := t.TempDir()
	watcher, cancel := startTranscriptWatcher(t, root)
	cancel()

	select {
	case <-watcher.Start(context.Background()):
	case <-time.After(watcherTestTimeout):
		t.Fatal("watcher did not stop after context cancellation")
	}
	waitForClosedTranscriptEvents(t, watcher.Events())
	waitForClosedWatcherErrors(t, watcher.Errors())

	if err := watcher.Rebuild(); err == nil {
		t.Fatal("Rebuild() after shutdown succeeded, want closed error")
	}
}

func TestTranscriptWatcherMarksOnlyCreationEventsForDiscovery(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "session.jsonl")
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	watcher, err := NewTranscriptWatcher([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(watcher.close)

	emit, discovery, err := watcher.handleEvent(fsnotify.Event{Name: path, Op: fsnotify.Create})
	if err != nil || filepath.Clean(emit) != filepath.Clean(path) || !discovery {
		t.Fatalf("create event = path:%q discovery:%v err:%v", emit, discovery, err)
	}
	emit, discovery, err = watcher.handleEvent(fsnotify.Event{Name: path, Op: fsnotify.Write})
	if err != nil || filepath.Clean(emit) != filepath.Clean(path) || discovery {
		t.Fatalf("write event = path:%q discovery:%v err:%v", emit, discovery, err)
	}
}

func startTranscriptWatcher(t *testing.T, roots ...string) (*TranscriptWatcher, context.CancelFunc) {
	t.Helper()
	watcher, err := NewTranscriptWatcher(roots)
	if err != nil {
		t.Fatalf("NewTranscriptWatcher() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	watcher.Start(ctx)
	return watcher, cancel
}

func stopTranscriptWatcher(t *testing.T, watcher *TranscriptWatcher, cancel context.CancelFunc) {
	t.Helper()
	cancel()
	select {
	case <-watcher.Start(context.Background()):
	case <-time.After(watcherTestTimeout):
		t.Fatal("watcher did not stop")
	}
}

func waitForTranscriptEvent(t *testing.T, events <-chan TranscriptEvent, path string) {
	t.Helper()
	path = filepath.Clean(path)
	timer := time.NewTimer(watcherTestTimeout)
	defer timer.Stop()
	for {
		select {
		case event, ok := <-events:
			if !ok {
				t.Fatalf("events closed while waiting for %q", path)
			}
			if filepath.Clean(event.Path) == path {
				return
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for transcript event %q", path)
		}
	}
}

func assertNoTranscriptEvent(t *testing.T, events <-chan TranscriptEvent, path string) {
	t.Helper()
	path = filepath.Clean(path)
	timer := time.NewTimer(200 * time.Millisecond)
	defer timer.Stop()
	for {
		select {
		case event, ok := <-events:
			if !ok {
				return
			}
			if filepath.Clean(event.Path) == path {
				t.Fatalf("received event for non-transcript path %q", path)
			}
		case <-timer.C:
			return
		}
	}
}

func waitForWatchedDirectory(t *testing.T, watcher *TranscriptWatcher, path string) {
	t.Helper()
	path = filepath.Clean(path)
	deadline := time.Now().Add(watcherTestTimeout)
	for time.Now().Before(deadline) {
		watcher.mu.Lock()
		_, ok := watcher.watched[path]
		watcher.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("directory %q was not added to the watch set", path)
}

func waitForUnwatchedDirectory(t *testing.T, watcher *TranscriptWatcher, path string) {
	t.Helper()
	path = filepath.Clean(path)
	deadline := time.Now().Add(watcherTestTimeout)
	for time.Now().Before(deadline) {
		watcher.mu.Lock()
		_, ok := watcher.watched[path]
		watcher.mu.Unlock()
		if !ok {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("stale directory %q remained in the watch set", path)
}

func waitForClosedTranscriptEvents(t *testing.T, events <-chan TranscriptEvent) {
	t.Helper()
	timer := time.NewTimer(watcherTestTimeout)
	defer timer.Stop()
	for {
		select {
		case _, ok := <-events:
			if !ok {
				return
			}
		case <-timer.C:
			t.Fatal("events channel did not close")
		}
	}
}

func waitForClosedWatcherErrors(t *testing.T, errors <-chan error) {
	t.Helper()
	timer := time.NewTimer(watcherTestTimeout)
	defer timer.Stop()
	for {
		select {
		case _, ok := <-errors:
			if !ok {
				return
			}
		case <-timer.C:
			t.Fatal("errors channel did not close")
		}
	}
}
