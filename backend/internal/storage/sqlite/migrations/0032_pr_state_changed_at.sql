-- Summary: persist when the current normalized PR lifecycle state became active.
-- +goose Up
-- +goose StatementBegin
ALTER TABLE pr ADD COLUMN state_changed_at TIMESTAMP;

UPDATE pr
SET state_changed_at = CASE
    WHEN pr_state = 'merged' AND merged_at_provider IS NOT NULL THEN merged_at_provider
    WHEN pr_state = 'closed' AND closed_at_provider IS NOT NULL THEN closed_at_provider
    WHEN created_at_provider IS NOT NULL THEN created_at_provider
END
WHERE state_changed_at IS NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE pr DROP COLUMN state_changed_at;
-- +goose StatementEnd
