-- Summary: persist the submitted provider review id that owns each PR review thread.
-- Threads are the provider-resolvable unit, while pr_reviews.review_id remains
-- the review-level anchor used to select the feedback AO should resolve.

-- +goose Up
-- +goose StatementBegin
ALTER TABLE pr_review_threads ADD COLUMN review_id TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_pr_review_threads_review ON pr_review_threads (pr_url, review_id, resolved);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_pr_review_threads_review;
ALTER TABLE pr_review_threads DROP COLUMN review_id;
-- +goose StatementEnd
