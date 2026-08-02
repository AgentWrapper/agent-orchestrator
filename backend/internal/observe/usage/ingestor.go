package usage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
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
	ReconcilePath       string
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
	openTranscript   func(string) (*os.File, error)
	afterRead        func()
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
		openTranscript:   os.Open,
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
	parserState, err := decodeParserState(source.Source)
	if err != nil {
		return i.retrySource(
			ctx,
			source.Source,
			domain.UsageErrorInvalidParserState,
			now,
			fmt.Errorf("decode parser state: %w", err),
		)
	}
	file, err := i.openTranscript(source.Source.ArtifactPath) //nolint:gosec // path was validated at registration.
	if err != nil {
		return i.retrySource(ctx, source.Source, domain.UsageErrorArtifactMissing, now, nil)
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return i.retrySource(ctx, source.Source, domain.UsageErrorArtifactMissing, now, nil)
	}
	identity, err := usagesvc.SourceIdentityFromFile(file)
	if err != nil {
		return i.retrySource(ctx, source.Source, domain.UsageErrorSourceReadFailed, now, nil)
	}
	if source.Source.FileIdentity != identity || info.Size() < source.Source.ByteOffset {
		return i.resetSourceGeneration(ctx, source, identity, now)
	}
	if source.Source.ByteOffset > 0 && parserState.Integrity.Checkpoint == nil {
		return i.resetSourceGeneration(ctx, source, identity, now)
	}
	cursorSample, err := parserCheckpointSampleAt(file, source.Source.ByteOffset)
	if err != nil {
		return i.retrySource(ctx, source.Source, domain.UsageErrorSourceReadFailed, now, nil)
	}
	snapshot := transcriptSnapshot{
		identity:     identity,
		size:         info.Size(),
		modTime:      info.ModTime(),
		cursorSample: cursorSample,
	}
	if !parserCheckpointsEqual(cursorSample.checkpoint, parserState.Integrity.Checkpoint) {
		return i.resetSourceGeneration(ctx, source, identity, now)
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

	chunk, err := readJSONLChunkFromSnapshot(
		file,
		snapshot.size,
		source.Source.ByteOffset,
		i.chunkBytes,
		i.recordBytes,
		source.Source.LastErrorCode,
	)
	if err != nil {
		return i.retrySource(ctx, source.Source, domain.UsageErrorSourceReadFailed, now, nil)
	}
	if i.afterRead != nil {
		i.afterRead()
	}
	finalizationSettled := source.Source.NextRetryAt != nil && !source.Source.NextRetryAt.After(now)
	finalTailSettled := false
	tailPending := false
	restartQuietPeriod := false
	if source.BindingState == domain.UsageBindingFinalizing && chunk.readToEOF && len(chunk.trailing) > 0 {
		observedTail := stableTailObservation(chunk.trailingOffset, chunk.trailing)
		previousTail := parserState.Integrity.StableTail
		switch {
		case !sameStableTail(previousTail, observedTail):
			parserState.Integrity.StableTail = observedTail
			tailPending = true
			restartQuietPeriod = true
		case !finalizationSettled:
			tailPending = true
		case json.Valid(bytes.TrimSpace(chunk.trailing)) || len(bytes.TrimSpace(chunk.trailing)) == 0:
			if tail := bytes.TrimSpace(chunk.trailing); len(tail) > 0 {
				chunk.records = append(chunk.records, jsonlRecord{
					Data:   append([]byte(nil), tail...),
					Offset: chunk.trailingOffset,
				})
			}
			chunk.nextOffset = chunk.fileSize
			chunk.atEOF = true
			parserState.Integrity.StableTail = nil
			finalTailSettled = true
		case previousTail.QuietObservations == 0:
			previousTail.QuietObservations = 1
			tailPending = true
			restartQuietPeriod = true
		default:
			chunk.nextOffset = chunk.fileSize
			chunk.atEOF = true
			chunk.anomalies++
			chunk.errorCode = domain.UsageErrorMalformedJSONL
			parserState.Integrity.StableTail = nil
			finalTailSettled = true
		}
	} else {
		parserState.Integrity.StableTail = nil
	}
	checkpoint, err := parserCheckpointAfterRead(
		snapshot.cursorSample,
		source.Source.ByteOffset,
		chunk.nextOffset,
		chunk.data,
	)
	if err != nil {
		return i.retrySource(ctx, source.Source, domain.UsageErrorSourceReadFailed, now, nil)
	}
	parserState.Integrity.Checkpoint = checkpoint
	parsed := parseRecordsWithState(source, chunk.records, chunk.nextOffset, now, parserState)
	if parsed.err != nil {
		return i.retrySource(ctx, source.Source, domain.UsageErrorInvalidParserState, now, parsed.err)
	}
	if chunk.anomalies > 0 {
		parsed.Cursor.AnomalyCount += int64(chunk.anomalies)
		parsed.Cursor.LastErrorCode = chunk.errorCode
	}
	progressed := chunk.nextOffset > source.Source.ByteOffset
	if source.BindingState == domain.UsageBindingFinalizing && tailPending {
		settleAt := nextFinalizationRetry(now, i.finalizationWait, source.Source.NextRetryAt, restartQuietPeriod)
		parsed.Cursor.NextRetryAt = &settleAt
		result.RetryAt = &settleAt
	} else if source.BindingState == domain.UsageBindingFinalizing &&
		(chunk.atEOF || !progressed) {
		if finalizationSettled && chunk.atEOF && (!progressed || finalTailSettled) {
			parsed.Cursor.State = domain.UsageSourceComplete
			if parsed.pendingCodexSpawnCalls > 0 {
				parsed.Cursor.AnomalyCount++
				parsed.Cursor.LastErrorCode = domain.UsageErrorUnresolvedSpawnCall
			}
		} else {
			settleAt := nextFinalizationRetry(
				now,
				i.finalizationWait,
				source.Source.NextRetryAt,
				progressed,
			)
			parsed.Cursor.NextRetryAt = &settleAt
			result.RetryAt = &settleAt
		}
	}
	unchanged, err := transcriptSnapshotUnchanged(file, source.Source.ByteOffset, snapshot)
	if err != nil {
		return i.retrySource(ctx, source.Source, domain.UsageErrorSourceReadFailed, now, err)
	}
	if !unchanged {
		return i.retrySource(
			ctx,
			source.Source,
			domain.UsageErrorSourceReadFailed,
			now,
			errors.New("transcript changed during ingestion"),
		)
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
	result.Reconcile = parsed.newCodexChild
	if parsed.Cursor.State == domain.UsageSourceComplete {
		return result, i.completeBinding(ctx, source.Source.BindingID, now)
	}
	result.More = progressed && !chunk.atEOF && !chunk.readToEOF
	return result, nil
}

func stableTailObservation(offset int64, tail []byte) *stableTailStateV1 {
	digest := sha256.Sum256(tail)
	return &stableTailStateV1{
		Offset:    offset,
		ByteCount: int64(len(tail)),
		SHA256:    fmt.Sprintf("%x", digest),
	}
}

func sameStableTail(left, right *stableTailStateV1) bool {
	return left != nil && right != nil &&
		left.Offset == right.Offset &&
		left.ByteCount == right.ByteCount &&
		left.SHA256 == right.SHA256
}

func nextFinalizationRetry(
	now time.Time,
	wait time.Duration,
	existing *time.Time,
	restart bool,
) time.Time {
	if !restart && existing != nil && existing.After(now) {
		return existing.UTC()
	}
	return now.Add(wait)
}

type transcriptSnapshot struct {
	identity     string
	size         int64
	modTime      time.Time
	cursorSample parserCheckpointSample
}

type parserCheckpointSample struct {
	checkpoint *parserCheckpointV1
	data       []byte
}

func parserCheckpointSampleAt(file *os.File, offset int64) (parserCheckpointSample, error) {
	if offset <= 0 {
		return parserCheckpointSample{}, nil
	}
	byteCount := min(offset, int64(integrityCheckpointBytes))
	data := make([]byte, byteCount)
	read, err := file.ReadAt(data, offset-byteCount)
	if err != nil && !errors.Is(err, io.EOF) {
		return parserCheckpointSample{}, err
	}
	if int64(read) != byteCount {
		return parserCheckpointSample{}, io.ErrUnexpectedEOF
	}
	digest := sha256.Sum256(data)
	return parserCheckpointSample{
		checkpoint: &parserCheckpointV1{
			EndOffset: offset,
			ByteCount: byteCount,
			SHA256:    fmt.Sprintf("%x", digest),
		},
		data: data,
	}, nil
}

func parserCheckpointsEqual(left, right *parserCheckpointV1) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return left.EndOffset == right.EndOffset &&
		left.ByteCount == right.ByteCount &&
		left.SHA256 == right.SHA256
}

func parserCheckpointAfterRead(
	before parserCheckpointSample,
	offset int64,
	nextOffset int64,
	read []byte,
) (*parserCheckpointV1, error) {
	consumed := nextOffset - offset
	if consumed < 0 || consumed > int64(len(read)) {
		return nil, io.ErrUnexpectedEOF
	}
	if nextOffset <= 0 {
		return nil, nil
	}
	window := make([]byte, 0, len(before.data)+int(consumed))
	window = append(window, before.data...)
	window = append(window, read[:consumed]...)
	byteCount := min(nextOffset, int64(integrityCheckpointBytes))
	if int64(len(window)) < byteCount {
		return nil, io.ErrUnexpectedEOF
	}
	window = window[len(window)-int(byteCount):]
	digest := sha256.Sum256(window)
	return &parserCheckpointV1{
		EndOffset: nextOffset,
		ByteCount: byteCount,
		SHA256:    fmt.Sprintf("%x", digest),
	}, nil
}

func transcriptSnapshotUnchanged(file *os.File, offset int64, before transcriptSnapshot) (bool, error) {
	info, err := file.Stat()
	if err != nil {
		return false, err
	}
	identity, err := usagesvc.SourceIdentityFromFile(file)
	if err != nil {
		return false, err
	}
	afterCursor, err := parserCheckpointSampleAt(file, offset)
	if err != nil {
		return false, err
	}
	return info.Mode().IsRegular() &&
		identity == before.identity &&
		info.Size() == before.size &&
		info.ModTime().Equal(before.modTime) &&
		parserCheckpointsEqual(afterCursor.checkpoint, before.cursorSample.checkpoint), nil
}

func (i *Ingestor) resetSourceGeneration(
	ctx context.Context,
	source domain.UsageSourceContext,
	identity string,
	now time.Time,
) (IngestResult, error) {
	if source.Source.Kind == domain.UsageSourceCodexRollout && source.Source.SubagentID != "" {
		return i.retireCodexChildForReconciliation(ctx, source, now)
	}
	return i.replaceSource(ctx, source, identity, now)
}

func (i *Ingestor) retireCodexChildForReconciliation(
	ctx context.Context,
	source domain.UsageSourceContext,
	now time.Time,
) (IngestResult, error) {
	result := IngestResult{
		BindingID:     source.Source.BindingID,
		Refresh:       true,
		Reconcile:     true,
		ReconcilePath: source.Source.ArtifactPath,
	}
	if _, err := i.store.MarkUsageSourceState(
		ctx,
		source.Source.ID,
		domain.UsageSourceComplete,
		domain.UsageErrorArtifactReplaced,
		nil,
		now,
	); err != nil {
		return result, err
	}
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
	data           []byte
	nextOffset     int64
	atEOF          bool
	readToEOF      bool
	fileSize       int64
	trailing       []byte
	trailingOffset int64
	anomalies      int
	errorCode      string
}

func readJSONLChunkFromFile(file *os.File, offset, maxBytes int64, maxRecord int, previousError string) (jsonlChunk, error) {
	info, err := file.Stat()
	if err != nil {
		return jsonlChunk{}, err
	}
	return readJSONLChunkFromSnapshot(file, info.Size(), offset, maxBytes, maxRecord, previousError)
}

func readJSONLChunkFromSnapshot(
	file *os.File,
	fileSize int64,
	offset int64,
	maxBytes int64,
	maxRecord int,
	previousError string,
) (jsonlChunk, error) {
	if offset < 0 || fileSize < offset {
		return jsonlChunk{}, io.ErrUnexpectedEOF
	}
	readSize := min(maxBytes, fileSize-offset)
	if readSize < 0 {
		readSize = 0
	}
	data, err := io.ReadAll(io.NewSectionReader(file, offset, readSize))
	if err != nil {
		return jsonlChunk{}, err
	}
	if int64(len(data)) != readSize {
		return jsonlChunk{}, io.ErrUnexpectedEOF
	}
	chunk := jsonlChunk{
		nextOffset: offset,
		data:       data,
		fileSize:   fileSize,
		readToEOF:  offset+int64(len(data)) >= fileSize,
	}
	if len(data) == 0 {
		chunk.atEOF = offset >= fileSize
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
			chunk.atEOF = chunk.nextOffset >= fileSize
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
	chunk.atEOF = chunk.nextOffset >= fileSize
	if !chunk.atEOF && completeEnd < len(data) && len(data)-completeEnd <= maxRecord {
		chunk.trailing = append([]byte(nil), data[completeEnd:]...)
		chunk.trailingOffset = chunk.nextOffset
	}
	return chunk, nil
}
