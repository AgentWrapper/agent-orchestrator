-- +goose Up
ALTER TABLE ao_project_share_links
    DROP CONSTRAINT ao_project_share_links_role_check;
ALTER TABLE ao_project_share_grants
    DROP CONSTRAINT ao_project_share_grants_role_check;

UPDATE ao_project_share_links
SET role = 'editor'
WHERE role IN ('admin', 'owner');
UPDATE ao_project_share_grants
SET role = 'editor'
WHERE role IN ('admin', 'owner');

ALTER TABLE ao_project_share_links
    ADD CONSTRAINT ao_project_share_links_role_check
    CHECK (role IN ('viewer', 'editor'));
ALTER TABLE ao_project_share_grants
    ADD CONSTRAINT ao_project_share_grants_role_check
    CHECK (role IN ('viewer', 'editor'));

-- +goose Down
ALTER TABLE ao_project_share_links
    DROP CONSTRAINT ao_project_share_links_role_check;
ALTER TABLE ao_project_share_grants
    DROP CONSTRAINT ao_project_share_grants_role_check;

UPDATE ao_project_share_links
SET role = 'admin'
WHERE role = 'editor';
UPDATE ao_project_share_grants
SET role = 'admin'
WHERE role = 'editor';

ALTER TABLE ao_project_share_links
    ADD CONSTRAINT ao_project_share_links_role_check
    CHECK (role IN ('viewer', 'admin', 'owner'));
ALTER TABLE ao_project_share_grants
    ADD CONSTRAINT ao_project_share_grants_role_check
    CHECK (role IN ('viewer', 'admin', 'owner'));
