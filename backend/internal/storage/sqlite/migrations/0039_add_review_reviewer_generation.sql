-- +goose Up
-- +goose StatementBegin
ALTER TABLE review ADD COLUMN reviewer_generation TEXT NOT NULL DEFAULT '';

-- Existing databases did not record which batch successfully owned the live
-- handle, and newer failed runs may never have launched. Use the handle itself
-- as a stable opaque legacy generation; the next successful Spawn or Notify
-- replaces it with the launched batch id.
UPDATE review SET reviewer_generation = reviewer_handle_id;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE review DROP COLUMN reviewer_generation;
-- +goose StatementEnd
