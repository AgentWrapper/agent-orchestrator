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

// TokenConfidence records how token facts were obtained.
type TokenConfidence string

// TokenConfidence values describe normalized token metric provenance.
const (
	TokenConfidenceProvider TokenConfidence = "provider_reported"
	TokenConfidenceParsed   TokenConfidence = "parsed_jsonl" //nolint:gosec // provenance enum label, not a credential value.
	TokenConfidenceNone     TokenConfidence = "unavailable"
)

// CostConfidence records how money facts were obtained.
type CostConfidence string

// CostConfidence values describe normalized cost metric provenance.
const (
	CostConfidenceProvider CostConfidence = "provider_reported"
	CostConfidenceEstimate CostConfidence = "api_pricing_estimate"
	CostConfidenceNone     CostConfidence = "unavailable"
)

// CostBasis records the event-level pricing basis.
type CostBasis string

// CostBasis values describe the pricing basis for one usage event.
const (
	CostBasisProviderReported CostBasis = "provider_reported"
	CostBasisAPIEstimate      CostBasis = "api_pricing_estimate"
	CostBasisUnavailable      CostBasis = "unavailable"
)

// Usage error code constants are safe storage/display identifiers for observer
// and ingestion failures.
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
	UsageErrorUnknownModelPricing         = "unknown_model_pricing"
	UsageErrorPartialReasoningCoverage    = "partial_reasoning_coverage"
)

// Usage ingestion sentinel errors report replay and cursor conflicts.
var (
	ErrUsageSourceOffsetConflict = errors.New("usage source cursor offset conflict")
	ErrUsageSourceEventConflict  = errors.New("usage source event conflict")
)

// UsageBindingRecord binds one AO session to one native root session/thread.
type UsageBindingRecord struct {
	ID               int64
	SessionID        SessionID
	Harness          AgentHarness
	NativeRootID     string
	InitialModelID   string
	SourceCLIVersion string
	State            UsageBindingState
	LastErrorCode    string
	FirstSeenAt      time.Time
	LastSeenAt       time.Time
	UpdatedAt        time.Time
}

// UsageSourceRecord tracks one physical JSONL artifact generation and its
// durable read cursor.
type UsageSourceRecord struct {
	ID                        int64
	BindingID                 int64
	Kind                      UsageSourceKind
	NativeSessionID           string
	SubagentID                string
	ArtifactPath              string
	FileIdentity              string
	Generation                int64
	ByteOffset                int64
	BaselineInputTokens       int64
	BaselineCachedInputTokens int64
	BaselineCacheWriteTokens  int64
	BaselineOutputTokens      int64
	BaselineReasoningTokens   int64
	ParserVersion             string
	State                     UsageSourceState
	FailureCount              int64
	AnomalyCount              int64
	NextRetryAt               *time.Time
	LastErrorCode             string
	LastObservedAt            *time.Time
	CreatedAt                 time.Time
	UpdatedAt                 time.Time
}

// UsageSourceContext is the source row plus immutable binding/session facts the
// observer needs while normalizing parser output.
type UsageSourceContext struct {
	Source           UsageSourceRecord
	SessionID        SessionID
	ProjectID        ProjectID
	Harness          AgentHarness
	NativeRootID     string
	SourceCLIVersion string
}

// UsageTokenMetrics is the normalized token vector stored on every usage event
// and returned in aggregate summaries.
type UsageTokenMetrics struct {
	InputTokens         int64
	UncachedInputTokens int64
	CacheReadTokens     int64
	CacheWriteTokens    int64
	CacheWrite5mTokens  *int64
	CacheWrite1hTokens  *int64
	OutputTokens        int64
	ReasoningTokens     *int64
}

// UsageCostMetrics is the normalized money vector for one event or aggregate.
// Values are nano-USD. Nil means unavailable, not zero.
type UsageCostMetrics struct {
	ReportedCostNanos  *int64
	EstimatedCostNanos *int64
	PricingVersion     string
	CostBasis          CostBasis
	Confidence         CostConfidence
}

// ModelUsageEvent is one append-only normalized usage fact.
type ModelUsageEvent struct {
	ID               int64
	BindingID        int64
	UsageSourceID    int64
	ProjectID        ProjectID
	SessionID        SessionID
	Harness          AgentHarness
	Provider         string
	ModelID          string
	ObservedAt       time.Time
	Tokens           UsageTokenMetrics
	DurationMS       *int64
	Cost             UsageCostMetrics
	TokenConfidence  TokenConfidence
	SourceEventKey   string
	SourceUsageHash  string
	ParserVersion    string
	SourceCLIVersion string
	CreatedAt        time.Time
}

// UsageMetricCoverage summarizes whether a metric is available over an
// aggregate scope.
type UsageMetricCoverage struct {
	Value    *int64
	Coverage UsageCoverage
}

// UsageCostCoverage summarizes estimated or provider-reported cost over an
// aggregate scope. Value is nano-USD.
type UsageCostCoverage struct {
	Value          *int64
	Coverage       UsageCoverage
	Confidence     CostConfidence
	PricingVersion string
}

// UsageModelAggregate is the raw model-level aggregate read from storage before
// the service applies user-facing coverage rules.
type UsageModelAggregate struct {
	Harness                 AgentHarness
	Provider                string
	ModelID                 string
	Tokens                  UsageTokenMetrics
	EventCount              int64
	ReasoningEventCount     int64
	EstimatedCostEventCount int64
	EstimatedCostNanos      int64
	LastObservedAt          *time.Time
}

// UsageCoverageCounts contains event counts needed to derive coverage for a
// session-level aggregate.
type UsageCoverageCounts struct {
	EventCount              int64
	ReasoningEventCount     int64
	EstimatedCostEventCount int64
}

// UsageRowCounts is a cheap storage-level count for binding/source/event rows.
type UsageRowCounts struct {
	BindingCount int64
	SourceCount  int64
	EventCount   int64
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
	EstimatedCostNanos  UsageCostCoverage
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
	ByteOffset                int64
	State                     UsageSourceState
	BaselineInputTokens       int64
	BaselineCachedInputTokens int64
	BaselineCacheWriteTokens  int64
	BaselineOutputTokens      int64
	BaselineReasoningTokens   int64
	FailureCount              int64
	AnomalyCount              int64
	NextRetryAt               *time.Time
	LastErrorCode             string
	LastObservedAt            *time.Time
	UpdatedAt                 time.Time
}

// ApplyUsageChunkResult reports what a transactional source apply did.
type ApplyUsageChunkResult struct {
	InsertedEvents  int
	DuplicateEvents int
}
