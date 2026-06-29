-- Summary: persist provider review submissions so the UI can link to review summaries.
-- +goose Up
-- +goose StatementBegin
CREATE TABLE pr_reviews (
    pr_url       TEXT NOT NULL REFERENCES pr (url) ON DELETE CASCADE,
    review_id    TEXT NOT NULL,
    author       TEXT NOT NULL DEFAULT '',
    state        TEXT NOT NULL DEFAULT 'none'
        CHECK (state IN ('none', 'approved', 'changes_requested', 'review_required')),
    url          TEXT NOT NULL DEFAULT '',
    is_bot       INTEGER NOT NULL DEFAULT 0,
    submitted_at TIMESTAMP NOT NULL,
    PRIMARY KEY (pr_url, review_id)
);
CREATE INDEX idx_pr_reviews_lookup ON pr_reviews (pr_url, submitted_at);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_pr_reviews_lookup;
DROP TABLE IF EXISTS pr_reviews;
-- +goose StatementEnd
