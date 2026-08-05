-- name: InsertSessionInterfaceTransition :one
INSERT INTO session_interface_transitions (
    id, session_id, source_mode, target_mode, policy, phase,
    native_conversation_id, error_code, error_detail,
    created_at, updated_at, completed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, NULL)
RETURNING id, session_id, source_mode, target_mode, policy, phase,
          native_conversation_id, error_code, error_detail,
          created_at, updated_at, completed_at;

-- name: GetSessionInterfaceTransition :one
SELECT id, session_id, source_mode, target_mode, policy, phase,
       native_conversation_id, error_code, error_detail,
       created_at, updated_at, completed_at
FROM session_interface_transitions
WHERE id = ?;

-- name: GetActiveSessionInterfaceTransition :one
SELECT id, session_id, source_mode, target_mode, policy, phase,
       native_conversation_id, error_code, error_detail,
       created_at, updated_at, completed_at
FROM session_interface_transitions
WHERE session_id = ?
  AND phase NOT IN ('completed', 'failed', 'cancelled', 'recovery_required')
ORDER BY created_at DESC
LIMIT 1;

-- name: GetLatestSessionInterfaceTransition :one
SELECT id, session_id, source_mode, target_mode, policy, phase,
       native_conversation_id, error_code, error_detail,
       created_at, updated_at, completed_at
FROM session_interface_transitions
WHERE session_id = ?
ORDER BY created_at DESC
LIMIT 1;

-- name: ListActiveSessionInterfaceTransitions :many
SELECT id, session_id, source_mode, target_mode, policy, phase,
       native_conversation_id, error_code, error_detail,
       created_at, updated_at, completed_at
FROM session_interface_transitions
WHERE phase NOT IN ('completed', 'failed', 'cancelled', 'recovery_required')
ORDER BY created_at;

-- name: AdvanceSessionInterfaceTransition :execrows
UPDATE session_interface_transitions
SET phase = ?, native_conversation_id = ?, error_code = ?, error_detail = ?,
    updated_at = ?, completed_at = ?
WHERE id = ? AND phase = ?;

-- name: SwitchSessionControllerMode :execrows
UPDATE sessions
SET session_mode = ?,
    runtime_handle_id = '',
    runtime_launch_id = '',
    agent_session_id = ?,
    provider_conversation_id = ?,
    controller_generation = '',
    activity_state = 'idle',
    activity_last_at = ?,
    updated_at = ?
WHERE id = ? AND session_mode = ? AND is_terminated = 0;

-- name: EnqueueSessionInterfaceTransitionMessage :exec
INSERT INTO session_interface_transition_messages (transition_id, message, created_at)
VALUES (?, ?, ?);

-- name: ListPendingSessionInterfaceTransitionMessages :many
SELECT id, transition_id, message, created_at, delivered_at
FROM session_interface_transition_messages
WHERE transition_id = ? AND delivered_at IS NULL
ORDER BY id;

-- name: MarkSessionInterfaceTransitionMessageDelivered :execrows
UPDATE session_interface_transition_messages
SET delivered_at = ?
WHERE id = ? AND delivered_at IS NULL;
