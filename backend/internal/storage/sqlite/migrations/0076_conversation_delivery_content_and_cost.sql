-- +goose Up
-- +goose StatementBegin
-- Native prompt blocks must travel with a queued message so daemon restart does
-- not reduce an image/resource turn to text. This is delivery state, not rendered
-- transcript metadata, hence the deliberately opaque JSON column.
ALTER TABLE conversation_messages ADD COLUMN delivery_content_json TEXT NOT NULL DEFAULT '';

-- ACP cost is cumulative latest-wins state beside the other usage counters.
-- NULL distinguishes a provider that never reports money from a zero-cost turn.
ALTER TABLE conversations ADD COLUMN usage_cost REAL;
ALTER TABLE conversations ADD COLUMN usage_currency TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Older supported SQLite versions cannot drop columns safely. They are nullable
-- or have a backward-compatible default and are ignored by older binaries.
SELECT 1;
-- +goose StatementEnd
