-- name: CreateSCMConnection :exec
INSERT INTO scm_connections (
    id, provider, display_name, web_base_url, api_base_url, credential_ref, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetSCMConnection :one
SELECT id, provider, display_name, web_base_url, api_base_url, credential_ref, created_at, updated_at
FROM scm_connections
WHERE id = ?;

-- name: ListSCMConnections :many
SELECT id, provider, display_name, web_base_url, api_base_url, credential_ref, created_at, updated_at
FROM scm_connections
ORDER BY id;

-- name: UpdateSCMConnection :execrows
UPDATE scm_connections SET
    provider = ?,
    display_name = ?,
    web_base_url = ?,
    api_base_url = ?,
    credential_ref = ?,
    updated_at = ?
WHERE id = ?;

-- name: DeleteUnreferencedSCMConnection :execrows
DELETE FROM scm_connections
WHERE scm_connections.id = ?
  AND NOT EXISTS (
      SELECT 1
      FROM projects
      WHERE json_extract(config, '$.scm.connectionId') = ?
  );

-- name: AcquireSCMConnectionWriteLock :exec
UPDATE scm_connections
SET updated_at = updated_at
WHERE scm_connections.id = (
    SELECT candidate.id
    FROM scm_connections AS candidate
    ORDER BY candidate.id
    LIMIT 1
);
