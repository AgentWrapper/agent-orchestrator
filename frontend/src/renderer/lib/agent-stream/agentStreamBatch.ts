import type { AgentStreamEvent } from "../../types/agentStreamTypes"

export type AgentStreamBatchScheduleHandle = unknown

export type AgentStreamBatchSchedule = (
  flush: () => void,
) => AgentStreamBatchScheduleHandle

export type AgentStreamBatchCancelSchedule = (
  handle: AgentStreamBatchScheduleHandle,
) => void

export interface AgentStreamBatcherOptions {
  onFlush: (sessionId: string, events: AgentStreamEvent[]) => void
  schedule?: AgentStreamBatchSchedule
  cancelSchedule?: AgentStreamBatchCancelSchedule
  /**
   * Max wait before flush if the frame schedule is delayed (e.g. Electron
   * background rAF throttle). Whichever fires first (schedule vs timer) flushes.
   * Default 48ms. Set to 0 or negative to disable.
   */
  maxWaitMs?: number
}

export interface AgentStreamBatcher {
  push(event: AgentStreamEvent): void
  flush(sessionId?: string): void
  dispose(): void
}

/** Default max-wait so text_delta still lands when rAF is starved. */
export const AGENT_STREAM_BATCH_MAX_WAIT_MS = 48

interface SessionScheduleEntry {
  scheduleHandle: AgentStreamBatchScheduleHandle
  maxWaitId?: ReturnType<typeof setTimeout>
}

/**
 * Events that can wait for the next animation frame before reducing into the store.
 *
 * ~1 store update per display frame is intentional: further coalescing would add
 * visible latency without a smoother UI (paint already caps at display refresh).
 * Terminal tool/status events still flush immediately via push().
 */
export function isBatchableAgentStreamEvent(event: AgentStreamEvent): boolean {
  if (event.type === 'text_delta') return true
  if (event.type === 'thinking_update') {
    // replace must land immediately so partial thinking is not merged incorrectly
    return event.mode !== 'replace'
  }
  // Progressive tool output is high-frequency (stdout ticks); completed/failed must land now.
  if (event.type === 'tool_update') {
    return event.status === 'pending' || event.status === 'in_progress'
  }
  return false
}

function mergeToolUpdateOutput(
  prev: Extract<AgentStreamEvent, { type: 'tool_update' }>,
  next: Extract<AgentStreamEvent, { type: 'tool_update' }>,
): Extract<AgentStreamEvent, { type: 'tool_update' }>['output'] | undefined {
  if (!prev.output && !next.output) return undefined
  if (!prev.output) return next.output
  if (!next.output) return prev.output
  // Different streams: prefer the later chunk so reduce keeps stream identity.
  if (prev.output.stream !== next.output.stream) return next.output
  return {
    stream: next.output.stream,
    text: `${prev.output.text || ''}${next.output.text || ''}`,
  }
}

/**
 * Merge consecutive same-session+itemId text/thinking deltas, and progressive tool_update.
 * lastSequence contract: coalesced event.sequence is the last real event's sequence.
 * Only merges strictly increasing sequences so replay/duplicate events stay separate
 * for reduceAgentStreamEvent to ignore.
 */
export function coalesceAgentStreamEvents(events: AgentStreamEvent[]): AgentStreamEvent[] {
  if (events.length <= 1) return events

  const out: AgentStreamEvent[] = []
  for (const event of events) {
    const prev = out[out.length - 1]
    if (
      prev
      && prev.type === 'text_delta'
      && event.type === 'text_delta'
      && prev.sessionId === event.sessionId
      && prev.itemId === event.itemId
      && event.sequence > prev.sequence
    ) {
      out[out.length - 1] = {
        ...event,
        delta: `${prev.delta}${event.delta}`,
      }
      continue
    }
    if (
      prev
      && prev.type === 'thinking_update'
      && event.type === 'thinking_update'
      && prev.sessionId === event.sessionId
      && prev.itemId === event.itemId
      && prev.mode !== 'replace'
      && event.mode !== 'replace'
      && event.sequence > prev.sequence
    ) {
      out[out.length - 1] = {
        ...event,
        text: `${prev.text}${event.text}`,
      }
      continue
    }
    if (
      prev
      && prev.type === 'tool_update'
      && event.type === 'tool_update'
      && prev.sessionId === event.sessionId
      && prev.toolCallId === event.toolCallId
      && event.sequence > prev.sequence
      && isBatchableAgentStreamEvent(prev)
      && isBatchableAgentStreamEvent(event)
    ) {
      const mergedResultDelta = `${prev.resultDelta || ''}${event.resultDelta || ''}`
      const mergedOutput = mergeToolUpdateOutput(prev, event)
      out[out.length - 1] = {
        ...event,
        // Later event wins status/name/title/input/error; append progressive payloads.
        resultDelta: mergedResultDelta || undefined,
        output: mergedOutput,
      }
      continue
    }
    out.push(event)
  }
  return out
}

function defaultSchedule(flush: () => void): AgentStreamBatchScheduleHandle {
  if (typeof requestAnimationFrame === 'function') {
    return { kind: 'raf' as const, id: requestAnimationFrame(flush) }
  }
  if (typeof queueMicrotask === 'function') {
    const token = { cancelled: false }
    queueMicrotask(() => {
      if (!token.cancelled) flush()
    })
    return { kind: 'micro' as const, token }
  }
  return { kind: 'timeout' as const, id: setTimeout(flush, 0) }
}

function defaultCancelSchedule(handle: AgentStreamBatchScheduleHandle): void {
  if (!handle || typeof handle !== 'object') return
  const h = handle as { kind?: string; id?: number | ReturnType<typeof setTimeout>; token?: { cancelled: boolean } }
  if (h.kind === 'raf' && typeof h.id === 'number' && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(h.id)
    return
  }
  if (h.kind === 'micro' && h.token) {
    h.token.cancelled = true
    return
  }
  if (h.kind === 'timeout' && h.id !== undefined) {
    clearTimeout(h.id as ReturnType<typeof setTimeout>)
  }
}

export function createAgentStreamBatcher(options: AgentStreamBatcherOptions): AgentStreamBatcher {
  const schedule = options.schedule ?? defaultSchedule
  const cancelSchedule = options.cancelSchedule ?? defaultCancelSchedule
  const maxWaitMs = options.maxWaitMs ?? AGENT_STREAM_BATCH_MAX_WAIT_MS
  const pending = new Map<string, AgentStreamEvent[]>()
  const scheduled = new Map<string, SessionScheduleEntry>()
  let disposed = false

  const clearSchedule = (sessionId: string) => {
    const entry = scheduled.get(sessionId)
    if (entry === undefined) return
    scheduled.delete(sessionId)
    cancelSchedule(entry.scheduleHandle)
    if (entry.maxWaitId !== undefined) {
      clearTimeout(entry.maxWaitId)
    }
  }

  const flushSession = (sessionId: string) => {
    clearSchedule(sessionId)
    const events = pending.get(sessionId)
    if (!events || events.length === 0) {
      pending.delete(sessionId)
      return
    }
    pending.delete(sessionId)
    const coalesced = coalesceAgentStreamEvents(events)
    options.onFlush(sessionId, coalesced)
  }

  const armSchedule = (sessionId: string) => {
    if (scheduled.has(sessionId)) return

    const run = () => {
      if (disposed) return
      // clearSchedule inside flushSession cancels the peer (rAF or max-wait)
      flushSession(sessionId)
    }

    const scheduleHandle = schedule(run)
    let maxWaitId: ReturnType<typeof setTimeout> | undefined
    if (maxWaitMs > 0) {
      maxWaitId = setTimeout(run, maxWaitMs)
    }
    scheduled.set(sessionId, { scheduleHandle, maxWaitId })
  }

  return {
    push(event: AgentStreamEvent) {
      if (disposed) return
      const sessionId = event.sessionId
      const queue = pending.get(sessionId)
      if (queue) {
        queue.push(event)
      } else {
        pending.set(sessionId, [event])
      }

      if (!isBatchableAgentStreamEvent(event)) {
        flushSession(sessionId)
        return
      }

      armSchedule(sessionId)
    },

    flush(sessionId?: string) {
      if (disposed) return
      if (sessionId !== undefined) {
        flushSession(sessionId)
        return
      }
      for (const id of [...pending.keys()]) {
        flushSession(id)
      }
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const id of [...scheduled.keys()]) {
        clearSchedule(id)
      }
      pending.clear()
    },
  }
}
