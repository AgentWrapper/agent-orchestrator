-- Group review runs created by one trigger so worker feedback can be delivered
-- once after every PR in that trigger finishes reviewing.

-- +goose Up
-- +goose StatementBegin
ALTER TABLE review_run ADD COLUMN batch_id TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose StatementBegin
CREATE INDEX idx_review_run_session_batch
    ON review_run (session_id, batch_id, created_at)
    WHERE batch_id != '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX idx_review_run_session_batch;
-- +goose StatementEnd

-- +goose StatementBegin
ALTER TABLE review_run DROP COLUMN batch_id;
-- +goose StatementEnd
