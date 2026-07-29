-- Summary: persist the provider review id that owns each PR review thread.
-- +goose Up
-- +goose StatementBegin
ALTER TABLE pr_review_threads ADD COLUMN review_id TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_pr_review_threads_review ON pr_review_threads (pr_url, review_id, updated_at);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_pr_review_threads_review;
ALTER TABLE pr_review_threads DROP COLUMN review_id;
-- +goose StatementEnd
