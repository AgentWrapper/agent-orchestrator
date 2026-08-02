package domain

import (
	"errors"
	"time"
)

// UsageSourceKind identifies the native artifact shape that produced usage
// facts. It is deliberately narrower than AgentHarness: only certified usage
// sources get persisted in the V1 usage pipeline.
type UsageSourceKind string

// UsageSourceKind values identify certified native usage artifact shapes.
const (
	UsageSourceClaudeMain     UsageSourceKind = "claude_main"
	UsageSourceClaudeSubagent UsageSourceKind = "claude_subagent"
	UsageSourceCodexRollout   UsageSourceKind = "codex_rollout"
)

// UsageBindingState tracks the root native-session binding lifecycle.
type UsageBindingState string

// UsageBindingState values describe root native-session binding lifecycle.
const (
	UsageBindingDiscovering UsageBindingState = "discovering"
	UsageBindingActive      UsageBindingState = "active"
	UsageBindingFinalizing  UsageBindingState = "finalizing"
	UsageBindingComplete    UsageBindingState = "complete"
	UsageBindingPartial     UsageBindingState = "partial"
)

// UsageSourceState tracks one physical JSONL artifact generation.
type UsageSourceState string

// UsageSourceState values describe one physical source artifact lifecycle.
const (
	UsageSourcePending  UsageSourceState = "pending"
	UsageSourceActive   UsageSourceState = "active"
	UsageSourceComplete UsageSourceState = "complete"
	UsageSourceError    UsageSourceState = "error"
)

// UsageCollectionState is the user-facing summary state for a session's usage
// collection pipeline. It is independent from per-metric coverage.
type UsageCollectionState string

// UsageCollectionState values summarize session-level usage collection.
const (
	UsageCollectionWaiting     UsageCollectionState = "waiting"
	UsageCollectionCollecting  UsageCollectionState = "collecting"
	UsageCollectionComplete    UsageCollectionState = "complete"
	UsageCollectionPartial     UsageCollectionState = "partial"
	UsageCollectionUnavailable UsageCollectionState = "unavailable"
)

// UsageCoverage reports whether a metric represents the full known scope.
type UsageCoverage string

// UsageCoverage values describe metric completeness over a scope.
const (
	UsageCoverageComplete    UsageCoverage = "complete"
	UsageCoveragePartial     UsageCoverage = "partial"
	UsageCoverageUnavailable UsageCoverage = "unavailable"
)

// Usage error code constants are safe storage/display identifiers for
// transcript discovery and ingestion failures.
const (
	UsageErrorSourceDiscoveryPending      = "source_discovery_pending"
	UsageErrorArtifactPathRejected        = "artifact_path_rejected"
	UsageErrorArtifactMissing             = "artifact_missing"
	UsageErrorArtifactReplaced            = "artifact_replaced"
	UsageErrorSourceReadFailed            = "source_read_failed"
	UsageErrorRecordTooLarge              = "record_too_large"
	UsageErrorMalformedJSONL              = "malformed_jsonl"
	UsageErrorUnsupportedSourceFormat     = "unsupported_source_format"
	UsageErrorSourceEventConflict         = "source_event_conflict"
	UsageErrorNonMonotonicCumulativeUsage = "non_monotonic_cumulative_usage"
	UsageErrorInvalidParserState          = "invalid_parser_state"
	UsageErrorUnresolvedSpawnCall         = "unresolved_spawn_call"
	UsageErrorCodexSourceBudgetExceeded   = "codex_source_budget_exceeded"
	UsageErrorPartialReasoningCoverage    = "partial_reasoning_coverage"
)

// Usage ingestion sentinel errors report replay and cursor conflicts.
var (
	ErrUsageSourceOffsetConflict = errors.New("usage source cursor offset conflict")
	ErrUsageSourceEventConflict  = errors.New("usage source event conflict")
)

// UsageBindingRecord binds one AO session to one native root session/thread.
type UsageBindingRecord struct {
	ID             int64
	SessionID      SessionID
	Harness        AgentHarness
	NativeRootID   string
	InitialModelID string
	State          UsageBindingState
	LastErrorCode  string
	FirstSeenAt    time.Time
	LastSeenAt     time.Time
	UpdatedAt      time.Time
}

// UsageSourceRecord tracks one physical JSONL artifact generation and its
// durable read cursor.
type UsageSourceRecord struct {
	ID              int64
	BindingID       int64
	Kind            UsageSourceKind
	NativeSessionID string
	SubagentID      string
	ArtifactPath    string
	FileIdentity    string
	Generation      int64
	ByteOffset      int64
	ParserStateJSON string
	State           UsageSourceState
	FailureCount    int64
	AnomalyCount    int64
	NextRetryAt     *time.Time
	LastErrorCode   string
	LastObservedAt  *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// UsageSourceContext is the source row plus immutable binding/session facts the
// ingestor needs while normalizing parser output.
type UsageSourceContext struct {
	Source         UsageSourceRecord
	SessionID      SessionID
	ProjectID      ProjectID
	Harness        AgentHarness
	NativeRootID   string
	InitialModelID string
	BindingState   UsageBindingState
}

// UsageTokenMetrics is the normalized token vector stored on every usage event
// and returned in aggregate summaries.
type UsageTokenMetrics struct {
	InputTokens         int64
	UncachedInputTokens int64
	CacheReadTokens     int64
	CacheWriteTokens    int64
	OutputTokens        int64
	ReasoningTokens     *int64
}

// ModelUsageEvent is one append-only normalized usage fact.
type ModelUsageEvent struct {
	ID             int64
	BindingID      int64
	UsageSourceID  int64
	ProjectID      ProjectID
	SessionID      SessionID
	Harness        AgentHarness
	Provider       string
	ModelID        string
	ObservedAt     time.Time
	Tokens         UsageTokenMetrics
	SourceEventKey string
	CreatedAt      time.Time
}

// UsageMetricCoverage summarizes whether a metric is available over an
// aggregate scope.
type UsageMetricCoverage struct {
	Value    *int64
	Coverage UsageCoverage
}

// UsageModelAggregate is the raw model-level aggregate read from storage before
// the service applies user-facing coverage rules.
type UsageModelAggregate struct {
	Harness             AgentHarness
	Provider            string
	ModelID             string
	Tokens              UsageTokenMetrics
	EventCount          int64
	ReasoningEventCount int64
	LastObservedAt      *time.Time
}

// UsageSessionAggregate is the storage-level batch row used to derive compact
// dashboard usage without issuing one query per session card.
type UsageSessionAggregate struct {
	SessionID            SessionID
	Harness              AgentHarness
	BindingCount         int64
	CompleteBindingCount int64
	PartialBindingCount  int64
	SourceCount          int64
	CompleteSourceCount  int64
	ErrorSourceCount     int64
	AnomalousSourceCount int64
	EventCount           int64
	TotalTokens          int64
	LastObservedAt       *time.Time
}

// CompactSessionUsage is the token-only dashboard read model.
type CompactSessionUsage struct {
	SessionID       SessionID
	TotalTokens     int64
	CollectionState UsageCollectionState
	Coverage        UsageCoverage
	LastObservedAt  *time.Time
}

// UsageMetricTotals is the aggregate metric block used by session, harness,
// and model summaries.
type UsageMetricTotals struct {
	InputTokens         UsageMetricCoverage
	UncachedInputTokens UsageMetricCoverage
	CacheReadTokens     UsageMetricCoverage
	CacheWriteTokens    UsageMetricCoverage
	OutputTokens        UsageMetricCoverage
	ReasoningTokens     UsageMetricCoverage
}

// UsageCollectionSummary is the collection-state header for session usage.
type UsageCollectionSummary struct {
	State          UsageCollectionState
	LastObservedAt *time.Time
	Warnings       []string
}

// ModelUsageSummary is a per-exact-model aggregate.
type ModelUsageSummary struct {
	ModelID  string
	Provider string
	Totals   UsageMetricTotals
}

// HarnessUsageSummary groups model summaries by harness and provider.
type HarnessUsageSummary struct {
	Harness  AgentHarness
	Provider string
	Totals   UsageMetricTotals
	Models   []ModelUsageSummary
}

// SessionUsageSummary is the read model returned by the session usage service.
type SessionUsageSummary struct {
	SessionID  SessionID
	Collection UsageCollectionSummary
	Totals     UsageMetricTotals
	Harnesses  []HarnessUsageSummary
}

// SourceCursorState is the durable source state to commit after parsing a
// chunk. ApplyUsageChunk writes it atomically with the emitted events.
type SourceCursorState struct {
	ByteOffset      int64
	State           UsageSourceState
	ParserStateJSON string
	FailureCount    int64
	AnomalyCount    int64
	NextRetryAt     *time.Time
	LastErrorCode   string
	LastObservedAt  *time.Time
	UpdatedAt       time.Time
}

// ApplyUsageChunkResult reports what a transactional source apply did.
type ApplyUsageChunkResult struct {
	InsertedEvents  int
	DuplicateEvents int
}
