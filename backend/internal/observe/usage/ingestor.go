package usage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	usagesvc "github.com/aoagents/agent-orchestrator/backend/internal/service/usage"
)

const (
	defaultChunkBytes       = 8 << 20
	defaultRecordBytes      = 1 << 20
	defaultFinalizationWait = 2 * time.Second
)

type ingestorStore interface {
	GetUsageSourceForIngestion(context.Context, int64) (domain.UsageSourceContext, bool, error)
	ApplyUsageChunk(context.Context, int64, int64, domain.SourceCursorState, []domain.ModelUsageEvent) (domain.ApplyUsageChunkResult, error)
	MarkUsageSourceState(context.Context, int64, domain.UsageSourceState, string, *time.Time, time.Time) (bool, error)
	MarkUsageSourceFailure(context.Context, int64, int64, string, time.Time, time.Time) (bool, error)
	ReplaceUsageSource(context.Context, int64, string, domain.UsageSourceRecord, time.Time) (domain.UsageSourceRecord, error)
	CompleteUsageBindingIfSettled(context.Context, int64, time.Time) (bool, error)
	UpdateUsageBindingState(context.Context, int64, domain.UsageBindingState, string, time.Time) (bool, error)
}

// IngestorConfig controls bounded processing of one transcript source.
type IngestorConfig struct {
	ChunkBytes       int64
	RecordBytes      int
	FinalizationWait time.Duration
	Clock            func() time.Time
}

// IngestResult tells the coordinator whether another immediate chunk, source
// inventory refresh, or delayed retry is required.
type IngestResult struct {
	More                bool
	Refresh             bool
	Reconcile           bool
	RetryAt             *time.Time
	BindingID           int64
	ReplacementSourceID int64
}

// Ingestor incrementally processes registered transcript files when the
// watcher, a hook, startup reconciliation, or a retry timer requests work.
type Ingestor struct {
	store            ingestorStore
	chunkBytes       int64
	recordBytes      int
	finalizationWait time.Duration
	now              func() time.Time
}

// NewIngestor constructs a bounded transcript ingestor.
func NewIngestor(store ingestorStore, cfg IngestorConfig) *Ingestor {
	if cfg.ChunkBytes <= 0 {
		cfg.ChunkBytes = defaultChunkBytes
	}
	if cfg.RecordBytes <= 0 {
		cfg.RecordBytes = defaultRecordBytes
	}
	if cfg.FinalizationWait <= 0 {
		cfg.FinalizationWait = defaultFinalizationWait
	}
	if cfg.Clock == nil {
		cfg.Clock = time.Now
	}
	return &Ingestor{
		store:            store,
		chunkBytes:       cfg.ChunkBytes,
		recordBytes:      cfg.RecordBytes,
		finalizationWait: cfg.FinalizationWait,
		now:              cfg.Clock,
	}
}

// Ingest processes one source from its durable cursor. It never loops on an
// incomplete trailing record; a later filesystem event will enqueue the source
// again after the provider finishes the record.
func (i *Ingestor) Ingest(ctx context.Context, sourceID int64) (IngestResult, error) {
	now := i.now().UTC()
	source, ok, err := i.store.GetUsageSourceForIngestion(ctx, sourceID)
	if err != nil || !ok {
		return IngestResult{}, err
	}
	result := IngestResult{BindingID: source.Source.BindingID}
	info, err := os.Stat(source.Source.ArtifactPath)
	if err != nil || !info.Mode().IsRegular() {
		return i.retrySource(ctx, source.Source, domain.UsageErrorArtifactMissing, now, nil)
	}
	identity, err := usagesvc.SourceIdentity(source.Source.ArtifactPath)
	if err != nil {
		return i.retrySource(ctx, source.Source, domain.UsageErrorSourceReadFailed, now, nil)
	}
	if source.Source.FileIdentity != identity || info.Size() < source.Source.ByteOffset {
		return i.replaceSource(ctx, source, identity, now)
	}
	if source.Source.State == domain.UsageSourceComplete &&
		source.BindingState != domain.UsageBindingFinalizing &&
		info.Size() == source.Source.ByteOffset {
		return result, nil
	}
	if (source.BindingState == domain.UsageBindingComplete || source.BindingState == domain.UsageBindingPartial) &&
		info.Size() > source.Source.ByteOffset {
		if _, err := i.store.UpdateUsageBindingState(
			ctx,
			source.Source.BindingID,
			domain.UsageBindingFinalizing,
			"",
			now,
		); err != nil {
			return result, err
		}
		source.BindingState = domain.UsageBindingFinalizing
	}

	chunk, err := readJSONLChunk(
		source.Source.ArtifactPath,
		source.Source.ByteOffset,
		i.chunkBytes,
		i.recordBytes,
		source.Source.LastErrorCode,
	)
	if err != nil {
		return i.retrySource(ctx, source.Source, domain.UsageErrorSourceReadFailed, now, nil)
	}
	stableFinalTail := false
	finalizationSettled := source.Source.NextRetryAt != nil && !source.Source.NextRetryAt.After(now)
	if source.BindingState == domain.UsageBindingFinalizing &&
		finalizationSettled &&
		chunk.readToEOF &&
		len(chunk.trailing) > 0 {
		if tail := bytes.TrimSpace(chunk.trailing); len(tail) > 0 {
			chunk.records = append(chunk.records, jsonlRecord{
				Data:   append([]byte(nil), tail...),
				Offset: chunk.trailingOffset,
			})
		}
		chunk.nextOffset = chunk.fileSize
		chunk.atEOF = true
		stableFinalTail = true
	}
	parsed := parseRecords(source, chunk.records, chunk.nextOffset, now)
	if chunk.anomalies > 0 {
		parsed.Cursor.AnomalyCount += int64(chunk.anomalies)
		parsed.Cursor.LastErrorCode = chunk.errorCode
	}
	progressed := chunk.nextOffset > source.Source.ByteOffset
	if source.BindingState == domain.UsageBindingFinalizing &&
		(chunk.atEOF || !progressed) {
		if finalizationSettled && chunk.atEOF && (!progressed || stableFinalTail) {
			parsed.Cursor.State = domain.UsageSourceComplete
		} else {
			settleAt := now.Add(i.finalizationWait)
			parsed.Cursor.NextRetryAt = &settleAt
			result.RetryAt = &settleAt
		}
	}
	if _, err := i.store.ApplyUsageChunk(ctx, source.Source.ID, source.Source.ByteOffset, parsed.Cursor, parsed.Events); err != nil {
		if errors.Is(err, domain.ErrUsageSourceEventConflict) {
			if _, markErr := i.store.MarkUsageSourceState(
				ctx,
				source.Source.ID,
				domain.UsageSourceComplete,
				domain.UsageErrorSourceEventConflict,
				nil,
				now,
			); markErr != nil {
				return result, errors.Join(err, markErr)
			}
			if source.BindingState == domain.UsageBindingFinalizing {
				return result, i.completeBinding(ctx, source.Source.BindingID, now)
			}
			return result, nil
		}
		return result, fmt.Errorf("apply usage source %d: %w", source.Source.ID, err)
	}
	if parsed.Cursor.State == domain.UsageSourceComplete {
		return result, i.completeBinding(ctx, source.Source.BindingID, now)
	}
	result.More = progressed && !chunk.atEOF
	return result, nil
}

func (i *Ingestor) replaceSource(
	ctx context.Context,
	source domain.UsageSourceContext,
	identity string,
	now time.Time,
) (IngestResult, error) {
	result := IngestResult{BindingID: source.Source.BindingID, Refresh: true}
	replacement, err := i.store.ReplaceUsageSource(
		ctx,
		source.Source.ID,
		domain.UsageErrorArtifactReplaced,
		domain.UsageSourceRecord{
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
		},
		now,
	)
	if err != nil {
		return result, err
	}
	result.ReplacementSourceID = replacement.ID
	if source.BindingState == domain.UsageBindingComplete || source.BindingState == domain.UsageBindingPartial {
		if _, err := i.store.UpdateUsageBindingState(
			ctx,
			source.Source.BindingID,
			domain.UsageBindingFinalizing,
			"",
			now,
		); err != nil {
			return result, err
		}
	}
	return result, nil
}

func (i *Ingestor) retrySource(
	ctx context.Context,
	source domain.UsageSourceRecord,
	code string,
	now time.Time,
	cause error,
) (IngestResult, error) {
	failures := source.FailureCount + 1
	delay := retryDelay(failures)
	next := now.Add(delay)
	result := IngestResult{BindingID: source.BindingID, RetryAt: &next}
	if code == domain.UsageErrorArtifactMissing {
		result.Reconcile = true
	}
	if _, err := i.store.MarkUsageSourceFailure(ctx, source.ID, failures, code, next, now); err != nil {
		return result, err
	}
	if cause == nil {
		cause = errors.New(code)
	}
	return result, fmt.Errorf("usage source %d: %w", source.ID, cause)
}

func (i *Ingestor) completeBinding(ctx context.Context, bindingID int64, now time.Time) error {
	_, err := i.store.CompleteUsageBindingIfSettled(ctx, bindingID, now)
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
	records        []jsonlRecord
	nextOffset     int64
	atEOF          bool
	readToEOF      bool
	fileSize       int64
	trailing       []byte
	trailingOffset int64
	anomalies      int
	errorCode      string
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
	chunk := jsonlChunk{
		nextOffset: offset,
		fileSize:   info.Size(),
		readToEOF:  offset+int64(len(data)) >= info.Size(),
	}
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
			chunk.atEOF = chunk.nextOffset >= info.Size()
		} else {
			chunk.trailing = append([]byte(nil), data[start:]...)
			chunk.trailingOffset = offset + int64(start)
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
	if !chunk.atEOF && completeEnd < len(data) && len(data)-completeEnd <= maxRecord {
		chunk.trailing = append([]byte(nil), data[completeEnd:]...)
		chunk.trailingOffset = chunk.nextOffset
	}
	return chunk, nil
}
