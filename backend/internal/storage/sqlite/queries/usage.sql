-- name: UpsertUsageBinding :one
INSERT INTO usage_bindings (
    session_id, harness, native_root_id, initial_model_id, source_cli_version,
    state, last_error_code, first_seen_at, last_seen_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (session_id, harness, native_root_id) DO UPDATE SET
    initial_model_id = CASE
        WHEN excluded.initial_model_id <> '' THEN excluded.initial_model_id
        ELSE usage_bindings.initial_model_id
    END,
    source_cli_version = CASE
        WHEN excluded.source_cli_version <> '' THEN excluded.source_cli_version
        ELSE usage_bindings.source_cli_version
    END,
    state = excluded.state,
    last_error_code = excluded.last_error_code,
    last_seen_at = excluded.last_seen_at,
    updated_at = excluded.updated_at
RETURNING *;

-- name: GetUsageBindingBySessionHarnessRoot :one
SELECT *
FROM usage_bindings
WHERE session_id = ? AND harness = ? AND native_root_id = ?;

-- name: ListUsageBindingsForSession :many
SELECT *
FROM usage_bindings
WHERE session_id = ?
ORDER BY first_seen_at, id;

-- name: InsertUsageSource :one
INSERT INTO usage_sources (
    binding_id, kind, native_session_id, subagent_id, artifact_path,
    file_identity, generation, byte_offset, baseline_input_tokens,
    baseline_cached_input_tokens, baseline_cache_write_tokens,
    baseline_output_tokens, baseline_reasoning_tokens, parser_version,
    state, failure_count, anomaly_count, next_retry_at, last_error_code,
    last_observed_at, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (binding_id, artifact_path, generation) DO UPDATE SET
    native_session_id = CASE
        WHEN excluded.native_session_id <> '' THEN excluded.native_session_id
        ELSE usage_sources.native_session_id
    END,
    subagent_id = CASE
        WHEN excluded.subagent_id <> '' THEN excluded.subagent_id
        ELSE usage_sources.subagent_id
    END,
    file_identity = CASE
        WHEN excluded.file_identity <> '' THEN excluded.file_identity
        ELSE usage_sources.file_identity
    END,
    parser_version = excluded.parser_version,
    updated_at = excluded.updated_at
RETURNING *;

-- name: ListObserverReadyUsageSources :many
SELECT *
FROM usage_sources
WHERE state IN ('pending', 'active', 'error')
  AND (next_retry_at IS NULL OR next_retry_at <= ?)
ORDER BY updated_at, id
LIMIT ?;

-- name: ListUnresolvedCodexBindings :many
SELECT *
FROM usage_bindings
WHERE harness = 'codex'
  AND state IN ('discovering', 'active')
  AND NOT EXISTS (
      SELECT 1
      FROM usage_sources
      WHERE usage_sources.binding_id = usage_bindings.id
        AND usage_sources.kind = 'codex_rollout'
  )
ORDER BY first_seen_at, id
LIMIT ?;

-- name: GetUsageSourceWithBindingAndSession :one
SELECT
    us.id AS source_id,
    us.binding_id,
    us.kind,
    us.native_session_id,
    us.subagent_id,
    us.artifact_path,
    us.file_identity,
    us.generation,
    us.byte_offset,
    us.baseline_input_tokens,
    us.baseline_cached_input_tokens,
    us.baseline_cache_write_tokens,
    us.baseline_output_tokens,
    us.baseline_reasoning_tokens,
    us.parser_version,
    us.state AS source_state,
    us.failure_count,
    us.anomaly_count,
    us.next_retry_at,
    us.last_error_code AS source_last_error_code,
    us.last_observed_at,
    us.created_at AS source_created_at,
    us.updated_at AS source_updated_at,
    ub.session_id,
    ub.harness,
    ub.native_root_id,
    ub.source_cli_version,
    s.project_id
FROM usage_sources us
JOIN usage_bindings ub ON ub.id = us.binding_id
JOIN sessions s ON s.id = ub.session_id
WHERE us.id = ?;

-- name: UpdateUsageSourceCursor :exec
UPDATE usage_sources SET
    byte_offset = ?,
    baseline_input_tokens = ?,
    baseline_cached_input_tokens = ?,
    baseline_cache_write_tokens = ?,
    baseline_output_tokens = ?,
    baseline_reasoning_tokens = ?,
    state = ?,
    failure_count = ?,
    anomaly_count = ?,
    next_retry_at = ?,
    last_error_code = ?,
    last_observed_at = ?,
    updated_at = ?
WHERE id = ?;

-- name: MarkUsageSourceState :execrows
UPDATE usage_sources SET
    state = ?,
    last_error_code = ?,
    next_retry_at = ?,
    updated_at = ?
WHERE id = ?;

-- name: UpdateUsageBindingState :execrows
UPDATE usage_bindings SET
    state = ?,
    last_error_code = ?,
    last_seen_at = ?,
    updated_at = ?
WHERE id = ?;

-- name: GetModelUsageEventByKey :one
SELECT id, source_usage_hash
FROM model_usage_events
WHERE binding_id = ? AND source_event_key = ?;

-- name: InsertModelUsageEvent :exec
INSERT INTO model_usage_events (
    binding_id, usage_source_id, project_id, session_id, harness, provider,
    model_id, observed_at, input_tokens, uncached_input_tokens,
    cache_read_tokens, cache_write_tokens, cache_write_5m_tokens,
    cache_write_1h_tokens, output_tokens, reasoning_tokens, duration_ms,
    reported_cost_nanos, estimated_cost_nanos, pricing_version, cost_basis,
    token_confidence, cost_confidence, source_event_key, source_usage_hash,
    parser_version, source_cli_version, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: AggregateUsageBySessionHarnessModel :many
SELECT
    harness,
    provider,
    model_id,
    CAST(SUM(input_tokens) AS INTEGER) AS input_tokens,
    CAST(SUM(uncached_input_tokens) AS INTEGER) AS uncached_input_tokens,
    CAST(SUM(cache_read_tokens) AS INTEGER) AS cache_read_tokens,
    CAST(SUM(cache_write_tokens) AS INTEGER) AS cache_write_tokens,
    CAST(SUM(output_tokens) AS INTEGER) AS output_tokens,
    CAST(COALESCE(SUM(reasoning_tokens), 0) AS INTEGER) AS reasoning_tokens,
    COUNT(*) AS event_count,
    COUNT(reasoning_tokens) AS reasoning_event_count,
    COUNT(estimated_cost_nanos) AS estimated_cost_event_count,
    CAST(COALESCE(SUM(estimated_cost_nanos), 0) AS INTEGER) AS estimated_cost_nanos,
    CAST(MAX(observed_at) AS TEXT) AS last_observed_at
FROM model_usage_events
WHERE session_id = ?
GROUP BY harness, provider, model_id
ORDER BY SUM(input_tokens + output_tokens) DESC, harness, provider, model_id;

-- name: UsageCoverageCountsForSession :one
SELECT
    COUNT(*) AS event_count,
    COUNT(reasoning_tokens) AS reasoning_event_count,
    COUNT(estimated_cost_nanos) AS estimated_cost_event_count
FROM model_usage_events
WHERE session_id = ?;

-- name: CountUsageRowsForSession :one
SELECT
    (SELECT COUNT(*) FROM usage_bindings WHERE usage_bindings.session_id = sqlc.arg(session_id)) AS binding_count,
    (SELECT COUNT(*)
     FROM usage_sources us
     JOIN usage_bindings ub ON ub.id = us.binding_id
     WHERE ub.session_id = sqlc.arg(session_id)) AS source_count,
    (SELECT COUNT(*) FROM model_usage_events WHERE model_usage_events.session_id = sqlc.arg(session_id)) AS event_count;
