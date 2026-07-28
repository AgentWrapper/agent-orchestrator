-- name: DeleteReviewFindingsByRun :exec
DELETE FROM review_finding WHERE review_run_id = ?;

-- name: InsertReviewFinding :exec
INSERT INTO review_finding (
    id, review_run_id, file, line, severity, title, claim, failure_scenario, behavioral, created_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: ListReviewFindingsByRun :many
SELECT id, review_run_id, file, line, severity, title, claim, failure_scenario, behavioral, created_at
FROM review_finding
WHERE review_run_id = ?
ORDER BY created_at ASC, id ASC;

-- name: InsertTestGateRun :exec
INSERT INTO test_gate_run (
    id, session_id, review_run_id, pr_url, target_sha, kind, classification, summary,
    artifacts_json, pod_handle_id, created_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetLatestTestGateRun :one
SELECT id, session_id, review_run_id, pr_url, target_sha, kind, classification, summary,
       artifacts_json, pod_handle_id, created_at
FROM test_gate_run
WHERE session_id = ? AND pr_url = ? AND target_sha = ? AND kind = ?
ORDER BY created_at DESC, id DESC
LIMIT 1;

-- name: InsertTestEvidence :exec
INSERT INTO test_gate_evidence (
    id, test_run_id, finding_id, source, outcome, summary, artifacts_json, created_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?);

-- name: ListTestEvidenceByTestRun :many
SELECT id, test_run_id, finding_id, source, outcome, summary, artifacts_json, created_at
FROM test_gate_evidence
WHERE test_run_id = ?
ORDER BY created_at ASC, id ASC;

-- name: UpsertFusedVerdict :exec
INSERT INTO fused_verdict (
    id, session_id, review_run_id, test_run_id, pr_url, target_sha, outcome, blocking,
    summary, findings_json, created_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (session_id, pr_url, target_sha) DO UPDATE SET
    review_run_id = excluded.review_run_id,
    test_run_id = excluded.test_run_id,
    outcome = excluded.outcome,
    blocking = excluded.blocking,
    summary = excluded.summary,
    findings_json = excluded.findings_json,
    created_at = excluded.created_at;

-- name: GetFusedVerdict :one
SELECT id, session_id, review_run_id, test_run_id, pr_url, target_sha, outcome, blocking,
       summary, findings_json, created_at
FROM fused_verdict
WHERE session_id = ? AND pr_url = ? AND target_sha = ?;
