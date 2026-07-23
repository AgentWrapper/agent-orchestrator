-- Summary: persist the provider review body so the reviews UI can show a
-- summary alongside each PR review verdict. Defaulting to '' keeps existing
-- rows valid without backfill; older rows simply have no stored summary until
-- the next SCM observation refreshes them.

-- +goose Up
-- +goose StatementBegin
ALTER TABLE pr_reviews ADD COLUMN body TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE pr_reviews DROP COLUMN body;
-- +goose StatementEnd
