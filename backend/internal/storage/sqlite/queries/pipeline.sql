-- Pipeline definitions -------------------------------------------------------

-- name: CreatePipelineDefinition :exec
INSERT INTO pipeline_definitions (id, project_id, name, yaml_source, config_json, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?);

-- name: GetPipelineDefinition :one
SELECT id, project_id, name, yaml_source, config_json, created_at, updated_at
FROM pipeline_definitions WHERE id = ?;

-- name: GetPipelineDefinitionByName :one
SELECT id, project_id, name, yaml_source, config_json, created_at, updated_at
FROM pipeline_definitions WHERE project_id = ? AND name = ?;

-- name: ListPipelineDefinitions :many
SELECT id, project_id, name, yaml_source, config_json, created_at, updated_at
FROM pipeline_definitions WHERE project_id = ? ORDER BY name ASC;

-- name: UpdatePipelineDefinition :execrows
UPDATE pipeline_definitions
SET name = ?, yaml_source = ?, config_json = ?, updated_at = ?
WHERE id = ?;

-- name: DeletePipelineDefinition :execrows
DELETE FROM pipeline_definitions WHERE id = ?;

-- Pipeline runs --------------------------------------------------------------

-- name: UpsertPipelineRun :exec
INSERT INTO pipeline_runs (
    id, project_id, pipeline_id, pipeline_name, session_id, head_sha,
    loop_state, termination_reason, loop_rounds, config_snapshot, fingerprints,
    created_at, updated_at, context_json, blocks_merge
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
    pipeline_name = excluded.pipeline_name,
    session_id = excluded.session_id,
    head_sha = excluded.head_sha,
    loop_state = excluded.loop_state,
    termination_reason = excluded.termination_reason,
    loop_rounds = excluded.loop_rounds,
    config_snapshot = excluded.config_snapshot,
    fingerprints = excluded.fingerprints,
    context_json = excluded.context_json,
    blocks_merge = excluded.blocks_merge,
    updated_at = excluded.updated_at;

-- name: GetPipelineRun :one
SELECT id, project_id, pipeline_id, pipeline_name, session_id, head_sha,
       loop_state, termination_reason, loop_rounds, config_snapshot, fingerprints,
       created_at, updated_at, context_json, blocks_merge
FROM pipeline_runs WHERE id = ?;

-- name: ListPipelineRuns :many
SELECT id, project_id, pipeline_id, pipeline_name, session_id, head_sha,
       loop_state, termination_reason, loop_rounds, config_snapshot, fingerprints,
       created_at, updated_at, context_json, blocks_merge
FROM pipeline_runs
WHERE project_id = ?
  AND (sqlc.narg('pipeline_name') IS NULL OR pipeline_name = sqlc.narg('pipeline_name'))
  AND (sqlc.narg('loop_state') IS NULL OR loop_state = sqlc.narg('loop_state'))
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg('lim');

-- name: GetLatestSettledPipelineRunByPR :one
-- Latest settled (done or stalled) run for a PR, matched by the RunContext PR
-- URL stored in context_json. The lifecycle merge-readiness path compares the
-- returned run's head SHA against the PR's current head to decide whether the
-- decision is fresh; a stale-SHA run is treated as no opinion by the caller.
SELECT id, project_id, pipeline_id, pipeline_name, session_id, head_sha,
       loop_state, termination_reason, loop_rounds, config_snapshot, fingerprints,
       created_at, updated_at, context_json, blocks_merge
FROM pipeline_runs
WHERE project_id = ?
  AND json_extract(context_json, '$.prUrl') = sqlc.arg('pr_url')
  AND loop_state IN ('done', 'stalled')
ORDER BY created_at DESC, id DESC
LIMIT 1;

-- Pipeline stage runs --------------------------------------------------------

-- name: UpsertPipelineStageRun :exec
INSERT INTO pipeline_stage_runs (
    run_id, project_id, stage_name, stage_run_id, status, attempt, verdict,
    started_at, completed_at, error_message, session_id, notes, output
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (run_id, stage_name) DO UPDATE SET
    stage_run_id = excluded.stage_run_id,
    status = excluded.status,
    attempt = excluded.attempt,
    verdict = excluded.verdict,
    started_at = excluded.started_at,
    completed_at = excluded.completed_at,
    error_message = excluded.error_message,
    session_id = excluded.session_id,
    notes = excluded.notes,
    output = excluded.output;

-- name: ListPipelineStageRunsByRun :many
SELECT run_id, project_id, stage_name, stage_run_id, status, attempt, verdict,
       started_at, completed_at, error_message, session_id, notes, output
FROM pipeline_stage_runs WHERE run_id = ? ORDER BY stage_name ASC;

-- Pipeline artifacts ---------------------------------------------------------

-- name: InsertPipelineArtifact :exec
INSERT INTO pipeline_artifacts (
    id, pipeline_run_id, project_id, stage_run_id, stage_name, kind,
    fingerprint, status, sent_to_agent_at, payload, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: UpdatePipelineArtifactStatus :execrows
UPDATE pipeline_artifacts SET status = ?, sent_to_agent_at = ? WHERE id = ?;

-- name: GetPipelineArtifact :one
SELECT id, pipeline_run_id, project_id, stage_run_id, stage_name, kind,
       fingerprint, status, sent_to_agent_at, payload, created_at
FROM pipeline_artifacts WHERE id = ?;

-- name: ListPipelineArtifactsByRun :many
SELECT id, pipeline_run_id, project_id, stage_run_id, stage_name, kind,
       fingerprint, status, sent_to_agent_at, payload, created_at
FROM pipeline_artifacts WHERE pipeline_run_id = ? ORDER BY created_at ASC, id ASC;
