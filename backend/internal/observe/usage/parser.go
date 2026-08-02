package usage

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type jsonlRecord struct {
	Data   []byte
	Offset int64
}

type parseResult struct {
	Events []domain.ModelUsageEvent
	Cursor domain.SourceCursorState
	err    error
}

func parseRecords(source domain.UsageSourceContext, records []jsonlRecord, nextOffset int64, now time.Time) parseResult {
	state, err := decodeParserState(source.Source)
	if err != nil {
		return parseResult{err: fmt.Errorf("decode parser state: %w", err)}
	}
	result := parseResult{Cursor: cursorFromSource(source.Source, nextOffset, now)}
	switch source.Source.Kind {
	case domain.UsageSourceClaudeMain, domain.UsageSourceClaudeSubagent:
		parseClaude(source, records, now, state.Claude, &result)
	case domain.UsageSourceCodexRollout:
		parseCodex(source, records, now, state.Codex, &result)
	default:
		result.Cursor.AnomalyCount++
		result.Cursor.LastErrorCode = domain.UsageErrorUnsupportedSourceFormat
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		result.err = fmt.Errorf("encode parser state: %w", err)
		return result
	}
	result.Cursor.ParserStateJSON = string(encoded)
	return result
}

func cursorFromSource(source domain.UsageSourceRecord, nextOffset int64, now time.Time) domain.SourceCursorState {
	return domain.SourceCursorState{
		ByteOffset:     nextOffset,
		State:          domain.UsageSourceActive,
		FailureCount:   0,
		AnomalyCount:   source.AnomalyCount,
		LastObservedAt: &now,
		UpdatedAt:      now,
	}
}

const parserStateVersion = 1

type codexTokenVector struct {
	InputTokens           int64 `json:"input_tokens"`
	CachedInputTokens     int64 `json:"cached_input_tokens"`
	CacheWriteInputTokens int64 `json:"cache_write_input_tokens"`
	OutputTokens          int64 `json:"output_tokens"`
	ReasoningOutputTokens int64 `json:"reasoning_output_tokens"`
}

type parserStateEnvelope struct {
	Version    int                    `json:"version"`
	SourceKind domain.UsageSourceKind `json:"source_kind"`
	Claude     *claudeParserStateV1   `json:"claude,omitempty"`
	Codex      *codexParserStateV1    `json:"codex,omitempty"`
}

type claudeParserStateV1 struct {
	ModelID  string `json:"model_id,omitempty"`
	Provider string `json:"provider,omitempty"`
}

type codexParserStateV1 struct {
	Baseline            codexTokenVector `json:"baseline"`
	ModelID             string           `json:"model_id,omitempty"`
	Provider            string           `json:"provider,omitempty"`
	PendingSpawnCallIDs []string         `json:"pending_spawn_call_ids"`
	DiscoveredChildIDs  []string         `json:"discovered_child_ids"`
}

func decodeParserState(source domain.UsageSourceRecord) (*parserStateEnvelope, error) {
	raw := strings.TrimSpace(source.ParserStateJSON)
	if raw == "{}" {
		return newParserState(source.Kind)
	}
	if raw == "" || raw[0] != '{' {
		return nil, errors.New("state must be a JSON object")
	}
	var state parserStateEnvelope
	decoder := json.NewDecoder(bytes.NewReader([]byte(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&state); err != nil {
		return nil, err
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return nil, err
	}
	if state.Version != parserStateVersion {
		return nil, fmt.Errorf("unsupported version %d", state.Version)
	}
	if state.SourceKind != source.Kind {
		return nil, fmt.Errorf("source kind %q does not match %q", state.SourceKind, source.Kind)
	}
	switch source.Kind {
	case domain.UsageSourceClaudeMain, domain.UsageSourceClaudeSubagent:
		if state.Claude == nil || state.Codex != nil {
			return nil, errors.New("claude state has invalid provider payload")
		}
	case domain.UsageSourceCodexRollout:
		if state.Codex == nil || state.Claude != nil {
			return nil, errors.New("codex state has invalid provider payload")
		}
		if state.Codex.PendingSpawnCallIDs == nil {
			state.Codex.PendingSpawnCallIDs = []string{}
		}
		if state.Codex.DiscoveredChildIDs == nil {
			state.Codex.DiscoveredChildIDs = []string{}
		}
	default:
		return nil, fmt.Errorf("unsupported source kind %q", source.Kind)
	}
	return &state, nil
}

func newParserState(kind domain.UsageSourceKind) (*parserStateEnvelope, error) {
	state := &parserStateEnvelope{Version: parserStateVersion, SourceKind: kind}
	switch kind {
	case domain.UsageSourceClaudeMain, domain.UsageSourceClaudeSubagent:
		state.Claude = &claudeParserStateV1{}
	case domain.UsageSourceCodexRollout:
		state.Codex = &codexParserStateV1{
			PendingSpawnCallIDs: []string{},
			DiscoveredChildIDs:  []string{},
		}
	default:
		return nil, fmt.Errorf("unsupported source kind %q", kind)
	}
	return state, nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return errors.New("multiple JSON values")
	}
	return err
}

type claudeTranscriptRecord struct {
	Type        string `json:"type"`
	UUID        string `json:"uuid"`
	IsSidechain bool   `json:"isSidechain"`
	Timestamp   string `json:"timestamp"`
	Message     struct {
		ID         string  `json:"id"`
		Model      string  `json:"model"`
		StopReason *string `json:"stop_reason"`
		Usage      *struct {
			InputTokens              int64 `json:"input_tokens"`
			CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
			CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
			OutputTokens             int64 `json:"output_tokens"`
		} `json:"usage"`
	} `json:"message"`
}

func parseClaude(source domain.UsageSourceContext, records []jsonlRecord, now time.Time, state *claudeParserStateV1, result *parseResult) {
	for _, record := range records {
		var native claudeTranscriptRecord
		if err := json.Unmarshal(record.Data, &native); err != nil {
			recordMalformed(result)
			continue
		}
		if native.Type != "assistant" || native.Message.Usage == nil || native.Message.StopReason == nil || strings.TrimSpace(*native.Message.StopReason) == "" {
			continue
		}
		if source.Source.Kind == domain.UsageSourceClaudeMain && native.IsSidechain {
			continue
		}
		usage := native.Message.Usage
		input, ok := sumNonNegative(
			usage.InputTokens,
			usage.CacheCreationInputTokens,
			usage.CacheReadInputTokens,
		)
		if !ok || usage.OutputTokens < 0 {
			recordMalformed(result)
			continue
		}
		tokens := domain.UsageTokenMetrics{
			InputTokens:         input,
			UncachedInputTokens: usage.InputTokens,
			CacheReadTokens:     usage.CacheReadInputTokens,
			CacheWriteTokens:    usage.CacheCreationInputTokens,
			OutputTokens:        usage.OutputTokens,
		}
		if !validTokenMetrics(tokens) {
			recordMalformed(result)
			continue
		}
		model := firstNonEmpty(native.Message.Model, state.ModelID, source.InitialModelID, "unknown")
		state.ModelID = model
		state.Provider = firstNonEmpty(state.Provider, "claude-code")
		observedAt := parseTimestamp(native.Timestamp, now)
		keyID := firstNonEmpty(native.Message.ID, native.UUID, strconv.FormatInt(record.Offset, 10))
		event := domain.ModelUsageEvent{
			Provider:   state.Provider,
			ModelID:    model,
			ObservedAt: observedAt,
			Tokens:     tokens,
			SourceEventKey: stableSourceEventKey(
				"claude",
				source.NativeRootID,
				string(source.Source.Kind),
				source.Source.NativeSessionID,
				source.Source.SubagentID,
				keyID,
			),
			CreatedAt: now,
		}
		result.Events = append(result.Events, event)
	}
}

type codexEnvelope struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

func parseCodex(source domain.UsageSourceContext, records []jsonlRecord, now time.Time, state *codexParserStateV1, result *parseResult) {
	for _, record := range records {
		var envelope codexEnvelope
		if err := json.Unmarshal(record.Data, &envelope); err != nil {
			recordMalformed(result)
			continue
		}
		switch envelope.Type {
		case "session_meta":
			var payload struct {
				ModelProvider string `json:"model_provider"`
			}
			if json.Unmarshal(envelope.Payload, &payload) == nil {
				state.Provider = firstNonEmpty(payload.ModelProvider, state.Provider)
			}
		case "turn_context":
			var payload struct {
				Model string `json:"model"`
			}
			if json.Unmarshal(envelope.Payload, &payload) == nil {
				state.ModelID = firstNonEmpty(payload.Model, state.ModelID)
			}
		case "event_msg":
			parseCodexEvent(source, envelope, now, state, result)
		}
	}
}

func parseCodexEvent(source domain.UsageSourceContext, envelope codexEnvelope, now time.Time, state *codexParserStateV1, result *parseResult) {
	var payload struct {
		Type string `json:"type"`
		Info *struct {
			Total codexTokenVector `json:"total_token_usage"`
		} `json:"info"`
	}
	if err := json.Unmarshal(envelope.Payload, &payload); err != nil || payload.Type != "token_count" || payload.Info == nil {
		return
	}
	total := payload.Info.Total
	if !validCodexTotal(total) {
		recordMalformed(result)
		return
	}
	if total.InputTokens < state.Baseline.InputTokens ||
		total.CachedInputTokens < state.Baseline.CachedInputTokens ||
		total.CacheWriteInputTokens < state.Baseline.CacheWriteInputTokens ||
		total.OutputTokens < state.Baseline.OutputTokens ||
		total.ReasoningOutputTokens < state.Baseline.ReasoningOutputTokens {
		result.Cursor.AnomalyCount++
		result.Cursor.LastErrorCode = domain.UsageErrorNonMonotonicCumulativeUsage
		state.Baseline = total
		return
	}
	input := total.InputTokens - state.Baseline.InputTokens
	cached := total.CachedInputTokens - state.Baseline.CachedInputTokens
	cacheWrite := total.CacheWriteInputTokens - state.Baseline.CacheWriteInputTokens
	output := total.OutputTokens - state.Baseline.OutputTokens
	reasoning := total.ReasoningOutputTokens - state.Baseline.ReasoningOutputTokens
	state.Baseline = total
	if input == 0 && output == 0 && cacheWrite == 0 {
		return
	}
	uncached := input - cached - cacheWrite
	if uncached < 0 {
		uncached = 0
		result.Cursor.AnomalyCount++
		result.Cursor.LastErrorCode = domain.UsageErrorNonMonotonicCumulativeUsage
	}
	model := firstNonEmpty(state.ModelID, source.InitialModelID, "unknown")
	provider := firstNonEmpty(state.Provider, "openai")
	state.ModelID = model
	state.Provider = provider
	observedAt := parseTimestamp(envelope.Timestamp, now)
	tokens := domain.UsageTokenMetrics{
		InputTokens:         input,
		UncachedInputTokens: uncached,
		CacheReadTokens:     cached,
		CacheWriteTokens:    cacheWrite,
		OutputTokens:        output,
		ReasoningTokens:     int64Ptr(reasoning),
	}
	if !validTokenMetrics(tokens) {
		result.Cursor.AnomalyCount++
		result.Cursor.LastErrorCode = domain.UsageErrorNonMonotonicCumulativeUsage
		return
	}
	event := domain.ModelUsageEvent{
		Provider:   provider,
		ModelID:    model,
		ObservedAt: observedAt,
		Tokens:     tokens,
		SourceEventKey: stableSourceEventKey(
			"codex",
			source.NativeRootID,
			source.Source.NativeSessionID,
			envelope.Timestamp,
			strconv.FormatInt(total.InputTokens, 10),
			strconv.FormatInt(total.CachedInputTokens, 10),
			strconv.FormatInt(total.CacheWriteInputTokens, 10),
			strconv.FormatInt(total.OutputTokens, 10),
			strconv.FormatInt(total.ReasoningOutputTokens, 10),
		),
		CreatedAt: now,
	}
	result.Events = append(result.Events, event)
}

func recordMalformed(result *parseResult) {
	result.Cursor.AnomalyCount++
	result.Cursor.LastErrorCode = domain.UsageErrorMalformedJSONL
}

func validCodexTotal(total codexTokenVector) bool {
	if total.InputTokens < 0 || total.CachedInputTokens < 0 || total.CacheWriteInputTokens < 0 ||
		total.OutputTokens < 0 || total.ReasoningOutputTokens < 0 {
		return false
	}
	if total.CachedInputTokens > total.InputTokens ||
		total.CacheWriteInputTokens > total.InputTokens-total.CachedInputTokens {
		return false
	}
	return total.ReasoningOutputTokens <= total.OutputTokens
}

func validTokenMetrics(tokens domain.UsageTokenMetrics) bool {
	if tokens.InputTokens < 0 || tokens.UncachedInputTokens < 0 ||
		tokens.CacheReadTokens < 0 || tokens.CacheWriteTokens < 0 ||
		tokens.OutputTokens < 0 {
		return false
	}
	if tokens.UncachedInputTokens > tokens.InputTokens ||
		tokens.CacheReadTokens > tokens.InputTokens ||
		tokens.CacheWriteTokens > tokens.InputTokens {
		return false
	}
	if tokens.CacheReadTokens > tokens.InputTokens-tokens.UncachedInputTokens ||
		tokens.CacheWriteTokens > tokens.InputTokens-tokens.UncachedInputTokens-tokens.CacheReadTokens {
		return false
	}
	return tokens.ReasoningTokens == nil ||
		(*tokens.ReasoningTokens >= 0 && *tokens.ReasoningTokens <= tokens.OutputTokens)
}

func sumNonNegative(values ...int64) (int64, bool) {
	const maxInt64 = int64(1<<63 - 1)
	var total int64
	for _, value := range values {
		if value < 0 || value > maxInt64-total {
			return 0, false
		}
		total += value
	}
	return total, true
}

func stableSourceEventKey(prefix string, parts ...string) string {
	hash := sha256.New()
	for _, part := range parts {
		_, _ = fmt.Fprintf(hash, "%d:", len(part))
		_, _ = hash.Write([]byte(part))
	}
	return fmt.Sprintf("%s:sha256:%x", prefix, hash.Sum(nil))
}

func parseTimestamp(value string, fallback time.Time) time.Time {
	if parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value)); err == nil {
		return parsed.UTC()
	}
	return fallback
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" && len(value) <= 256 {
			return value
		}
	}
	return ""
}

func int64Ptr(value int64) *int64 {
	return &value
}
