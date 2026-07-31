-- Fork provenance for the pipeline command-executor gate (spec §4b T6, gap
-- flagged in the T5 review PR #235). The SCM observer sees a PR's head repo,
-- but that never survived to the pr table, so a real PR could only ever be
-- classified ForkUnknown after the fact. This nullable tri-state column
-- persists it: NULL = unknown (fail-safe default for legacy rows), 0 = not a
-- fork, 1 = from a fork. The command executor blocks fork + unknown PRs unless
-- allowForkPRs is set.

-- +goose Up
-- +goose StatementBegin
ALTER TABLE pr ADD COLUMN is_from_fork INTEGER;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE pr DROP COLUMN is_from_fork;
-- +goose StatementEnd
