-- +goose Up
-- +goose StatementBegin
-- Runs created before batch delivery was introduced are one-run batches.
UPDATE review_run SET batch_id = id WHERE batch_id = '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
UPDATE review_run SET batch_id = '' WHERE batch_id = id;
-- +goose StatementEnd
