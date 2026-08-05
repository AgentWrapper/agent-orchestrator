-- +goose Up
-- +goose StatementBegin
-- A mode change is a durable saga: the old external process must stop before
-- the new one starts, and neither operation can share a SQLite transaction.
-- This row is the recovery/checkpoint record and the cross-client operation
-- gate. The sessions.session_mode column remains the committed dispatcher.
CREATE TABLE session_interface_transitions (
    id                       TEXT PRIMARY KEY,
    session_id               TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source_mode              TEXT NOT NULL CHECK (source_mode IN ('chat', 'tui')),
    target_mode              TEXT NOT NULL CHECK (target_mode IN ('chat', 'tui')),
    policy                   TEXT NOT NULL CHECK (policy IN ('drain', 'interrupt')),
    phase                    TEXT NOT NULL CHECK (phase IN (
        'requested', 'preflighting', 'draining', 'source_stopping',
        'source_stopped', 'target_starting', 'activating',
        'completed', 'failed', 'cancelled', 'recovery_required'
    )),
    native_conversation_id   TEXT NOT NULL DEFAULT '',
    error_code               TEXT NOT NULL DEFAULT '',
    error_detail             TEXT NOT NULL DEFAULT '',
    created_at               TIMESTAMP NOT NULL,
    updated_at               TIMESTAMP NOT NULL,
    completed_at             TIMESTAMP,
    CHECK (source_mode <> target_mode)
);

-- One process owns the handoff. A finished attempt remains as diagnostics and
-- does not prevent a later switch back.
CREATE UNIQUE INDEX idx_session_interface_transition_active
    ON session_interface_transitions(session_id)
    WHERE phase NOT IN ('completed', 'failed', 'cancelled', 'recovery_required');
CREATE INDEX idx_session_interface_transition_history
    ON session_interface_transitions(session_id, created_at DESC);
-- +goose StatementEnd

-- +goose StatementBegin
-- Lifecycle/automation messages arriving during the no-controller gap are not
-- discarded. Session Manager drains this outbox through the newly committed
-- controller after activation.
CREATE TABLE session_interface_transition_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    transition_id   TEXT NOT NULL REFERENCES session_interface_transitions(id) ON DELETE CASCADE,
    message         TEXT NOT NULL,
    created_at      TIMESTAMP NOT NULL,
    delivered_at    TIMESTAMP
);
CREATE INDEX idx_session_interface_transition_messages_pending
    ON session_interface_transition_messages(transition_id, id)
    WHERE delivered_at IS NULL;
-- +goose StatementEnd

-- +goose StatementBegin
-- Transition changes are invalidations, like conversation changes. Clients use
-- the existing session_updated stream and refetch the bounded transition row.
CREATE TRIGGER session_interface_transitions_cdc_insert
AFTER INSERT ON session_interface_transitions
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    SELECT s.project_id, s.id, 'session_updated',
           json_object('id', s.id, 'sessionId', s.id,
                       'interfaceTransitionId', NEW.id,
                       'interfaceTransitionPhase', NEW.phase,
                       'activity', s.activity_state,
                       'isTerminated', json(CASE WHEN s.is_terminated THEN 'true' ELSE 'false' END)),
           NEW.updated_at
    FROM sessions s WHERE s.id = NEW.session_id;
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER session_interface_transitions_cdc_update
AFTER UPDATE ON session_interface_transitions
WHEN OLD.phase <> NEW.phase
    OR OLD.error_code <> NEW.error_code
    OR OLD.error_detail <> NEW.error_detail
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    SELECT s.project_id, s.id, 'session_updated',
           json_object('id', s.id, 'sessionId', s.id,
                       'interfaceTransitionId', NEW.id,
                       'interfaceTransitionPhase', NEW.phase,
                       'activity', s.activity_state,
                       'isTerminated', json(CASE WHEN s.is_terminated THEN 'true' ELSE 'false' END)),
           NEW.updated_at
    FROM sessions s WHERE s.id = NEW.session_id;
END;
-- +goose StatementEnd

-- +goose StatementBegin
-- session_mode now changes at the explicit controller-epoch boundary, so mode
-- joins the existing session invalidation trigger. All conditions and payload
-- fields added through 0043 (including pinning) remain intact.
DROP TRIGGER IF EXISTS sessions_cdc_update;
CREATE TRIGGER sessions_cdc_update
AFTER UPDATE ON sessions
WHEN OLD.activity_state <> NEW.activity_state
    OR OLD.is_terminated <> NEW.is_terminated
    OR (OLD.first_signal_at IS NULL AND NEW.first_signal_at IS NOT NULL)
    OR OLD.preview_url <> NEW.preview_url
    OR OLD.preview_revision <> NEW.preview_revision
    OR OLD.display_name <> NEW.display_name
    OR OLD.terminate_on_pr_merge <> NEW.terminate_on_pr_merge
    OR OLD.is_pinned <> NEW.is_pinned
    OR OLD.pinned_at <> NEW.pinned_at
    OR (OLD.pinned_at IS NULL AND NEW.pinned_at IS NOT NULL)
    OR (OLD.pinned_at IS NOT NULL AND NEW.pinned_at IS NULL)
    OR OLD.session_mode <> NEW.session_mode
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NEW.id, 'session_updated',
        json_object(
            'id', NEW.id,
            'activity', NEW.activity_state,
            'isTerminated', json(CASE WHEN NEW.is_terminated THEN 'true' ELSE 'false' END),
            'terminateOnPrMerge', json(CASE WHEN NEW.terminate_on_pr_merge THEN 'true' ELSE 'false' END),
            'previewUrl', NEW.preview_url,
            'previewRevision', NEW.preview_revision,
            'isPinned', json(CASE WHEN NEW.is_pinned THEN 'true' ELSE 'false' END),
            'mode', NEW.session_mode
        ),
        NEW.updated_at);
END;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS session_interface_transitions_cdc_update;
DROP TRIGGER IF EXISTS session_interface_transitions_cdc_insert;
DROP TABLE IF EXISTS session_interface_transition_messages;
DROP TABLE IF EXISTS session_interface_transitions;
-- +goose StatementEnd

-- +goose StatementBegin
DROP TRIGGER IF EXISTS sessions_cdc_update;
CREATE TRIGGER sessions_cdc_update
AFTER UPDATE ON sessions
WHEN OLD.activity_state <> NEW.activity_state
    OR OLD.is_terminated <> NEW.is_terminated
    OR (OLD.first_signal_at IS NULL AND NEW.first_signal_at IS NOT NULL)
    OR OLD.preview_url <> NEW.preview_url
    OR OLD.preview_revision <> NEW.preview_revision
    OR OLD.display_name <> NEW.display_name
    OR OLD.terminate_on_pr_merge <> NEW.terminate_on_pr_merge
    OR OLD.is_pinned <> NEW.is_pinned
    OR OLD.pinned_at <> NEW.pinned_at
    OR (OLD.pinned_at IS NULL AND NEW.pinned_at IS NOT NULL)
    OR (OLD.pinned_at IS NOT NULL AND NEW.pinned_at IS NULL)
BEGIN
    INSERT INTO change_log (project_id, session_id, event_type, payload, created_at)
    VALUES (NEW.project_id, NEW.id, 'session_updated',
        json_object(
            'id', NEW.id,
            'activity', NEW.activity_state,
            'isTerminated', json(CASE WHEN NEW.is_terminated THEN 'true' ELSE 'false' END),
            'terminateOnPrMerge', json(CASE WHEN NEW.terminate_on_pr_merge THEN 'true' ELSE 'false' END),
            'previewUrl', NEW.preview_url,
            'previewRevision', NEW.preview_revision,
            'isPinned', json(CASE WHEN NEW.is_pinned THEN 'true' ELSE 'false' END)
        ),
        NEW.updated_at);
END;
-- +goose StatementEnd
