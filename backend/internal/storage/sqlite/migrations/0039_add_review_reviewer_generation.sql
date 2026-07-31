-- +goose Up
-- +goose StatementBegin
ALTER TABLE review ADD COLUMN reviewer_generation TEXT NOT NULL DEFAULT '';

-- Existing databases did not record handle ownership separately. Preserve the
-- best available generation so an upgrade does not invalidate every retained
-- reviewer; all launches after this migration update it atomically.
UPDATE review
SET reviewer_generation = COALESCE((
    SELECT CASE WHEN review_run.batch_id != '' THEN review_run.batch_id ELSE review_run.id END
    FROM review_run
    WHERE review_run.session_id = review.session_id
    ORDER BY review_run.created_at DESC, review_run.id DESC
    LIMIT 1
), '');
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE review DROP COLUMN reviewer_generation;
-- +goose StatementEnd
