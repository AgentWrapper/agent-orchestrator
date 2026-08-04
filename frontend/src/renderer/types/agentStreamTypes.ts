export type AgentStreamSource =
  | { kind: 'native-acp-v1'; provider?: string }
  | { kind: 'legacy-adapter'; provider?: string }

export type AgentStreamPhase =
  | 'idle'
  | 'running'
  | 'waiting_permission'
  | 'cancelling'
  | 'done'
  | 'error'
  | 'cancelled'

export type AgentPlanEntryStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

export interface AgentPlanEntry {
  id: string
  title: string
  status: AgentPlanEntryStatus
}

export interface AgentPlan {
  title?: string
  entries: AgentPlanEntry[]
}

export type AgentPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always'

export interface AgentPermissionOption {
  optionId: string
  label: string
  kind: AgentPermissionOptionKind
}

export interface AgentPermissionRequest {
  requestId: string
  toolCallId?: string
  title: string
  description?: string
  options: AgentPermissionOption[]
}

interface AgentStreamEventBase {
  sessionId: string
  /** Monotonic within a session. Replayed or duplicate sequence numbers are ignored. */
  sequence: number
  timestamp?: string
  source?: AgentStreamSource
}

export type AgentStreamEvent =
  | (AgentStreamEventBase & {
      type: 'text_delta'
      itemId: string
      delta: string
    })
  | (AgentStreamEventBase & {
      type: 'thinking_update'
      itemId: string
      text: string
      mode?: 'delta' | 'replace'
    })
  | (AgentStreamEventBase & {
      type: 'tool_call'
      toolCallId: string
      name?: string
      title: string
      input?: Record<string, unknown>
    })
  | (AgentStreamEventBase & {
      type: 'tool_update'
      toolCallId: string
      status: 'pending' | 'in_progress' | 'completed' | 'failed'
      name?: string
      title?: string
      input?: Record<string, unknown>
      resultDelta?: string
      output?: { stream: 'stdout' | 'stderr'; text: string }
      error?: string
    })
  | (AgentStreamEventBase & {
      type: 'plan'
      title?: string
      entries: AgentPlanEntry[]
    })
  | (AgentStreamEventBase & {
      type: 'status'
      status: 'starting' | 'running' | 'waiting' | 'idle'
      message?: string
    })
  | (AgentStreamEventBase & {
      type: 'permission_request'
      request: AgentPermissionRequest
    })
  | (AgentStreamEventBase & {
      type: 'done'
      stopReason?: string
    })
  | (AgentStreamEventBase & {
      type: 'error'
      message: string
    })
  | (AgentStreamEventBase & {
      type: 'cancelled'
      reason?: string
    })

export interface AgentSessionStreamState {
  phase: AgentStreamPhase
  lastSequence: number
  /** Epoch ms of the last successfully applied agent:stream event. Used for fail-open silence. */
  lastEventAt?: number
  statusMessage?: string
  plan?: AgentPlan
  permission?: AgentPermissionRequest
  terminalReason?: string
}

export interface AgentPermissionResponse {
  sessionId: string
  requestId: string
  optionId: string
}
