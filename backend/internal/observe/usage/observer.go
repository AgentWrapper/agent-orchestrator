package usage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	usagesvc "github.com/aoagents/agent-orchestrator/backend/internal/service/usage"
)

const (
	// DefaultPollInterval is the normal transcript collection cadence.
	DefaultPollInterval = 30 * time.Second
	defaultSourceLimit  = 64
	defaultChunkBytes   = 8 << 20
	defaultRecordBytes  = 1 << 20
)

type observerStore interface {
	ListObserverReadyUsageSources(context.Context, time.Time, int64) ([]domain.UsageSourceRecord, error)
	GetUsageSourceForIngestion(context.Context, int64) (domain.UsageSourceContext, bool, error)
	ApplyUsageChunk(context.Context, int64, int64, domain.SourceCursorState, []domain.ModelUsageEvent) (domain.ApplyUsageChunkResult, error)
	MarkUsageSourceState(context.Context, int64, domain.UsageSourceState, string, *time.Time, time.Time) (bool, error)
	MarkUsageSourceFailure(context.Context, int64, int64, string, time.Time, time.Time) (bool, error)
	InsertUsageSource(context.Context, domain.UsageSourceRecord) (domain.UsageSourceRecord, error)
	ListUsageSourcesForBinding(context.Context, int64) ([]domain.UsageSourceRecord, error)
	UpdateUsageBindingState(context.Context, int64, domain.UsageBindingState, string, time.Time) (bool, error)
}

// Config controls the bounded usage transcript observer.
type Config struct {
	Tick        time.Duration
	SourceLimit int64
	ChunkBytes  int64
	RecordBytes int
	Reconcile   func(context.Context, int64) error
	Clock       func() time.Time
	Logger      *slog.Logger
}

// Observer incrementally tails registered transcript files.
type Observer struct {
	store       observerStore
	tick        time.Duration
	sourceLimit int64
	chunkBytes  int64
	recordBytes int
	reconcile   func(context.Context, int64) error
	now         func() time.Time
	logger      *slog.Logger
	wake        chan struct{}
}

// New constructs a usage observer with production-safe bounds.
func New(store observerStore, cfg Config) *Observer {
	if cfg.Tick <= 0 {
		cfg.Tick = DefaultPollInterval
	}
	if cfg.SourceLimit <= 0 {
		cfg.SourceLimit = defaultSourceLimit
	}
	if cfg.ChunkBytes <= 0 {
		cfg.ChunkBytes = defaultChunkBytes
	}
	if cfg.RecordBytes <= 0 {
		cfg.RecordBytes = defaultRecordBytes
	}
	if cfg.Clock == nil {
		cfg.Clock = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &Observer{
		store:       store,
		tick:        cfg.Tick,
		sourceLimit: cfg.SourceLimit,
		chunkBytes:  cfg.ChunkBytes,
		recordBytes: cfg.RecordBytes,
		reconcile:   cfg.Reconcile,
		now:         cfg.Clock,
		logger:      cfg.Logger,
		wake:        make(chan struct{}, 1),
	}
}

// Wake requests an immediate collection pass without blocking a hook.
func (o *Observer) Wake() {
	select {
	case o.wake <- struct{}{}:
	default:
	}
}

// Start performs an immediate pass, then polls on the configured cadence or a
// hook-triggered wake.
func (o *Observer) Start(ctx context.Context) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(o.tick)
		defer ticker.Stop()
		o.pollAndLog(ctx)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				o.pollAndLog(ctx)
			case <-o.wake:
				o.pollAndLog(ctx)
			}
		}
	}()
	return done
}

func (o *Observer) pollAndLog(ctx context.Context) {
	if err := o.Poll(ctx); err != nil && ctx.Err() == nil {
		o.logger.Warn("usage observer poll failed", "err", err)
	}
}

// Poll processes one bounded batch of registered sources.
func (o *Observer) Poll(ctx context.Context) error {
	now := o.now().UTC()
	var errs []error
	if o.reconcile != nil {
		if err := o.reconcile(ctx, o.sourceLimit); err != nil {
			errs = append(errs, fmt.Errorf("reconcile usage sources: %w", err))
		}
	}
	sources, err := o.store.ListObserverReadyUsageSources(ctx, now, o.sourceLimit)
	if err != nil {
		errs = append(errs, err)
		return errors.Join(errs...)
	}
	for _, source := range sources {
		if err := o.processSource(ctx, source.ID, now); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (o *Observer) processSource(ctx context.Context, sourceID int64, now time.Time) error {
	source, ok, err := o.store.GetUsageSourceForIngestion(ctx, sourceID)
	if err != nil || !ok {
		return err
	}
	info, err := os.Stat(source.Source.ArtifactPath)
	if err != nil || !info.Mode().IsRegular() {
		return o.retrySource(ctx, source.Source, domain.UsageErrorArtifactMissing, now, err)
	}
	identity, err := usagesvc.SourceIdentity(source.Source.ArtifactPath)
	if err != nil {
		return o.retrySource(ctx, source.Source, domain.UsageErrorSourceReadFailed, now, err)
	}
	if source.Source.FileIdentity != identity || info.Size() < source.Source.ByteOffset {
		return o.replaceSource(ctx, source, identity, now)
	}

	chunk, err := readJSONLChunk(source.Source.ArtifactPath, source.Source.ByteOffset, o.chunkBytes, o.recordBytes, source.Source.LastErrorCode)
	if err != nil {
		return o.retrySource(ctx, source.Source, domain.UsageErrorSourceReadFailed, now, err)
	}
	parsed := parseRecords(source, chunk.records, chunk.nextOffset, now)
	if chunk.anomalies > 0 {
		parsed.Cursor.AnomalyCount += int64(chunk.anomalies)
		parsed.Cursor.LastErrorCode = chunk.errorCode
	}
	if source.BindingState == domain.UsageBindingFinalizing && chunk.atEOF {
		parsed.Cursor.State = domain.UsageSourceComplete
	}
	if _, err := o.store.ApplyUsageChunk(ctx, source.Source.ID, source.Source.ByteOffset, parsed.Cursor, parsed.Events); err != nil {
		if errors.Is(err, domain.ErrUsageSourceEventConflict) {
			if _, markErr := o.store.MarkUsageSourceState(
				ctx,
				source.Source.ID,
				domain.UsageSourceComplete,
				domain.UsageErrorSourceEventConflict,
				nil,
				now,
			); markErr != nil {
				return errors.Join(err, markErr)
			}
			if source.BindingState == domain.UsageBindingFinalizing {
				return o.completeBinding(ctx, source.Source.BindingID, now)
			}
			return nil
		}
		return fmt.Errorf("apply usage source %d: %w", source.Source.ID, err)
	}
	if parsed.Cursor.State == domain.UsageSourceComplete {
		return o.completeBinding(ctx, source.Source.BindingID, now)
	}
	return nil
}

func (o *Observer) replaceSource(ctx context.Context, source domain.UsageSourceContext, identity string, now time.Time) error {
	if _, err := o.store.MarkUsageSourceState(ctx, source.Source.ID, domain.UsageSourceComplete, domain.UsageErrorArtifactReplaced, nil, now); err != nil {
		return err
	}
	_, err := o.store.InsertUsageSource(ctx, domain.UsageSourceRecord{
		BindingID:       source.Source.BindingID,
		Kind:            source.Source.Kind,
		NativeSessionID: source.Source.NativeSessionID,
		SubagentID:      source.Source.SubagentID,
		ArtifactPath:    source.Source.ArtifactPath,
		FileIdentity:    identity,
		Generation:      source.Source.Generation + 1,
		CurrentModelID:  source.Source.CurrentModelID,
		CurrentProvider: source.Source.CurrentProvider,
		ParserVersion:   source.Source.ParserVersion,
		State:           domain.UsageSourcePending,
		CreatedAt:       now,
		UpdatedAt:       now,
	})
	return err
}

func (o *Observer) retrySource(ctx context.Context, source domain.UsageSourceRecord, code string, now time.Time, cause error) error {
	failures := source.FailureCount + 1
	delay := retryDelay(failures)
	next := now.Add(delay)
	if _, err := o.store.MarkUsageSourceFailure(ctx, source.ID, failures, code, next, now); err != nil {
		return err
	}
	if cause == nil {
		cause = errors.New(code)
	}
	return fmt.Errorf("usage source %d: %w", source.ID, cause)
}

func (o *Observer) completeBinding(ctx context.Context, bindingID int64, now time.Time) error {
	sources, err := o.store.ListUsageSourcesForBinding(ctx, bindingID)
	if err != nil {
		return err
	}
	state := domain.UsageBindingComplete
	for _, source := range sources {
		if source.State != domain.UsageSourceComplete {
			return nil
		}
		if source.AnomalyCount > 0 || source.LastErrorCode != "" {
			state = domain.UsageBindingPartial
		}
	}
	_, err = o.store.UpdateUsageBindingState(ctx, bindingID, state, "", now)
	return err
}

func retryDelay(failure int64) time.Duration {
	switch failure {
	case 1:
		return 30 * time.Second
	case 2:
		return time.Minute
	case 3:
		return 2 * time.Minute
	default:
		return 5 * time.Minute
	}
}

type jsonlChunk struct {
	records    []jsonlRecord
	nextOffset int64
	atEOF      bool
	anomalies  int
	errorCode  string
}

func readJSONLChunk(path string, offset, maxBytes int64, maxRecord int, previousError string) (jsonlChunk, error) {
	file, err := os.Open(path) //nolint:gosec // path was validated at registration.
	if err != nil {
		return jsonlChunk{}, err
	}
	defer func() { _ = file.Close() }()
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return jsonlChunk{}, err
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBytes))
	if err != nil {
		return jsonlChunk{}, err
	}
	info, err := file.Stat()
	if err != nil {
		return jsonlChunk{}, err
	}
	chunk := jsonlChunk{nextOffset: offset}
	if len(data) == 0 {
		chunk.atEOF = offset >= info.Size()
		return chunk, nil
	}

	start := 0
	if previousError == domain.UsageErrorRecordTooLarge {
		newline := bytes.IndexByte(data, '\n')
		if newline < 0 {
			chunk.nextOffset += int64(len(data))
			chunk.anomalies = 1
			chunk.errorCode = domain.UsageErrorRecordTooLarge
			return chunk, nil
		}
		start = newline + 1
		chunk.nextOffset += int64(start)
	}
	lastNewline := bytes.LastIndexByte(data[start:], '\n')
	if lastNewline < 0 {
		if len(data)-start > maxRecord {
			chunk.nextOffset += int64(len(data) - start)
			chunk.anomalies++
			chunk.errorCode = domain.UsageErrorRecordTooLarge
		}
		return chunk, nil
	}
	completeEnd := start + lastNewline + 1
	cursor := start
	for cursor < completeEnd {
		relative := bytes.IndexByte(data[cursor:completeEnd], '\n')
		if relative < 0 {
			break
		}
		end := cursor + relative
		line := bytes.TrimSuffix(data[cursor:end], []byte{'\r'})
		lineOffset := offset + int64(cursor)
		if len(line) > maxRecord {
			chunk.anomalies++
			chunk.errorCode = domain.UsageErrorRecordTooLarge
		} else if len(bytes.TrimSpace(line)) > 0 {
			chunk.records = append(chunk.records, jsonlRecord{Data: append([]byte(nil), line...), Offset: lineOffset})
		}
		cursor = end + 1
	}
	chunk.nextOffset = offset + int64(completeEnd)
	chunk.atEOF = chunk.nextOffset >= info.Size()
	return chunk, nil
}
