-- +goose Up
-- +goose StatementBegin
-- Rollback is undo against the AGENT's memory, not a filter on the timeline. The
-- provider genuinely drops those turns from the history it reasons over, so AO's
-- rows have to agree afterwards or the user reads messages the agent cannot recall.
--
-- rolled_back_at is how they agree, and it is a nullable timestamp rather than a
-- DELETE because AO does not destroy durable facts. "This exchange happened and was
-- then taken back" is a different and more useful fact than "this exchange never
-- existed", and the raw provider-event archive would still describe turns whose rows
-- had vanished.
--
-- Reads follow from that one column:
--
--   * turns are still selected in full, carrying rolled_back_at, so a client can say
--     how much was discarded;
--   * messages and activities attached to a rolled-back turn are filtered out of the
--     snapshot, because a person must never be shown prose the agent has forgotten;
--   * rows with turn_id IS NULL stay visible. Those are AO's own bookkeeping (usage,
--     controller errors), never agent memory, and hiding what AO cannot prove
--     belonged to the discarded range would be a guess.
--
-- sequence is untouched. It is assigned on insert and immutable, so turns recorded
-- after a rollback simply take higher positions and the timeline still sorts by one
-- key. Renumbering to close the gap would rewrite history to look like it never
-- happened, which is the opposite of the point.
ALTER TABLE conversation_turns ADD COLUMN rolled_back_at TIMESTAMP;
-- +goose StatementEnd

-- +goose StatementBegin
-- The thread title the provider reports, and the last one AO pushed into
-- sessions.display_name.
--
-- Two columns because they answer different questions. provider_title is what the
-- provider currently calls this thread — worth keeping even when the user has
-- overridden the AO label, since it is the name the conversation has in the
-- provider's own history. applied_title is the compare-and-set witness: AO may
-- replace a label it wrote itself, and must never replace one a person chose.
-- Holding "what I last wrote" is what makes those two cases distinguishable without
-- a second read that a manual rename could slip between.
--
-- Empty applied_title means AO has never named this session. Deliberately not a
-- title_state enum on sessions: that column belongs to the separate spawn-time
-- title design, and two owners for one provenance field is how they drift.
ALTER TABLE conversations ADD COLUMN provider_title TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN applied_title TEXT NOT NULL DEFAULT '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- SQLite in the versions AO supports cannot drop a column from a table carrying
-- partial indexes without a full rebuild. All three are additive and unread by
-- older code, so leaving them is safe on a downgrade.
SELECT 1;
-- +goose StatementEnd
