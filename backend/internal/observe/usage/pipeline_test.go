package usage

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestPipelineRetriesWatcherCreation(t *testing.T) {
	pipeline := NewPipeline(
		&coordinatorTestStore{},
		coordinatorTestIngestor(func(context.Context, int64) (IngestResult, error) {
			return IngestResult{}, nil
		}),
		[]string{t.TempDir()},
		CoordinatorConfig{Workers: 1},
	)
	pipeline.restartWait = time.Millisecond
	created := make(chan struct{})
	var calls atomic.Int64
	pipeline.newWatcher = func(context.Context, []string) (transcriptWatcher, error) {
		if calls.Add(1) == 1 {
			return nil, errors.New("temporary watcher failure")
		}
		select {
		case <-created:
		default:
			close(created)
		}
		return newCoordinatorTestWatcher(), nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := pipeline.Start(ctx)
	waitForCoordinatorSignal(t, created, "pipeline did not retry watcher creation")
	cancel()
	waitForCoordinatorSignal(t, done, "pipeline did not stop")
	if got := calls.Load(); got < 2 {
		t.Fatalf("watcher creation calls = %d, want at least 2", got)
	}
}
