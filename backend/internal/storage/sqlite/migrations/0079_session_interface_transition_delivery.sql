-- +goose Up
-- +goose StatementBegin
-- A queued send may be retried after a daemon restart or a transient controller
-- failure. Chat controllers use this stable key to make those retries
-- idempotent; terminal delivery remains best-effort because tmux has no
-- acknowledgement/idempotency surface.
ALTER TABLE session_interface_transition_messages
    ADD COLUMN client_message_id TEXT NOT NULL DEFAULT '';

UPDATE session_interface_transition_messages
SET client_message_id = 'interface-transition:' || transition_id || ':' || id
WHERE client_message_id = '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE session_interface_transition_messages DROP COLUMN client_message_id;
-- +goose StatementEnd
