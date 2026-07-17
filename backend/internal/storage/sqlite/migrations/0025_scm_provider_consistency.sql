-- +goose Up
-- Keep the provider selected by each project consistent with its referenced
-- connection, including writes made concurrently through another DB handle.
-- +goose StatementBegin
CREATE TRIGGER projects_scm_provider_guard_insert
BEFORE INSERT ON projects
WHEN COALESCE(json_extract(NEW.config, '$.scm.connectionId'), '') <> ''
    AND NOT (
        json_extract(NEW.config, '$.scm.connectionId') = 'github-default'
        AND COALESCE(json_extract(NEW.config, '$.scm.provider'), 'github') = 'github'
    )
    AND EXISTS (
        SELECT 1 FROM scm_connections
        WHERE id = json_extract(NEW.config, '$.scm.connectionId')
    )
    AND NOT EXISTS (
        SELECT 1 FROM scm_connections
        WHERE id = json_extract(NEW.config, '$.scm.connectionId')
          AND provider = COALESCE(json_extract(NEW.config, '$.scm.provider'), 'github')
    )
BEGIN
    SELECT RAISE(ABORT, 'scm connection provider mismatch');
END;

CREATE TRIGGER projects_scm_provider_guard_update
BEFORE UPDATE OF config ON projects
WHEN COALESCE(json_extract(NEW.config, '$.scm.connectionId'), '') <> ''
    AND NOT (
        json_extract(NEW.config, '$.scm.connectionId') = 'github-default'
        AND COALESCE(json_extract(NEW.config, '$.scm.provider'), 'github') = 'github'
    )
    AND EXISTS (
        SELECT 1 FROM scm_connections
        WHERE id = json_extract(NEW.config, '$.scm.connectionId')
    )
    AND NOT EXISTS (
        SELECT 1 FROM scm_connections
        WHERE id = json_extract(NEW.config, '$.scm.connectionId')
          AND provider = COALESCE(json_extract(NEW.config, '$.scm.provider'), 'github')
    )
BEGIN
    SELECT RAISE(ABORT, 'scm connection provider mismatch');
END;

CREATE TRIGGER scm_connection_provider_guard_update
BEFORE UPDATE OF provider ON scm_connections
WHEN OLD.provider <> NEW.provider
    AND EXISTS (
        SELECT 1 FROM projects
        WHERE json_extract(config, '$.scm.connectionId') = OLD.id
          AND COALESCE(json_extract(config, '$.scm.provider'), 'github') <> NEW.provider
    )
BEGIN
    SELECT RAISE(ABORT, 'scm connection is referenced by a project with another provider');
END;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS scm_connection_provider_guard_update;
DROP TRIGGER IF EXISTS projects_scm_provider_guard_update;
DROP TRIGGER IF EXISTS projects_scm_provider_guard_insert;
-- +goose StatementEnd
