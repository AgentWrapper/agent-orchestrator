-- +goose Up
ALTER TABLE ao_github_repository_grants
    DROP CONSTRAINT ao_github_repository_grants_org_installation_fk;

ALTER TABLE ao_github_installations
    DROP CONSTRAINT ao_github_installations_github_installation_id_key,
    ADD CONSTRAINT ao_github_installations_org_github_installation_key
        UNIQUE (org_id, github_installation_id);

ALTER TABLE ao_github_repository_grants
    ADD CONSTRAINT ao_github_repository_grants_installation_fk
        FOREIGN KEY (installation_id)
        REFERENCES ao_github_installations(id)
        ON DELETE RESTRICT;

CREATE INDEX ao_github_installations_user_status_idx
    ON ao_github_installations(installed_by_user_id, status, github_installation_id);

-- +goose Down
DROP INDEX IF EXISTS ao_github_installations_user_status_idx;

ALTER TABLE ao_github_repository_grants
    DROP CONSTRAINT ao_github_repository_grants_installation_fk;

UPDATE ao_projects
SET github_repository_id = NULL,
    github_repository_grant_id = NULL
WHERE github_repository_grant_id IN (
    SELECT repository_grant.id
    FROM ao_github_repository_grants repository_grant
    WHERE repository_grant.installation_id IN (
        SELECT id
        FROM (
            SELECT id, row_number() OVER (
                PARTITION BY github_installation_id
                ORDER BY created_at, id
            ) AS binding_rank
            FROM ao_github_installations
        ) ranked
        WHERE binding_rank > 1
    )
);

DELETE FROM ao_github_repository_grants
WHERE installation_id IN (
    SELECT id
    FROM (
        SELECT id, row_number() OVER (
            PARTITION BY github_installation_id
            ORDER BY created_at, id
        ) AS binding_rank
        FROM ao_github_installations
    ) ranked
    WHERE binding_rank > 1
);

DELETE FROM ao_github_installations
WHERE id IN (
    SELECT id
    FROM (
        SELECT id, row_number() OVER (
            PARTITION BY github_installation_id
            ORDER BY created_at, id
        ) AS binding_rank
        FROM ao_github_installations
    ) ranked
    WHERE binding_rank > 1
);

ALTER TABLE ao_github_installations
    DROP CONSTRAINT ao_github_installations_org_github_installation_key,
    ADD CONSTRAINT ao_github_installations_github_installation_id_key
        UNIQUE (github_installation_id);

ALTER TABLE ao_github_repository_grants
    ADD CONSTRAINT ao_github_repository_grants_org_installation_fk
        FOREIGN KEY (org_id, installation_id)
        REFERENCES ao_github_installations(org_id, id)
        ON DELETE RESTRICT;
