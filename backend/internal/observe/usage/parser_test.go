package usage

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestParseClaudeFinalUsageAndSkipMainSidechain(t *testing.T) {
	now := time.Unix(1700000000, 0).UTC()
	source := usageSource(domain.UsageSourceClaudeMain)
	records := []jsonlRecord{
		{Offset: 0, Data: []byte(`{"type":"assistant","isSidechain":true,"uuid":"side","timestamp":"2026-07-01T10:00:00Z","message":{"id":"msg-side","model":"claude-x","stop_reason":"end_turn","usage":{"input_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":5}}}`)},
		{Offset: 300, Data: []byte(`{"type":"assistant","isSidechain":false,"uuid":"main","timestamp":"2026-07-01T10:01:00Z","message":{"id":"msg-main","model":"claude-x","stop_reason":"tool_use","usage":{"input_tokens":10,"cache_creation_input_tokens":3,"cache_read_input_tokens":7,"output_tokens":4,"cache_creation":{"ephemeral_5m_input_tokens":2,"ephemeral_1h_input_tokens":1}}}}`)},
		{Offset: 600, Data: []byte(`{"type":"assistant","message":{"id":"stream","model":"claude-x","stop_reason":null,"usage":{"input_tokens":100,"output_tokens":20}}}`)},
	}

	result := parseRecords(source, records, 700, now)
	if len(result.Events) != 1 {
		t.Fatalf("events = %d, want 1", len(result.Events))
	}
	got := result.Events[0]
	if got.Tokens.InputTokens != 20 || got.Tokens.UncachedInputTokens != 10 ||
		got.Tokens.CacheReadTokens != 7 || got.Tokens.CacheWriteTokens != 3 ||
		got.Tokens.OutputTokens != 4 {
		t.Fatalf("tokens = %+v", got.Tokens)
	}
	if got.Tokens.CacheWrite5mTokens == nil || *got.Tokens.CacheWrite5mTokens != 2 ||
		got.Tokens.CacheWrite1hTokens == nil || *got.Tokens.CacheWrite1hTokens != 1 {
		t.Fatalf("cache split = %+v", got.Tokens)
	}
	if got.ModelID != "claude-x" || got.Cost.CostBasis != domain.CostBasisUnavailable {
		t.Fatalf("event = %+v", got)
	}
}

func TestParseClaudeSubagentIncludesSidechainTranscript(t *testing.T) {
	source := usageSource(domain.UsageSourceClaudeSubagent)
	record := jsonlRecord{Data: []byte(`{"type":"assistant","isSidechain":true,"uuid":"sub","message":{"id":"msg-sub","model":"claude-x","stop_reason":"end_turn","usage":{"input_tokens":8,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":2}}}`)}
	result := parseRecords(source, []jsonlRecord{record}, 200, time.Unix(1700000000, 0).UTC())
	if len(result.Events) != 1 {
		t.Fatalf("events = %d, want subagent usage", len(result.Events))
	}
}

func TestParseCodexCumulativeDeltasAndRepeats(t *testing.T) {
	now := time.Unix(1700000000, 0).UTC()
	source := usageSource(domain.UsageSourceCodexRollout)
	records := []jsonlRecord{
		{Offset: 0, Data: []byte(`{"type":"session_meta","payload":{"model_provider":"openai"}}`)},
		{Offset: 100, Data: []byte(`{"type":"turn_context","payload":{"model":"gpt-5.6"}}`)},
		{Offset: 200, Data: codexTokenLine("2026-07-01T10:00:00Z", 100, 60, 10, 20, 5)},
		{Offset: 300, Data: codexTokenLine("2026-07-01T10:00:01Z", 100, 60, 10, 20, 5)},
		{Offset: 400, Data: codexTokenLine("2026-07-01T10:00:02Z", 160, 90, 10, 35, 8)},
	}
	result := parseRecords(source, records, 500, now)
	if len(result.Events) != 2 {
		t.Fatalf("events = %d, want 2", len(result.Events))
	}
	if got := result.Events[0].Tokens; got.InputTokens != 100 || got.UncachedInputTokens != 30 ||
		got.CacheReadTokens != 60 || got.CacheWriteTokens != 10 || got.OutputTokens != 20 {
		t.Fatalf("first tokens = %+v", got)
	}
	if got := result.Events[1].Tokens; got.InputTokens != 60 || got.UncachedInputTokens != 30 ||
		got.CacheReadTokens != 30 || got.OutputTokens != 15 ||
		got.ReasoningTokens == nil || *got.ReasoningTokens != 3 {
		t.Fatalf("delta tokens = %+v", got)
	}
	if result.Cursor.BaselineInputTokens != 160 || result.Cursor.CurrentModelID != "gpt-5.6" ||
		result.Cursor.CurrentProvider != "openai" {
		t.Fatalf("cursor = %+v", result.Cursor)
	}
}

func TestParseCodexCounterResetNeverEmitsNegativeUsage(t *testing.T) {
	now := time.Unix(1700000000, 0).UTC()
	source := usageSource(domain.UsageSourceCodexRollout)
	source.Source.BaselineInputTokens = 500
	source.Source.BaselineCachedInputTokens = 300
	source.Source.BaselineOutputTokens = 50
	result := parseRecords(source, []jsonlRecord{{
		Offset: 20,
		Data:   codexTokenLine("2026-07-01T10:00:00Z", 10, 5, 0, 2, 1),
	}}, 100, now)
	if len(result.Events) != 0 {
		t.Fatalf("events = %+v, want no negative delta event", result.Events)
	}
	if result.Cursor.AnomalyCount != 1 ||
		result.Cursor.LastErrorCode != domain.UsageErrorNonMonotonicCumulativeUsage ||
		result.Cursor.BaselineInputTokens != 10 {
		t.Fatalf("cursor = %+v", result.Cursor)
	}
}

func TestReadJSONLChunkRetainsPartialTailAndSkipsOversizedRecord(t *testing.T) {
	path := t.TempDir() + "/rollout.jsonl"
	if err := osWrite(path, `{"a":1}`+"\n"+`{"b":`); err != nil {
		t.Fatal(err)
	}
	first, err := readJSONLChunk(path, 0, 1024, 32, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(first.records) != 1 || first.atEOF || first.nextOffset != int64(len(`{"a":1}`+"\n")) {
		t.Fatalf("first chunk = %+v", first)
	}
	if err := osAppend(path, `2}`+"\n"); err != nil {
		t.Fatal(err)
	}
	second, err := readJSONLChunk(path, first.nextOffset, 1024, 32, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(second.records) != 1 || !second.atEOF {
		t.Fatalf("second chunk = %+v", second)
	}

	if err := osWrite(path, strings.Repeat("x", 40)+"\n"); err != nil {
		t.Fatal(err)
	}
	large, err := readJSONLChunk(path, 0, 1024, 16, "")
	if err != nil {
		t.Fatal(err)
	}
	if large.anomalies != 1 || large.errorCode != domain.UsageErrorRecordTooLarge || large.nextOffset != 41 {
		t.Fatalf("oversized chunk = %+v", large)
	}
}

func usageSource(kind domain.UsageSourceKind) domain.UsageSourceContext {
	return domain.UsageSourceContext{
		Source: domain.UsageSourceRecord{
			ID:            7,
			Kind:          kind,
			ParserVersion: "test/v1",
			State:         domain.UsageSourceActive,
		},
		InitialModelID: "fallback-model",
	}
}

func codexTokenLine(timestamp string, input, cached, cacheWrite, output, reasoning int64) []byte {
	return []byte(fmt.Sprintf(
		`{"timestamp":%q,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":%d,"cached_input_tokens":%d,"cache_write_input_tokens":%d,"output_tokens":%d,"reasoning_output_tokens":%d}}}}`,
		timestamp, input, cached, cacheWrite, output, reasoning,
	))
}

func osWrite(path, content string) error {
	return os.WriteFile(path, []byte(content), 0o600)
}

func osAppend(path, content string) error {
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	_, err = file.WriteString(content)
	return err
}
