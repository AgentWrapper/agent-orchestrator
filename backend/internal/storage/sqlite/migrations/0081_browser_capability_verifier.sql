-- Keep the browser capability verifier on the owning session row without
-- modifying the already-shipped 0048 reviewer migration.

-- +goose Up
-- +goose StatementBegin
ALTER TABLE sessions ADD COLUMN browser_capability_verifier TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE sessions DROP COLUMN browser_capability_verifier;
-- +goose StatementEnd
