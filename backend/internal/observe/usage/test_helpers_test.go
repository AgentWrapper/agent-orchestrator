package usage

import (
	"fmt"
	"os"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func parseRecords(source domain.UsageSourceContext, records []jsonlRecord, nextOffset int64, now time.Time) parseResult {
	state, err := decodeParserState(source.Source)
	if err != nil {
		return parseResult{err: fmt.Errorf("decode parser state: %w", err)}
	}
	return parseRecordsWithState(source, records, nextOffset, now, state)
}

func readJSONLChunkFromFile(file *os.File, offset, maxBytes int64, maxRecord int, previousError string) (jsonlChunk, error) {
	info, err := file.Stat()
	if err != nil {
		return jsonlChunk{}, err
	}
	return readJSONLChunkFromSnapshot(file, info.Size(), offset, maxBytes, maxRecord, previousError)
}
