-- name: CreateSCMConnection :exec
INSERT INTO scm_connections (
    id, provider, display_name, web_base_url, api_base_url, credential_ref, status, username, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetSCMConnection :one
SELECT id, provider, display_name, web_base_url, api_base_url, credential_ref, status, username, created_at, updated_at
FROM scm_connections
WHERE id = ?;

-- name: ListSCMConnections :many
SELECT id, provider, display_name, web_base_url, api_base_url, credential_ref, status, username, created_at, updated_at
FROM scm_connections
ORDER BY id;

-- name: UpdateSCMConnection :execrows
UPDATE scm_connections SET
    provider = sqlc.arg(provider),
    display_name = sqlc.arg(display_name),
    web_base_url = sqlc.arg(web_base_url),
    api_base_url = sqlc.arg(api_base_url),
    credential_ref = sqlc.arg(credential_ref),
    status = sqlc.arg(status),
    username = sqlc.arg(username),
    updated_at = sqlc.arg(updated_at)
WHERE scm_connections.id = sqlc.arg(id)
  AND (
      scm_connections.provider = sqlc.arg(provider)
      OR NOT EXISTS (
          SELECT 1
          FROM projects
          WHERE json_extract(config, '$.scm.connectionId') = scm_connections.id
      )
  );

-- name: UpdateSCMConnectionValidation :execrows
UPDATE scm_connections SET
    status = ?,
    username = ?
WHERE id = ?
  AND updated_at = sqlc.arg(expected_updated_at);

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
