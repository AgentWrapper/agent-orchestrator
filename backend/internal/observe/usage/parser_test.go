package usage

import (
	"context"
	"errors"
	"fmt"
	"io"
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
	if got.ModelID != "claude-x" {
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
	state := parserStateFromResult(t, result, domain.UsageSourceCodexRollout)
	if state.Codex.Baseline.InputTokens != 160 || state.Codex.ModelID != "gpt-5.6" {
		t.Fatalf("parser state = %+v", state.Codex)
	}
}

func TestParseCodexCounterResetNeverEmitsNegativeUsage(t *testing.T) {
	now := time.Unix(1700000000, 0).UTC()
	source := usageSource(domain.UsageSourceCodexRollout)
	source.Source.ParserStateJSON = `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{"input_tokens":500,"cached_input_tokens":300,"cache_write_input_tokens":0,"output_tokens":50,"reasoning_output_tokens":0},"pending_spawn_call_ids":[],"discovered_child_ids":[]}}`
	result := parseRecords(source, []jsonlRecord{{
		Offset: 20,
		Data:   codexTokenLine("2026-07-01T10:00:00Z", 10, 5, 0, 2, 1),
	}}, 100, now)
	if len(result.Events) != 0 {
		t.Fatalf("events = %+v, want no negative delta event", result.Events)
	}
	state := parserStateFromResult(t, result, domain.UsageSourceCodexRollout)
	if result.Cursor.AnomalyCount != 1 ||
		result.Cursor.LastErrorCode != domain.UsageErrorNonMonotonicCumulativeUsage ||
		state.Codex.Baseline.InputTokens != 10 {
		t.Fatalf("cursor = %+v", result.Cursor)
	}
}

func TestParseCodexContextFillStartsNewEpochWithoutAnomaly(t *testing.T) {
	now := time.Unix(1700000000, 0).UTC()
	source := usageSource(domain.UsageSourceCodexRollout)
	source.Source.ParserStateJSON = `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{"input_tokens":500,"cached_input_tokens":300,"cache_write_input_tokens":0,"output_tokens":50,"reasoning_output_tokens":10,"total_tokens":550},"pending_spawn_call_ids":[],"discovered_child_ids":[]}}`
	records := []jsonlRecord{
		{Offset: 20, Data: codexContextFillLine("2026-07-01T10:00:00Z", 258400)},
		{Offset: 40, Data: codexTokenLine("2026-07-01T10:00:01Z", 10, 5, 0, 2, 1)},
	}

	result := parseRecords(source, records, 100, now)
	if result.Cursor.AnomalyCount != 0 || result.Cursor.LastErrorCode != "" {
		t.Fatalf("cursor = %+v, want clean context-fill transition", result.Cursor)
	}
	if len(result.Events) != 1 {
		t.Fatalf("events = %+v, want one event from the new epoch", result.Events)
	}
	if got := result.Events[0].Tokens; got.InputTokens != 10 || got.CacheReadTokens != 5 ||
		got.UncachedInputTokens != 5 || got.OutputTokens != 2 {
		t.Fatalf("new epoch tokens = %+v", got)
	}
}

func TestDecodeParserStateTreatsWhitespaceOnlyObjectAsFreshState(t *testing.T) {
	tests := []struct {
		name string
		kind domain.UsageSourceKind
		raw  string
	}{
		{name: "claude spaces", kind: domain.UsageSourceClaudeMain, raw: "{ }"},
		{name: "claude newline", kind: domain.UsageSourceClaudeSubagent, raw: "{\n\t}"},
		{name: "codex spaces", kind: domain.UsageSourceCodexRollout, raw: "{   }"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			state, err := decodeParserState(domain.UsageSourceRecord{
				Kind:            test.kind,
				ParserStateJSON: test.raw,
			})
			if err != nil {
				t.Fatalf("decode semantically empty parser state: %v", err)
			}
			if state.Version != parserStateVersion || state.SourceKind != test.kind {
				t.Fatalf("state = %+v, want fresh %s state", state, test.kind)
			}
			switch test.kind {
			case domain.UsageSourceCodexRollout:
				if state.Codex == nil || state.Claude != nil {
					t.Fatalf("Codex state = %+v", state)
				}
			default:
				if state.Claude == nil || state.Codex != nil {
					t.Fatalf("Claude state = %+v", state)
				}
			}
		})
	}
}

func TestDecodeParserStateRetiresPersistedProviderField(t *testing.T) {
	tests := []struct {
		kind domain.UsageSourceKind
		raw  string
	}{
		{
			kind: domain.UsageSourceClaudeMain,
			raw:  `{"version":1,"source_kind":"claude_main","claude":{"model_id":"claude-test","provider":"anthropic"}}`,
		},
		{
			kind: domain.UsageSourceCodexRollout,
			raw:  `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{},"provider":"openai","pending_spawn_call_ids":[],"discovered_child_ids":[]}}`,
		},
	}
	for _, test := range tests {
		state, err := decodeParserState(domain.UsageSourceRecord{Kind: test.kind, ParserStateJSON: test.raw})
		if err != nil {
			t.Fatalf("decode %s state with retired provider field: %v", test.kind, err)
		}
		parsed := parseRecordsWithState(
			domain.UsageSourceContext{Source: domain.UsageSourceRecord{Kind: test.kind}},
			nil,
			0,
			time.Unix(1700000000, 0).UTC(),
			state,
		)
		if parsed.err != nil {
			t.Fatalf("encode normalized %s state: %v", test.kind, parsed.err)
		}
		if strings.Contains(parsed.Cursor.ParserStateJSON, `"provider"`) {
			t.Fatalf("normalized %s state retained provider: %s", test.kind, parsed.Cursor.ParserStateJSON)
		}
	}
}

func TestDecodeParserStateValidatesV1Integrity(t *testing.T) {
	initial := `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{},"pending_spawn_call_ids":[],"discovered_child_ids":[]}}`
	state, err := decodeParserState(domain.UsageSourceRecord{
		Kind:            domain.UsageSourceCodexRollout,
		ByteOffset:      12,
		ParserStateJSON: initial,
	})
	if err != nil {
		t.Fatalf("decode initial state: %v", err)
	}
	if state.Integrity == nil || state.Codex == nil {
		t.Fatalf("initial state = %+v", state)
	}

	digest := strings.Repeat("a", 64)
	valid := `{"version":1,"source_kind":"codex_rollout","integrity":{"checkpoint":{"end_offset":12,"byte_count":12,"sha256":"` + digest + `"}},"codex":{"baseline":{},"pending_spawn_call_ids":[],"discovered_child_ids":[]}}`
	if _, err := decodeParserState(domain.UsageSourceRecord{
		Kind:            domain.UsageSourceCodexRollout,
		ByteOffset:      12,
		ParserStateJSON: valid,
	}); err != nil {
		t.Fatalf("decode valid integrity state: %v", err)
	}

	invalid := []string{
		`{"version":1,"source_kind":"codex_rollout","integrity":{"checkpoint":{"end_offset":11,"byte_count":11,"sha256":"` + digest + `"}},"codex":{"baseline":{},"pending_spawn_call_ids":[],"discovered_child_ids":[]}}`,
		`{"version":1,"source_kind":"codex_rollout","integrity":{"checkpoint":{"end_offset":12,"byte_count":12,"sha256":"short"}},"codex":{"baseline":{},"pending_spawn_call_ids":[],"discovered_child_ids":[]}}`,
		`{"version":1,"source_kind":"codex_rollout","integrity":{"stable_tail":{"offset":12,"byte_count":4,"sha256":"` + digest + `","quiet_observations":2}},"codex":{"baseline":{},"pending_spawn_call_ids":[],"discovered_child_ids":[]}}`,
		`{"version":1,"source_kind":"codex_rollout","integrity":{"stable_tail":{"offset":12,"byte_count":4,"sha256":"` + digest + `","quiet_observations":0,"content":"private"}},"codex":{"baseline":{},"pending_spawn_call_ids":[],"discovered_child_ids":[]}}`,
	}
	for index, raw := range invalid {
		if _, err := decodeParserState(domain.UsageSourceRecord{
			Kind:            domain.UsageSourceCodexRollout,
			ByteOffset:      12,
			ParserStateJSON: raw,
		}); err == nil {
			t.Errorf("invalid state %d was accepted", index)
		}
	}
}

func TestDecodeParserStateValidatesCodexDirectParent(t *testing.T) {
	validChild := `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{},"native_session_id":"22222222-2222-4222-8222-222222222222","direct_parent_id":"11111111-1111-4111-8111-111111111111","pending_spawn_call_ids":[],"discovered_child_ids":[]}}`
	child := domain.UsageSourceRecord{
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: "22222222-2222-4222-8222-222222222222",
		SubagentID:      "22222222-2222-4222-8222-222222222222",
		ParserStateJSON: validChild,
	}
	state, err := decodeParserState(child)
	mustNoError(t, err, "decode child direct parent")
	parsed := parseRecordsWithState(
		domain.UsageSourceContext{Source: child},
		nil,
		0,
		time.Unix(1700000000, 0).UTC(),
		state,
	)
	if parsed.err != nil || !strings.Contains(
		parsed.Cursor.ParserStateJSON,
		`"native_session_id":"22222222-2222-4222-8222-222222222222"`,
	) || !strings.Contains(
		parsed.Cursor.ParserStateJSON,
		`"direct_parent_id":"11111111-1111-4111-8111-111111111111"`,
	) {
		t.Fatalf("persisted child state = %q, err=%v", parsed.Cursor.ParserStateJSON, parsed.err)
	}

	invalid := []struct {
		name   string
		source domain.UsageSourceRecord
	}{
		{
			name: "child mismatched native session",
			source: domain.UsageSourceRecord{
				Kind:            domain.UsageSourceCodexRollout,
				NativeSessionID: "33333333-3333-4333-8333-333333333333",
				SubagentID:      "33333333-3333-4333-8333-333333333333",
				ParserStateJSON: validChild,
			},
		},
		{
			name: "child missing direct parent",
			source: domain.UsageSourceRecord{
				Kind:            domain.UsageSourceCodexRollout,
				NativeSessionID: child.NativeSessionID,
				SubagentID:      child.SubagentID,
				ParserStateJSON: `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{},"pending_spawn_call_ids":[],"discovered_child_ids":[]}}`,
			},
		},
		{
			name: "child invalid direct parent",
			source: domain.UsageSourceRecord{
				Kind:            domain.UsageSourceCodexRollout,
				NativeSessionID: child.NativeSessionID,
				SubagentID:      child.SubagentID,
				ParserStateJSON: `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{},"direct_parent_id":"not-a-thread","pending_spawn_call_ids":[],"discovered_child_ids":[]}}`,
			},
		},
		{
			name: "root has direct parent",
			source: domain.UsageSourceRecord{
				Kind:            domain.UsageSourceCodexRollout,
				NativeSessionID: "11111111-1111-4111-8111-111111111111",
				ParserStateJSON: validChild,
			},
		},
	}
	for _, test := range invalid {
		t.Run(test.name, func(t *testing.T) {
			if _, err := decodeParserState(test.source); err == nil {
				t.Fatal("invalid Codex direct-parent state was accepted")
			}
		})
	}
}

func TestParsersRejectInvalidTokenVectorsAndAdvanceCursor(t *testing.T) {
	now := time.Unix(1700000000, 0).UTC()
	tests := []struct {
		name   string
		source domain.UsageSourceContext
		record []byte
	}{
		{
			name:   "claude negative cache input",
			source: usageSource(domain.UsageSourceClaudeMain),
			record: []byte(`{"type":"assistant","uuid":"bad","message":{"id":"bad","model":"claude-x","stop_reason":"end_turn","usage":{"input_tokens":8,"cache_creation_input_tokens":-1,"cache_read_input_tokens":0,"output_tokens":2}}}`),
		},
		{
			name:   "codex cached input exceeds input",
			source: usageSource(domain.UsageSourceCodexRollout),
			record: codexTokenLine("2026-07-01T10:00:00Z", 10, 11, 0, 2, 1),
		},
		{
			name:   "codex reasoning exceeds output",
			source: usageSource(domain.UsageSourceCodexRollout),
			record: codexTokenLine("2026-07-01T10:00:00Z", 10, 5, 0, 2, 3),
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := parseRecords(test.source, []jsonlRecord{{Data: test.record}}, 777, now)
			if len(result.Events) != 0 {
				t.Fatalf("events = %+v, want none", result.Events)
			}
			if result.Cursor.ByteOffset != 777 || result.Cursor.AnomalyCount != 1 ||
				result.Cursor.LastErrorCode != domain.UsageErrorMalformedJSONL {
				t.Fatalf("cursor = %+v", result.Cursor)
			}
		})
	}
}

func TestParserEventKeysSurvivePhysicalSourceReplacement(t *testing.T) {
	now := time.Unix(1700000000, 0).UTC()
	claudeRecord := jsonlRecord{
		Offset: 120,
		Data: []byte(
			`{"type":"assistant","uuid":"native-message","message":{"id":"msg-1","model":"claude-x","stop_reason":"end_turn","usage":{"input_tokens":8,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":2}}}`,
		),
	}
	firstClaude := usageSource(domain.UsageSourceClaudeMain)
	firstClaude.NativeRootID = "claude-root"
	firstClaude.Source.NativeSessionID = "claude-root"
	secondClaude := firstClaude
	secondClaude.Source.ID = 99

	firstClaudeResult := parseRecords(firstClaude, []jsonlRecord{claudeRecord}, 400, now)
	secondClaudeResult := parseRecords(secondClaude, []jsonlRecord{claudeRecord}, 400, now)
	if len(firstClaudeResult.Events) != 1 || len(secondClaudeResult.Events) != 1 ||
		firstClaudeResult.Events[0].SourceEventKey != secondClaudeResult.Events[0].SourceEventKey {
		t.Fatalf("claude keys=%+v/%+v", firstClaudeResult.Events, secondClaudeResult.Events)
	}

	codexRecords := []jsonlRecord{
		{Offset: 0, Data: []byte(`{"type":"turn_context","payload":{"model":"gpt-5.6"}}`)},
		{Offset: 100, Data: codexTokenLine("2026-07-28T10:00:00Z", 100, 60, 0, 20, 5)},
	}
	firstCodex := usageSource(domain.UsageSourceCodexRollout)
	firstCodex.NativeRootID = "codex-root"
	firstCodex.Source.NativeSessionID = "codex-root"
	secondCodex := firstCodex
	secondCodex.Source.ID = 100
	firstCodexResult := parseRecords(firstCodex, codexRecords, 300, now)
	secondCodexResult := parseRecords(secondCodex, codexRecords, 300, now)
	if len(firstCodexResult.Events) != 1 || len(secondCodexResult.Events) != 1 ||
		firstCodexResult.Events[0].SourceEventKey != secondCodexResult.Events[0].SourceEventKey {
		t.Fatalf("codex keys=%+v/%+v", firstCodexResult.Events, secondCodexResult.Events)
	}
}

func TestParserEventKeysSeparateSubagentsAndCounterResetEpochs(t *testing.T) {
	now := time.Unix(1700000000, 0).UTC()
	record := jsonlRecord{
		Offset: 20,
		Data: []byte(
			`{"type":"assistant","uuid":"native-message","message":{"id":"msg-1","model":"claude-x","stop_reason":"end_turn","usage":{"input_tokens":8,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":2}}}`,
		),
	}
	firstSubagent := usageSource(domain.UsageSourceClaudeSubagent)
	firstSubagent.NativeRootID = "claude-root"
	firstSubagent.Source.NativeSessionID = "claude-root"
	firstSubagent.Source.SubagentID = "sub-1"
	secondSubagent := firstSubagent
	secondSubagent.Source.ID = 9
	secondSubagent.Source.SubagentID = "sub-2"
	firstResult := parseRecords(firstSubagent, []jsonlRecord{record}, 300, now)
	secondResult := parseRecords(secondSubagent, []jsonlRecord{record}, 300, now)
	if firstResult.Events[0].SourceEventKey == secondResult.Events[0].SourceEventKey {
		t.Fatalf("distinct subagents shared key %q", firstResult.Events[0].SourceEventKey)
	}

	codex := usageSource(domain.UsageSourceCodexRollout)
	codex.NativeRootID = "codex-root"
	firstEpoch := parseRecords(codex, []jsonlRecord{
		{Data: []byte(`{"type":"turn_context","payload":{"model":"gpt-5.6"}}`)},
		{Data: codexTokenLine("2026-07-28T10:00:00Z", 10, 5, 0, 2, 1)},
	}, 200, now)
	secondEpoch := parseRecords(codex, []jsonlRecord{
		{Data: []byte(`{"type":"turn_context","payload":{"model":"gpt-5.6"}}`)},
		{Data: codexTokenLine("2026-07-28T11:00:00Z", 10, 5, 0, 2, 1)},
	}, 200, now)
	if firstEpoch.Events[0].SourceEventKey == secondEpoch.Events[0].SourceEventKey {
		t.Fatalf("distinct Codex epochs shared key %q", firstEpoch.Events[0].SourceEventKey)
	}
}

func TestParsersTrackProviderModelChanges(t *testing.T) {
	now := time.Unix(1700000000, 0).UTC()
	claude := usageSource(domain.UsageSourceClaudeMain)
	claudeResult := parseRecords(claude, []jsonlRecord{
		{Data: []byte(`{"type":"assistant","uuid":"one","message":{"id":"msg-1","model":"claude-a","stop_reason":"end_turn","usage":{"input_tokens":8,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":2}}}`)},
		{Data: []byte(`{"type":"assistant","uuid":"two","message":{"id":"msg-2","model":"claude-b","stop_reason":"end_turn","usage":{"input_tokens":9,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":3}}}`)},
	}, 500, now)
	if len(claudeResult.Events) != 2 ||
		claudeResult.Events[0].ModelID != "claude-a" ||
		claudeResult.Events[1].ModelID != "claude-b" {
		t.Fatalf("claude events=%+v", claudeResult.Events)
	}

	codex := usageSource(domain.UsageSourceCodexRollout)
	codexResult := parseRecords(codex, []jsonlRecord{
		{Data: []byte(`{"type":"turn_context","payload":{"model":"gpt-a"}}`)},
		{Data: codexTokenLine("2026-07-28T10:00:00Z", 10, 5, 0, 2, 1)},
		{Data: []byte(`{"type":"turn_context","payload":{"model":"gpt-b"}}`)},
		{Data: codexTokenLine("2026-07-28T10:01:00Z", 20, 10, 0, 4, 2)},
	}, 500, now)
	if len(codexResult.Events) != 2 ||
		codexResult.Events[0].ModelID != "gpt-a" ||
		codexResult.Events[1].ModelID != "gpt-b" {
		t.Fatalf("codex events=%+v", codexResult.Events)
	}
}

func TestReadJSONLChunkRetainsPartialTailAndSkipsOversizedRecord(t *testing.T) {
	path := t.TempDir() + "/rollout.jsonl"
	mustNoError(t, osWrite(path, `{"a":1}`+"\n"+`{"b":`))
	first, err := readJSONLChunkAtPath(path, 0, 1024, 32, false)
	mustNoError(t, err)
	if len(first.records) != 1 || first.atEOF || !first.readToEOF ||
		string(first.trailing) != `{"b":` ||
		first.nextOffset != int64(len(`{"a":1}`+"\n")) {
		t.Fatalf("first chunk = %+v", first)
	}
	mustNoError(t, osAppend(path, `2}`+"\n"))
	second, err := readJSONLChunkAtPath(path, first.nextOffset, 1024, 32, false)
	mustNoError(t, err)
	if len(second.records) != 1 || !second.atEOF {
		t.Fatalf("second chunk = %+v", second)
	}

	mustNoError(t, osWrite(path, strings.Repeat("x", 40)+"\n"))
	large, err := readJSONLChunkAtPath(path, 0, 1024, 16, false)
	mustNoError(t, err)
	if large.anomalies != 1 || large.errorCode != domain.UsageErrorRecordTooLarge || large.nextOffset != 41 {
		t.Fatalf("oversized chunk = %+v", large)
	}
}

func TestReadJSONLChunkDoesNotSkipRecordAfterCompleteOversizedLine(t *testing.T) {
	path := t.TempDir() + "/rollout.jsonl"
	oversized := strings.Repeat("x", 40) + "\n"
	valid := `{"valid":true}` + "\n"
	mustNoError(t, osWrite(path, oversized+valid))

	first, err := readJSONLChunkAtPath(path, 0, int64(len(oversized)), 16, false)
	mustNoError(t, err)
	if first.nextOffset != int64(len(oversized)) || first.discardingOversizedRecord {
		t.Fatalf("first chunk = %+v, want a fully consumed oversized record", first)
	}
	second, err := readJSONLChunkAtPath(path, first.nextOffset, 1024, 16, first.discardingOversizedRecord)
	mustNoError(t, err)
	if len(second.records) != 1 || string(second.records[0].Data) != `{"valid":true}` {
		t.Fatalf("second chunk = %+v, want the valid record", second)
	}
}

func TestContextReaderStopsBetweenTranscriptReadChunks(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	reader := &cancelAfterChunkReader{cancel: cancel}

	_, err := io.ReadAll(contextReader{ctx: ctx, reader: reader})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("ReadAll() error = %v, want context canceled", err)
	}
}

type cancelAfterChunkReader struct {
	cancel context.CancelFunc
	read   bool
}

func (r *cancelAfterChunkReader) Read(buffer []byte) (int, error) {
	if r.read {
		return 0, io.EOF
	}
	r.read = true
	buffer[0] = 'x'
	r.cancel()
	return 1, nil
}

func usageSource(kind domain.UsageSourceKind) domain.UsageSourceContext {
	return domain.UsageSourceContext{
		Source: domain.UsageSourceRecord{
			ID:              7,
			Kind:            kind,
			ParserStateJSON: "{}",
			State:           domain.UsageSourceActive,
		},
		InitialModelID: "fallback-model",
	}
}

func parserStateFromResult(t *testing.T, result parseResult, kind domain.UsageSourceKind) *parserStateEnvelope {
	t.Helper()
	if result.err != nil {
		t.Fatalf("parse records: %v", result.err)
	}
	state, err := decodeParserState(domain.UsageSourceRecord{
		Kind:            kind,
		ByteOffset:      result.Cursor.ByteOffset,
		ParserStateJSON: result.Cursor.ParserStateJSON,
	})
	if err != nil {
		t.Fatalf("decode result parser state: %v", err)
	}
	return state
}

func codexTokenLine(timestamp string, input, cached, cacheWrite, output, reasoning int64) []byte {
	return []byte(fmt.Sprintf(
		`{"timestamp":%q,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":%d,"cached_input_tokens":%d,"cache_write_input_tokens":%d,"output_tokens":%d,"reasoning_output_tokens":%d,"total_tokens":%d}}}}`,
		timestamp, input, cached, cacheWrite, output, reasoning, input+output,
	))
}

func codexContextFillLine(timestamp string, modelContextWindow int64) []byte {
	return []byte(fmt.Sprintf(
		`{"timestamp":%q,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":0,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0,"total_tokens":%d},"model_context_window":%d}}}`,
		timestamp, modelContextWindow, modelContextWindow,
	))
}

func osWrite(path, content string) error {
	return os.WriteFile(path, []byte(content), 0o600)
}

func readJSONLChunkAtPath(
	path string,
	offset int64,
	maxBytes int64,
	maxRecord int,
	discardingOversizedRecord bool,
) (jsonlChunk, error) {
	file, err := os.Open(path) //nolint:gosec // test-controlled path.
	if err != nil {
		return jsonlChunk{}, err
	}
	defer func() { _ = file.Close() }()
	return readJSONLChunkFromFile(file, offset, maxBytes, maxRecord, discardingOversizedRecord)
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
