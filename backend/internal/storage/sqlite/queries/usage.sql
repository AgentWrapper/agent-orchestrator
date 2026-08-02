-- name: UpsertUsageBinding :one
INSERT INTO usage_bindings (
    session_id, harness, native_root_id, initial_model_id, state,
    last_error_code, first_seen_at, last_seen_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (session_id, harness, native_root_id) DO UPDATE SET
    initial_model_id = CASE
        WHEN excluded.initial_model_id <> '' THEN excluded.initial_model_id
        ELSE usage_bindings.initial_model_id
    END,
    state = CASE
        WHEN usage_bindings.state IN ('finalizing', 'complete', 'partial')
          AND excluded.state IN ('discovering', 'active')
        THEN usage_bindings.state
        ELSE excluded.state
    END,
    last_error_code = CASE
        WHEN usage_bindings.state IN ('finalizing', 'complete', 'partial')
          AND excluded.state IN ('discovering', 'active')
        THEN usage_bindings.last_error_code
        ELSE excluded.last_error_code
    END,
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
    file_identity, generation, byte_offset, parser_state_json,
    state, failure_count, anomaly_count, next_retry_at, last_error_code,
    last_observed_at, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (binding_id, artifact_path, generation) DO UPDATE SET
    native_session_id = CASE
        WHEN excluded.native_session_id <> '' THEN excluded.native_session_id
        ELSE usage_sources.native_session_id
    END,
    subagent_id = CASE
        WHEN excluded.subagent_id <> '' THEN excluded.subagent_id
        ELSE usage_sources.subagent_id
    END,
    updated_at = excluded.updated_at
RETURNING *;

-- name: ListUsageSourcesForBinding :many
SELECT *
FROM usage_sources
WHERE binding_id = ?
ORDER BY generation, id;

-- name: ListWatchableUsageSources :many
SELECT us.*
FROM usage_sources us
JOIN usage_bindings ub ON ub.id = us.binding_id
JOIN sessions s ON s.id = ub.session_id
WHERE (s.is_terminated = 0 OR ub.state = 'finalizing')
  AND us.id = (
      SELECT latest.id
      FROM usage_sources latest
      WHERE latest.binding_id = us.binding_id
        AND latest.artifact_path = us.artifact_path
      ORDER BY latest.generation DESC, latest.id DESC
      LIMIT 1
  )
ORDER BY us.artifact_path, us.generation, us.id;

-- name: ListUsageDiscoveryBindings :many
SELECT ub.*
FROM usage_bindings ub
JOIN sessions s ON s.id = ub.session_id
WHERE (s.is_terminated = 0 OR ub.state = 'finalizing')
  AND ub.harness IN ('claude-code', 'codex')
  AND ub.state IN ('discovering', 'active', 'finalizing')
  AND (
      ub.harness = 'claude-code'
      OR ub.state = 'discovering'
      OR ub.state = 'finalizing'
      OR ub.last_error_code = 'source_discovery_pending'
      OR NOT EXISTS (
          SELECT 1
          FROM usage_sources us
          WHERE us.binding_id = ub.id
            AND us.kind = 'codex_rollout'
      )
      OR EXISTS (
          SELECT 1
          FROM usage_sources us
          WHERE us.binding_id = ub.id
            AND us.kind = 'codex_rollout'
            AND us.state = 'error'
            AND us.last_error_code IN ('artifact_missing', 'source_read_failed')
      )
	  OR EXISTS (
	      SELECT 1
	      FROM usage_sources spawning
	      JOIN json_each(
	          CASE
	              WHEN json_valid(spawning.parser_state_json) THEN
	                  CASE
	                      WHEN json_type(spawning.parser_state_json, '$') = 'object'
	                       AND json_type(spawning.parser_state_json, '$.version') = 'integer'
	                       AND json_extract(spawning.parser_state_json, '$.version') = 1
	                       AND json_type(spawning.parser_state_json, '$.source_kind') = 'text'
	                       AND json_extract(spawning.parser_state_json, '$.source_kind') = 'codex_rollout'
	                       AND json_type(spawning.parser_state_json, '$.codex') = 'object'
	                       AND json_type(spawning.parser_state_json, '$.codex.discovered_child_ids') = 'array'
	                      THEN json_extract(spawning.parser_state_json, '$.codex.discovered_child_ids')
	                      ELSE '[]'
	                  END
	              ELSE '[]'
	          END
	      ) discovered
	      WHERE spawning.binding_id = ub.id
	        AND spawning.kind = 'codex_rollout'
	        AND discovered.type = 'text'
	        AND length(discovered.value) = 36
	        AND substr(discovered.value, 9, 1) = '-'
	        AND substr(discovered.value, 14, 1) = '-'
	        AND substr(discovered.value, 19, 1) = '-'
	        AND substr(discovered.value, 24, 1) = '-'
	        AND lower(discovered.value) = discovered.value
	        AND length(replace(discovered.value, '-', '')) = 32
	        AND replace(discovered.value, '-', '') NOT GLOB '*[^0-9a-f]*'
	        AND spawning.id = (
	            SELECT latest.id
	            FROM usage_sources latest
	            WHERE latest.binding_id = spawning.binding_id
	              AND latest.kind = 'codex_rollout'
	              AND latest.native_session_id = spawning.native_session_id
	            ORDER BY latest.generation DESC, latest.id DESC
	            LIMIT 1
	        )
	        AND NOT EXISTS (
	            SELECT 1
	            FROM usage_sources registered
	            WHERE registered.binding_id = ub.id
	              AND registered.kind = 'codex_rollout'
	              AND registered.native_session_id = CAST(discovered.value AS TEXT)
	        )
	  )
  )
ORDER BY ub.updated_at, ub.id
LIMIT ?;

-- name: ListUsageBindingsForCodexParent :many
SELECT DISTINCT ub.*
FROM usage_bindings ub
JOIN sessions s ON s.id = ub.session_id
JOIN usage_sources parent ON parent.binding_id = ub.id
WHERE (s.is_terminated = 0 OR ub.state = 'finalizing')
  AND ub.harness = 'codex'
  AND ub.state IN ('discovering', 'active', 'finalizing')
  AND parent.kind = 'codex_rollout'
  AND parent.native_session_id = sqlc.arg(parent_native_session_id)
  AND parent.id = (
      SELECT latest.id
      FROM usage_sources latest
      WHERE latest.binding_id = parent.binding_id
        AND latest.kind = 'codex_rollout'
        AND latest.native_session_id = parent.native_session_id
      ORDER BY latest.generation DESC, latest.id DESC
      LIMIT 1
  )
ORDER BY ub.updated_at, ub.id;

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
    us.parser_state_json,
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
    ub.initial_model_id,
    ub.state AS binding_state,
    s.project_id
FROM usage_sources us
JOIN usage_bindings ub ON ub.id = us.binding_id
JOIN sessions s ON s.id = ub.session_id
WHERE us.id = ?;

-- name: UpdateUsageSourceCursor :exec
UPDATE usage_sources SET
    byte_offset = ?,
    parser_state_json = ?,
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

-- name: ReactivateUsageSource :execrows
UPDATE usage_sources SET
    state = 'active',
    failure_count = 0,
    next_retry_at = NULL,
    last_error_code = '',
    updated_at = ?
WHERE id = ?;

-- name: MarkUsageSourceFailure :execrows
UPDATE usage_sources SET
    state = 'error',
    failure_count = ?,
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

-- name: UpdateUsageBindingErrorCode :execrows
UPDATE usage_bindings SET
    last_error_code = ?,
    last_seen_at = ?,
    updated_at = ?
WHERE id = ?;

-- name: CompleteUsageBindingIfSettled :execrows
UPDATE usage_bindings
SET state = CASE
        WHEN EXISTS (
            SELECT 1
            FROM usage_sources
            WHERE usage_sources.binding_id = sqlc.arg(usage_binding_id)
              AND (anomaly_count > 0 OR last_error_code <> '')
        ) THEN 'partial'
        ELSE 'complete'
    END,
    last_error_code = '',
    last_seen_at = sqlc.arg(updated_at),
    updated_at = sqlc.arg(updated_at)
WHERE id = sqlc.arg(usage_binding_id)
  AND state = 'finalizing'
  AND EXISTS (
      SELECT 1
      FROM usage_sources
      WHERE usage_sources.binding_id = sqlc.arg(usage_binding_id)
  )
  AND NOT EXISTS (
      SELECT 1
      FROM usage_sources
      WHERE usage_sources.binding_id = sqlc.arg(usage_binding_id)
        AND state <> 'complete'
	)
	AND NOT EXISTS (
	    SELECT 1
	    FROM usage_sources spawning
	    JOIN json_each(
	        CASE
	            WHEN json_valid(spawning.parser_state_json) THEN
	                CASE
	                    WHEN json_type(spawning.parser_state_json, '$') = 'object'
	                     AND json_type(spawning.parser_state_json, '$.version') = 'integer'
	                     AND json_extract(spawning.parser_state_json, '$.version') = 1
	                     AND json_type(spawning.parser_state_json, '$.source_kind') = 'text'
	                     AND json_extract(spawning.parser_state_json, '$.source_kind') = 'codex_rollout'
	                     AND json_type(spawning.parser_state_json, '$.codex') = 'object'
	                     AND json_type(spawning.parser_state_json, '$.codex.discovered_child_ids') = 'array'
	                    THEN json_extract(spawning.parser_state_json, '$.codex.discovered_child_ids')
	                    ELSE '[]'
	                END
	            ELSE '[]'
	        END
	    ) discovered
	    WHERE spawning.binding_id = sqlc.arg(usage_binding_id)
	      AND spawning.kind = 'codex_rollout'
	      AND discovered.type = 'text'
	      AND length(discovered.value) = 36
	      AND substr(discovered.value, 9, 1) = '-'
	      AND substr(discovered.value, 14, 1) = '-'
	      AND substr(discovered.value, 19, 1) = '-'
	      AND substr(discovered.value, 24, 1) = '-'
	      AND lower(discovered.value) = discovered.value
	      AND length(replace(discovered.value, '-', '')) = 32
	      AND replace(discovered.value, '-', '') NOT GLOB '*[^0-9a-f]*'
	      AND spawning.id = (
	          SELECT latest.id
	          FROM usage_sources latest
	          WHERE latest.binding_id = spawning.binding_id
	            AND latest.kind = 'codex_rollout'
	            AND latest.native_session_id = spawning.native_session_id
	          ORDER BY latest.generation DESC, latest.id DESC
	          LIMIT 1
	      )
	      AND NOT EXISTS (
	          SELECT 1
	          FROM usage_sources registered
	          WHERE registered.binding_id = sqlc.arg(usage_binding_id)
	            AND registered.kind = 'codex_rollout'
	            AND registered.native_session_id = CAST(discovered.value AS TEXT)
	      )
  );

-- name: GetModelUsageEventByKey :one
SELECT
    provider, model_id, observed_at, input_tokens, uncached_input_tokens,
    cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
    cost_nanos, pricing_version
FROM model_usage_events
WHERE binding_id = ? AND source_event_key = ?;

-- name: InsertModelUsageEvent :exec
INSERT INTO model_usage_events (
    binding_id, usage_source_id, project_id, session_id, harness, provider,
    model_id, observed_at, input_tokens, uncached_input_tokens,
    cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
    cost_nanos, pricing_version, source_event_key, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

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
    COUNT(cost_nanos) AS cost_event_count,
    CAST(COALESCE(SUM(cost_nanos), 0) AS INTEGER) AS cost_nanos,
    CASE
        WHEN COUNT(cost_nanos) > 0
          AND COUNT(CASE WHEN cost_nanos IS NOT NULL THEN pricing_version END) = COUNT(cost_nanos)
          AND COUNT(DISTINCT CASE WHEN cost_nanos IS NOT NULL THEN pricing_version END) = 1
        THEN MAX(CASE WHEN cost_nanos IS NOT NULL THEN pricing_version END)
        ELSE NULL
    END AS pricing_version,
    CAST(MAX(observed_at) AS TEXT) AS last_observed_at
FROM model_usage_events
WHERE session_id = ?
GROUP BY harness, provider, model_id
ORDER BY SUM(input_tokens + output_tokens) DESC, harness, provider, model_id;

-- name: ListCompactSessionUsage :many
SELECT
    s.id AS session_id,
    s.harness,
    COUNT(DISTINCT ub.id) AS binding_count,
    COUNT(DISTINCT CASE WHEN ub.state = 'complete' THEN ub.id END) AS complete_binding_count,
    COUNT(DISTINCT CASE WHEN ub.state = 'partial' THEN ub.id END) AS partial_binding_count,
    COUNT(DISTINCT us.id) AS source_count,
    COUNT(DISTINCT CASE WHEN us.state = 'complete' THEN us.id END) AS complete_source_count,
    COUNT(DISTINCT CASE WHEN us.state = 'error' THEN us.id END) AS error_source_count,
    COUNT(DISTINCT CASE
        WHEN us.anomaly_count > 0 OR us.last_error_code <> '' THEN us.id
    END) AS anomalous_source_count,
    COUNT(DISTINCT mue.id) AS event_count,
    CAST(COALESCE(SUM(mue.input_tokens + mue.output_tokens), 0) AS INTEGER) AS total_tokens,
    COALESCE(CAST(MAX(mue.observed_at) AS TEXT), '') AS last_observed_at
FROM sessions s
LEFT JOIN usage_bindings ub ON ub.session_id = s.id
LEFT JOIN usage_sources us ON us.binding_id = ub.id
LEFT JOIN model_usage_events mue ON mue.usage_source_id = us.id
WHERE (sqlc.arg(project_id) = '' OR s.project_id = sqlc.arg(project_id))
GROUP BY s.id, s.harness
ORDER BY s.project_id, s.num;
