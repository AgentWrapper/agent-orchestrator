-- +goose Up
-- +goose StatementBegin
-- Stores only a one-way verifier. The worker's bearer token remains solely in
-- its process environment and can survive daemon/app replacement without a
-- global secret being written to disk.
ALTER TABLE sessions ADD COLUMN browser_capability_verifier TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE sessions DROP COLUMN browser_capability_verifier;
-- +goose StatementEnd
