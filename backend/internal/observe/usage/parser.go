package usage

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
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
}

func parseRecords(source domain.UsageSourceContext, records []jsonlRecord, nextOffset int64, now time.Time) parseResult {
	result := parseResult{Cursor: cursorFromSource(source.Source, nextOffset, now)}
	switch source.Source.Kind {
	case domain.UsageSourceClaudeMain, domain.UsageSourceClaudeSubagent:
		parseClaude(source, records, now, &result)
	case domain.UsageSourceCodexRollout:
		parseCodex(source, records, now, &result)
	default:
		result.Cursor.AnomalyCount++
		result.Cursor.LastErrorCode = domain.UsageErrorUnsupportedSourceFormat
	}
	return result
}

func cursorFromSource(source domain.UsageSourceRecord, nextOffset int64, now time.Time) domain.SourceCursorState {
	return domain.SourceCursorState{
		ByteOffset:                nextOffset,
		State:                     domain.UsageSourceActive,
		BaselineInputTokens:       source.BaselineInputTokens,
		BaselineCachedInputTokens: source.BaselineCachedInputTokens,
		BaselineCacheWriteTokens:  source.BaselineCacheWriteTokens,
		BaselineOutputTokens:      source.BaselineOutputTokens,
		BaselineReasoningTokens:   source.BaselineReasoningTokens,
		CurrentModelID:            source.CurrentModelID,
		CurrentProvider:           source.CurrentProvider,
		FailureCount:              0,
		AnomalyCount:              source.AnomalyCount,
		LastObservedAt:            &now,
		UpdatedAt:                 now,
	}
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
			CacheCreation            *struct {
				Ephemeral5mInputTokens int64 `json:"ephemeral_5m_input_tokens"`
				Ephemeral1hInputTokens int64 `json:"ephemeral_1h_input_tokens"`
			} `json:"cache_creation"`
		} `json:"usage"`
	} `json:"message"`
}

func parseClaude(source domain.UsageSourceContext, records []jsonlRecord, now time.Time, result *parseResult) {
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
		var cache5m, cache1h *int64
		if usage.CacheCreation != nil {
			cache5m = int64Ptr(usage.CacheCreation.Ephemeral5mInputTokens)
			cache1h = int64Ptr(usage.CacheCreation.Ephemeral1hInputTokens)
		}
		tokens := domain.UsageTokenMetrics{
			InputTokens:         input,
			UncachedInputTokens: usage.InputTokens,
			CacheReadTokens:     usage.CacheReadInputTokens,
			CacheWriteTokens:    usage.CacheCreationInputTokens,
			CacheWrite5mTokens:  cache5m,
			CacheWrite1hTokens:  cache1h,
			OutputTokens:        usage.OutputTokens,
		}
		if !validTokenMetrics(tokens) {
			recordMalformed(result)
			continue
		}
		model := firstNonEmpty(native.Message.Model, result.Cursor.CurrentModelID, source.InitialModelID, "unknown")
		result.Cursor.CurrentModelID = model
		result.Cursor.CurrentProvider = firstNonEmpty(result.Cursor.CurrentProvider, "claude-code")
		observedAt := parseTimestamp(native.Timestamp, now)
		keyID := firstNonEmpty(native.Message.ID, native.UUID, strconv.FormatInt(record.Offset, 10))
		event := domain.ModelUsageEvent{
			Provider:   result.Cursor.CurrentProvider,
			ModelID:    model,
			ObservedAt: observedAt,
			Tokens:     tokens,
			Cost: domain.UsageCostMetrics{
				CostBasis:  domain.CostBasisUnavailable,
				Confidence: domain.CostConfidenceNone,
			},
			TokenConfidence: domain.TokenConfidenceParsed,
			SourceEventKey: stableSourceEventKey(
				"claude",
				source.NativeRootID,
				string(source.Source.Kind),
				source.Source.NativeSessionID,
				source.Source.SubagentID,
				keyID,
			),
			ParserVersion: source.Source.ParserVersion,
			CreatedAt:     now,
		}
		event.SourceUsageHash = usageHash(event)
		result.Events = append(result.Events, event)
	}
}

type codexEnvelope struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

type codexTokenVector struct {
	InputTokens           int64 `json:"input_tokens"`
	CachedInputTokens     int64 `json:"cached_input_tokens"`
	CacheWriteInputTokens int64 `json:"cache_write_input_tokens"`
	OutputTokens          int64 `json:"output_tokens"`
	ReasoningOutputTokens int64 `json:"reasoning_output_tokens"`
}

func parseCodex(source domain.UsageSourceContext, records []jsonlRecord, now time.Time, result *parseResult) {
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
				result.Cursor.CurrentProvider = firstNonEmpty(payload.ModelProvider, result.Cursor.CurrentProvider)
			}
		case "turn_context":
			var payload struct {
				Model string `json:"model"`
			}
			if json.Unmarshal(envelope.Payload, &payload) == nil {
				result.Cursor.CurrentModelID = firstNonEmpty(payload.Model, result.Cursor.CurrentModelID)
			}
		case "event_msg":
			parseCodexEvent(source, envelope, now, result)
		}
	}
}

func parseCodexEvent(source domain.UsageSourceContext, envelope codexEnvelope, now time.Time, result *parseResult) {
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
	if total.InputTokens < result.Cursor.BaselineInputTokens ||
		total.CachedInputTokens < result.Cursor.BaselineCachedInputTokens ||
		total.CacheWriteInputTokens < result.Cursor.BaselineCacheWriteTokens ||
		total.OutputTokens < result.Cursor.BaselineOutputTokens ||
		total.ReasoningOutputTokens < result.Cursor.BaselineReasoningTokens {
		result.Cursor.AnomalyCount++
		result.Cursor.LastErrorCode = domain.UsageErrorNonMonotonicCumulativeUsage
		setCodexBaseline(&result.Cursor, total)
		return
	}
	input := total.InputTokens - result.Cursor.BaselineInputTokens
	cached := total.CachedInputTokens - result.Cursor.BaselineCachedInputTokens
	cacheWrite := total.CacheWriteInputTokens - result.Cursor.BaselineCacheWriteTokens
	output := total.OutputTokens - result.Cursor.BaselineOutputTokens
	reasoning := total.ReasoningOutputTokens - result.Cursor.BaselineReasoningTokens
	setCodexBaseline(&result.Cursor, total)
	if input == 0 && output == 0 && cacheWrite == 0 {
		return
	}
	uncached := input - cached - cacheWrite
	if uncached < 0 {
		uncached = 0
		result.Cursor.AnomalyCount++
		result.Cursor.LastErrorCode = domain.UsageErrorNonMonotonicCumulativeUsage
	}
	model := firstNonEmpty(result.Cursor.CurrentModelID, source.InitialModelID, "unknown")
	provider := firstNonEmpty(result.Cursor.CurrentProvider, "openai")
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
		Cost: domain.UsageCostMetrics{
			CostBasis:  domain.CostBasisUnavailable,
			Confidence: domain.CostConfidenceNone,
		},
		TokenConfidence: domain.TokenConfidenceParsed,
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
		ParserVersion: source.Source.ParserVersion,
		CreatedAt:     now,
	}
	event.SourceUsageHash = usageHash(event)
	result.Events = append(result.Events, event)
}

func setCodexBaseline(cursor *domain.SourceCursorState, total codexTokenVector) {
	cursor.BaselineInputTokens = total.InputTokens
	cursor.BaselineCachedInputTokens = total.CachedInputTokens
	cursor.BaselineCacheWriteTokens = total.CacheWriteInputTokens
	cursor.BaselineOutputTokens = total.OutputTokens
	cursor.BaselineReasoningTokens = total.ReasoningOutputTokens
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
	if tokens.CacheWrite5mTokens != nil &&
		(*tokens.CacheWrite5mTokens < 0 || *tokens.CacheWrite5mTokens > tokens.CacheWriteTokens) {
		return false
	}
	if tokens.CacheWrite1hTokens != nil &&
		(*tokens.CacheWrite1hTokens < 0 || *tokens.CacheWrite1hTokens > tokens.CacheWriteTokens) {
		return false
	}
	if tokens.CacheWrite5mTokens != nil && tokens.CacheWrite1hTokens != nil &&
		*tokens.CacheWrite5mTokens > tokens.CacheWriteTokens-*tokens.CacheWrite1hTokens {
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

func usageHash(event domain.ModelUsageEvent) string {
	data, _ := json.Marshal(struct {
		Provider string
		Model    string
		Input    int64
		Uncached int64
		Read     int64
		Write    int64
		Output   int64
		Reason   *int64
	}{
		event.Provider,
		event.ModelID,
		event.Tokens.InputTokens,
		event.Tokens.UncachedInputTokens,
		event.Tokens.CacheReadTokens,
		event.Tokens.CacheWriteTokens,
		event.Tokens.OutputTokens,
		event.Tokens.ReasoningTokens,
	})
	return fmt.Sprintf("sha256:%x", sha256.Sum256(data))
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
