-- AO-internal review feedback may be intentionally suppressed while automatic
-- injection is disabled. This nullable timestamp records that terminal outcome
-- separately from feedback that was delivered to the worker.

-- +goose Up
-- +goose StatementBegin
ALTER TABLE review_run ADD COLUMN suppressed_at TIMESTAMP;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE review_run DROP COLUMN suppressed_at;
-- +goose StatementEnd
