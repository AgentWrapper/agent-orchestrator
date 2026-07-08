-- Track which review system produced each run. Existing AO-native runs keep the
-- default source; final-review submissions record source='final-review'.

-- +goose Up
-- +goose StatementBegin
ALTER TABLE review_run ADD COLUMN source TEXT NOT NULL DEFAULT 'ao-review';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE review_run DROP COLUMN source;
-- +goose StatementEnd
