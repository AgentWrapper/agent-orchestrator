-- +goose Up
CREATE VIEW usage_codex_source_discovery AS
SELECT
    source_id,
    binding_id,
    native_session_id,
    CASE
        WHEN child_ids_json IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM json_each(child_ids_json) WHERE type <> 'text'
        ) THEN child_ids_json
        ELSE '[]'
    END AS discovered_child_ids_json,
    CASE
        WHEN child_ids_json IS NOT NULL AND EXISTS (
            SELECT 1 FROM json_each(child_ids_json) WHERE type <> 'text'
        ) THEN 1
        ELSE 0
    END AS has_mixed_child_types
FROM (
    SELECT
        id AS source_id,
        binding_id,
        native_session_id,
        CASE WHEN json_valid(parser_state_json) THEN
            CASE WHEN json_type(parser_state_json, '$') = 'object'
                AND json_type(parser_state_json, '$.version') = 'integer'
                AND json_extract(parser_state_json, '$.version') = 1
                AND json_type(parser_state_json, '$.source_kind') = 'text'
                AND json_extract(parser_state_json, '$.source_kind') = 'codex_rollout'
                AND json_type(parser_state_json, '$.codex') = 'object'
                AND json_type(parser_state_json, '$.codex.discovered_child_ids') = 'array'
            THEN json_extract(parser_state_json, '$.codex.discovered_child_ids')
            END
        END AS child_ids_json
    FROM usage_sources
    WHERE kind = 'codex_rollout'
);

CREATE VIEW usage_codex_pending_children AS
SELECT
    spawning.binding_id,
    CAST(discovered.value AS TEXT) AS native_session_id
FROM usage_codex_source_discovery spawning
JOIN json_each(spawning.discovered_child_ids_json) discovered
WHERE discovered.type = 'text'
  AND length(discovered.value) = 36
  AND substr(discovered.value, 9, 1) = '-'
  AND substr(discovered.value, 14, 1) = '-'
  AND substr(discovered.value, 19, 1) = '-'
  AND substr(discovered.value, 24, 1) = '-'
  AND lower(discovered.value) = discovered.value
  AND length(replace(discovered.value, '-', '')) = 32
  AND replace(discovered.value, '-', '') NOT GLOB '*[^0-9a-f]*'
  AND spawning.source_id = (
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
      WHERE registered.binding_id = spawning.binding_id
        AND registered.kind = 'codex_rollout'
        AND registered.native_session_id = CAST(discovered.value AS TEXT)
  );

-- +goose Down
DROP VIEW usage_codex_pending_children;
DROP VIEW usage_codex_source_discovery;
