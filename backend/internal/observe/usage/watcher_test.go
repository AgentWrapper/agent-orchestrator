package usage

import (
	"context"
	"errors"
	"fmt"
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
	mustNoError(t, os.WriteFile(transcript, []byte("{\"type\":\"message\"}\n"), 0o600))
	waitForTranscriptEvent(t, watcher.Events(), transcript)

	ignored := filepath.Join(root, "notes.txt")
	mustNoError(t, os.WriteFile(ignored, []byte("not a transcript"), 0o600))
	assertNoTranscriptEvent(t, watcher.Events(), ignored)
}

func TestTranscriptWatcherErrorsRedactRootPath(t *testing.T) {
	root := filepath.Join(t.TempDir(), "private-transcript-root")
	mustNoError(t, os.WriteFile(root, []byte("not a directory"), 0o600))
	_, err := NewTranscriptWatcher(context.Background(), []string{root})
	if err == nil {
		t.Fatal("expected file transcript root to be rejected")
	}
	if strings.Contains(err.Error(), root) {
		t.Fatalf("watcher error exposed transcript root: %v", err)
	}
}

func TestTranscriptWatcherCancelsLargeHistoryRebuildPromptly(t *testing.T) {
	root := t.TempDir()
	watcher, err := NewTranscriptWatcher(context.Background(), []string{root})
	mustNoError(t, err)
	t.Cleanup(watcher.close)
	for index := range 2_000 {
		mustNoError(t, os.Mkdir(filepath.Join(root, fmt.Sprintf("history-%04d", index)), 0o700))
	}

	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		close(started)
		done <- watcher.Rebuild(ctx)
	}()
	<-started
	time.Sleep(time.Millisecond)
	cancelledAt := time.Now()
	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Rebuild() error = %v, want context canceled", err)
		}
		if elapsed := time.Since(cancelledAt); elapsed > time.Second {
			t.Fatalf("Rebuild() stopped after %v, want prompt cancellation", elapsed)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Rebuild() did not stop after cancellation")
	}
}

func TestTranscriptWatcherResolvesSymlinkedRoot(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "transcripts")
	mustNoError(t, os.Mkdir(root, 0o700))
	link := filepath.Join(base, "linked-transcripts")
	if err := os.Symlink(root, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	resolvedRoot, err := filepath.EvalSymlinks(link)
	mustNoError(t, err)

	watcher, cancel := startTranscriptWatcher(t, link)
	defer stopTranscriptWatcher(t, watcher, cancel)
	waitForWatchedDirectory(t, watcher, resolvedRoot)

	transcript := filepath.Join(resolvedRoot, "session.jsonl")
	mustNoError(t, os.WriteFile(transcript, []byte("{}\n"), 0o600))
	waitForTranscriptEvent(t, watcher.Events(), transcript)
}

func TestTranscriptWatcherAddsNestedDirectories(t *testing.T) {
	root := t.TempDir()
	watcher, cancel := startTranscriptWatcher(t, root)
	defer stopTranscriptWatcher(t, watcher, cancel)

	nested := filepath.Join(root, "one", "two")
	mustNoError(t, os.MkdirAll(nested, 0o700))
	waitForWatchedDirectory(t, watcher, nested)

	transcript := filepath.Join(nested, "nested.jsonl")
	mustNoError(t, os.WriteFile(transcript, []byte("{}\n"), 0o600))
	waitForTranscriptEvent(t, watcher.Events(), transcript)
}

func TestTranscriptWatcherEmitsDiscoveryAfterPrepopulatedDirectoryRebuild(t *testing.T) {
	root := t.TempDir()
	watcher, err := NewTranscriptWatcher(context.Background(), []string{root})
	mustNoError(t, err)
	t.Cleanup(watcher.close)

	nested := filepath.Join(root, "created-before-event")
	mustNoError(t, os.Mkdir(nested, 0o700))
	transcript := filepath.Join(nested, "complete.jsonl")
	mustNoError(t, os.WriteFile(transcript, []byte("{}\n"), 0o600))

	emit, discovery, topology, err := watcher.handleEvent(
		context.Background(),
		fsnotify.Event{Name: nested, Op: fsnotify.Create},
	)
	if err != nil || filepath.Clean(emit) != filepath.Clean(nested) || !discovery || !topology {
		t.Fatalf("directory event = path:%q discovery:%v topology:%v err:%v", emit, discovery, topology, err)
	}
	watcher.mu.Lock()
	_, watched := watcher.watched[filepath.Clean(nested)]
	watcher.mu.Unlock()
	if !watched {
		t.Fatalf("prepopulated directory %q was not added to the watch set", nested)
	}
}

func TestTranscriptWatcherTransitionsFromMissingRoot(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "provider", "sessions")
	watcher, cancel := startTranscriptWatcher(t, root)
	defer stopTranscriptWatcher(t, watcher, cancel)

	mustNoError(t, os.MkdirAll(root, 0o700))
	waitForWatchedDirectory(t, watcher, root)

	transcript := filepath.Join(root, "started-later.jsonl")
	mustNoError(t, os.WriteFile(transcript, []byte("{}\n"), 0o600))
	waitForTranscriptEvent(t, watcher.Events(), transcript)
}

func TestTranscriptWatcherRenameAndReplacement(t *testing.T) {
	root := t.TempDir()
	watcher, cancel := startTranscriptWatcher(t, root)
	defer stopTranscriptWatcher(t, watcher, cancel)

	oldDirectory := filepath.Join(root, "old-generation")
	mustNoError(t, os.Mkdir(oldDirectory, 0o700))
	waitForWatchedDirectory(t, watcher, oldDirectory)

	newDirectory := filepath.Join(root, "new-generation")
	mustNoError(t, os.Rename(oldDirectory, newDirectory))
	waitForWatchedDirectory(t, watcher, newDirectory)
	waitForUnwatchedDirectory(t, watcher, oldDirectory)

	transcript := filepath.Join(newDirectory, "rollout.jsonl")
	mustNoError(t, os.WriteFile(transcript, []byte("{\"generation\":1}\n"), 0o600))
	waitForTranscriptEvent(t, watcher.Events(), transcript)

	renamed := filepath.Join(root, "rollout.old")
	mustNoError(t, os.Rename(transcript, renamed))
	waitForTranscriptEvent(t, watcher.Events(), transcript)

	replacement := filepath.Join(root, "replacement.tmp")
	mustNoError(t, os.WriteFile(replacement, []byte("{\"generation\":2}\n"), 0o600))
	mustNoError(t, os.Rename(replacement, transcript))
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

	if err := watcher.Rebuild(context.Background()); err == nil {
		t.Fatal("Rebuild() after shutdown succeeded, want closed error")
	}
}

func TestTranscriptWatcherMarksOnlyCreationEventsForDiscovery(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "session.jsonl")
	mustNoError(t, os.WriteFile(path, []byte("{}\n"), 0o600))
	watcher, err := NewTranscriptWatcher(context.Background(), []string{root})
	mustNoError(t, err)
	t.Cleanup(watcher.close)

	emit, discovery, topology, err := watcher.handleEvent(context.Background(), fsnotify.Event{Name: path, Op: fsnotify.Create})
	if err != nil || filepath.Clean(emit) != filepath.Clean(path) || !discovery || topology {
		t.Fatalf("create event = path:%q discovery:%v topology:%v err:%v", emit, discovery, topology, err)
	}
	emit, discovery, topology, err = watcher.handleEvent(context.Background(), fsnotify.Event{Name: path, Op: fsnotify.Write})
	if err != nil || filepath.Clean(emit) != filepath.Clean(path) || discovery || topology {
		t.Fatalf("write event = path:%q discovery:%v topology:%v err:%v", emit, discovery, topology, err)
	}
}

func startTranscriptWatcher(t *testing.T, roots ...string) (*TranscriptWatcher, context.CancelFunc) {
	t.Helper()
	watcher, err := NewTranscriptWatcher(context.Background(), roots)
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
