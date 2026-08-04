import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStreamEvent } from "../../types/agentStreamTypes"
import {
  coalesceAgentStreamEvents,
  createAgentStreamBatcher,
  isBatchableAgentStreamEvent,
} from "./agentStreamBatch"

function textDelta(
  sessionId: string,
  sequence: number,
  itemId: string,
  delta: string,
): AgentStreamEvent {
  return { type: 'text_delta', sessionId, sequence, itemId, delta }
}

function thinkingDelta(
  sessionId: string,
  sequence: number,
  itemId: string,
  text: string,
  mode?: 'delta' | 'replace',
): AgentStreamEvent {
  return { type: 'thinking_update', sessionId, sequence, itemId, text, mode }
}

function toolCall(sessionId: string, sequence: number): AgentStreamEvent {
  return {
    type: 'tool_call',
    sessionId,
    sequence,
    toolCallId: 'tool-1',
    title: 'Read',
  }
}

function toolUpdate(
  sessionId: string,
  sequence: number,
  status: 'pending' | 'in_progress' | 'completed' | 'failed',
  resultDelta?: string,
  toolCallId = 'tool-1',
): AgentStreamEvent {
  return {
    type: 'tool_update',
    sessionId,
    sequence,
    toolCallId,
    status,
    resultDelta,
  }
}

function done(sessionId: string, sequence: number): AgentStreamEvent {
  return { type: 'done', sessionId, sequence }
}

describe('isBatchableAgentStreamEvent', () => {
  it('batches text_delta and thinking delta/default', () => {
    expect(isBatchableAgentStreamEvent(textDelta('s', 1, 'i', 'a'))).toBe(true)
    expect(isBatchableAgentStreamEvent(thinkingDelta('s', 1, 'i', 'a'))).toBe(true)
    expect(isBatchableAgentStreamEvent(thinkingDelta('s', 1, 'i', 'a', 'delta'))).toBe(true)
  })

  it('batches progressive tool_update but not terminal tool/done/thinking replace', () => {
    expect(isBatchableAgentStreamEvent(toolUpdate('s', 1, 'pending'))).toBe(true)
    expect(isBatchableAgentStreamEvent(toolUpdate('s', 1, 'in_progress', 'tick'))).toBe(true)
    expect(isBatchableAgentStreamEvent(toolUpdate('s', 1, 'completed', 'done'))).toBe(false)
    expect(isBatchableAgentStreamEvent(toolUpdate('s', 1, 'failed', 'err'))).toBe(false)
    expect(isBatchableAgentStreamEvent(toolCall('s', 1))).toBe(false)
    expect(isBatchableAgentStreamEvent(done('s', 1))).toBe(false)
    expect(isBatchableAgentStreamEvent(thinkingDelta('s', 1, 'i', 'full', 'replace'))).toBe(false)
  })
})

describe('coalesceAgentStreamEvents', () => {
  it('merges consecutive same itemId text_delta and keeps last sequence', () => {
    const coalesced = coalesceAgentStreamEvents([
      textDelta('s1', 1, 'reply-1', 'Hello '),
      textDelta('s1', 2, 'reply-1', 'world'),
      textDelta('s1', 3, 'reply-1', '!'),
    ])
    expect(coalesced).toEqual([
      textDelta('s1', 3, 'reply-1', 'Hello world!'),
    ])
  })

  it('does not merge non-increasing sequences so reduce can ignore replays', () => {
    const coalesced = coalesceAgentStreamEvents([
      textDelta('s1', 1, 'reply-1', 'Hello '),
      textDelta('s1', 2, 'reply-1', 'world'),
      textDelta('s1', 2, 'reply-1', 'world'),
    ])
    expect(coalesced).toEqual([
      textDelta('s1', 2, 'reply-1', 'Hello world'),
      textDelta('s1', 2, 'reply-1', 'world'),
    ])
  })

  it('does not merge different itemIds or non-consecutive deltas', () => {
    const tool = toolCall('s1', 2)
    const coalesced = coalesceAgentStreamEvents([
      textDelta('s1', 1, 'a', 'A'),
      tool,
      textDelta('s1', 3, 'a', 'B'),
      textDelta('s1', 4, 'b', 'C'),
    ])
    expect(coalesced).toEqual([
      textDelta('s1', 1, 'a', 'A'),
      tool,
      textDelta('s1', 3, 'a', 'B'),
      textDelta('s1', 4, 'b', 'C'),
    ])
  })

  it('merges consecutive thinking deltas', () => {
    const coalesced = coalesceAgentStreamEvents([
      thinkingDelta('s1', 1, 't1', 'think '),
      thinkingDelta('s1', 2, 't1', 'more', 'delta'),
    ])
    expect(coalesced).toEqual([
      thinkingDelta('s1', 2, 't1', 'think more', 'delta'),
    ])
  })

  it('merges consecutive progressive tool_update resultDeltas', () => {
    const coalesced = coalesceAgentStreamEvents([
      toolUpdate('s1', 1, 'in_progress', 'Hello '),
      toolUpdate('s1', 2, 'in_progress', 'world'),
      toolUpdate('s1', 3, 'in_progress', '!'),
    ])
    expect(coalesced).toEqual([
      toolUpdate('s1', 3, 'in_progress', 'Hello world!'),
    ])
  })

  it('does not merge tool_update across different toolCallIds or terminal status', () => {
    const coalesced = coalesceAgentStreamEvents([
      toolUpdate('s1', 1, 'in_progress', 'a', 'tool-a'),
      toolUpdate('s1', 2, 'in_progress', 'b', 'tool-b'),
      toolUpdate('s1', 3, 'in_progress', 'c', 'tool-b'),
      toolUpdate('s1', 4, 'completed', 'done', 'tool-b'),
    ])
    expect(coalesced).toEqual([
      toolUpdate('s1', 1, 'in_progress', 'a', 'tool-a'),
      toolUpdate('s1', 3, 'in_progress', 'bc', 'tool-b'),
      toolUpdate('s1', 4, 'completed', 'done', 'tool-b'),
    ])
  })
})

describe('createAgentStreamBatcher', () => {
  let scheduled: Array<() => void> = []
  let onFlush: ReturnType<typeof vi.fn<(sessionId: string, events: AgentStreamEvent[]) => void>>

  afterEach(() => {
    scheduled = []
    vi.useRealTimers()
  })

  function createTestBatcher(overrides?: { maxWaitMs?: number }) {
    onFlush = vi.fn<(sessionId: string, events: AgentStreamEvent[]) => void>()
    scheduled = []
    return createAgentStreamBatcher({
      onFlush,
      // Disable max-wait by default so existing tests control flush via schedule only.
      maxWaitMs: 0,
      schedule: (flush) => {
        scheduled.push(flush)
        return scheduled.length - 1
      },
      cancelSchedule: (handle) => {
        const idx = handle as number
        scheduled[idx] = () => {}
      },
      ...overrides,
    })
  }

  it('does not flush text_delta until schedule runs; coalesces on flush', () => {
    const batcher = createTestBatcher()
    batcher.push(textDelta('s1', 1, 'reply-1', 'Hello '))
    batcher.push(textDelta('s1', 2, 'reply-1', 'world'))

    expect(onFlush).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)

    scheduled[0]()

    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush).toHaveBeenCalledWith('s1', [
      textDelta('s1', 2, 'reply-1', 'Hello world'),
    ])
    batcher.dispose()
  })

  it('flushes immediately on tool_call including prior pending deltas', () => {
    const batcher = createTestBatcher()
    batcher.push(textDelta('s1', 1, 'reply-1', 'Hi'))
    expect(onFlush).not.toHaveBeenCalled()

    batcher.push(toolCall('s1', 2))

    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush).toHaveBeenCalledWith('s1', [
      textDelta('s1', 1, 'reply-1', 'Hi'),
      toolCall('s1', 2),
    ])
    // cancelled the pending schedule
    scheduled[0]()
    expect(onFlush).toHaveBeenCalledTimes(1)
    batcher.dispose()
  })

  it('batches progressive tool_update until schedule; completed flushes immediately', () => {
    const batcher = createTestBatcher()
    batcher.push(toolUpdate('s1', 1, 'in_progress', 'tick '))
    batcher.push(toolUpdate('s1', 2, 'in_progress', 'tock'))
    expect(onFlush).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)

    scheduled[0]()
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush).toHaveBeenCalledWith('s1', [
      toolUpdate('s1', 2, 'in_progress', 'tick tock'),
    ])

    batcher.push(toolUpdate('s1', 3, 'in_progress', 'more'))
    expect(onFlush).toHaveBeenCalledTimes(1)
    batcher.push(toolUpdate('s1', 4, 'completed', 'done'))
    expect(onFlush).toHaveBeenCalledTimes(2)
    expect(onFlush.mock.calls[1][1]).toEqual([
      toolUpdate('s1', 3, 'in_progress', 'more'),
      toolUpdate('s1', 4, 'completed', 'done'),
    ])
    batcher.dispose()
  })

  it('flushes immediately on done', () => {
    const batcher = createTestBatcher()
    batcher.push(textDelta('s1', 1, 'reply-1', 'x'))
    batcher.push(done('s1', 2))
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush.mock.calls[0][1]).toEqual([
      textDelta('s1', 1, 'reply-1', 'x'),
      done('s1', 2),
    ])
    batcher.dispose()
  })

  it('flushes immediately on thinking mode replace', () => {
    const batcher = createTestBatcher()
    batcher.push(thinkingDelta('s1', 1, 't1', 'partial'))
    expect(onFlush).not.toHaveBeenCalled()
    batcher.push(thinkingDelta('s1', 2, 't1', 'full', 'replace'))
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush.mock.calls[0][1]).toEqual([
      thinkingDelta('s1', 1, 't1', 'partial'),
      thinkingDelta('s1', 2, 't1', 'full', 'replace'),
    ])
    batcher.dispose()
  })

  it('keeps independent queues per session', () => {
    const batcher = createTestBatcher()
    batcher.push(textDelta('s1', 1, 'a', 'A'))
    batcher.push(textDelta('s2', 1, 'b', 'B'))
    expect(scheduled).toHaveLength(2)
    expect(onFlush).not.toHaveBeenCalled()

    scheduled[0]()
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush).toHaveBeenCalledWith('s1', [textDelta('s1', 1, 'a', 'A')])

    scheduled[1]()
    expect(onFlush).toHaveBeenCalledTimes(2)
    expect(onFlush).toHaveBeenLastCalledWith('s2', [textDelta('s2', 1, 'b', 'B')])
    batcher.dispose()
  })

  it('flush(sessionId) drains one session; flush() drains all', () => {
    const batcher = createTestBatcher()
    batcher.push(textDelta('s1', 1, 'a', 'A'))
    batcher.push(textDelta('s2', 1, 'b', 'B'))

    batcher.flush('s1')
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush).toHaveBeenCalledWith('s1', [textDelta('s1', 1, 'a', 'A')])

    batcher.flush()
    expect(onFlush).toHaveBeenCalledTimes(2)
    expect(onFlush).toHaveBeenLastCalledWith('s2', [textDelta('s2', 1, 'b', 'B')])
    batcher.dispose()
  })

  it('dispose drops pending without calling onFlush', () => {
    const batcher = createTestBatcher()
    batcher.push(textDelta('s1', 1, 'a', 'A'))
    batcher.dispose()
    scheduled[0]()
    expect(onFlush).not.toHaveBeenCalled()
    batcher.push(textDelta('s1', 2, 'a', 'B'))
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('flushes via maxWait when frame schedule is delayed (rAF starved)', () => {
    vi.useFakeTimers()
    const batcher = createTestBatcher({ maxWaitMs: 40 })
    batcher.push(textDelta('s1', 1, 'reply-1', 'Hello '))
    batcher.push(textDelta('s1', 2, 'reply-1', 'world'))

    expect(onFlush).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)

    // Simulate Electron background: rAF never fires, max-wait wins
    vi.advanceTimersByTime(39)
    expect(onFlush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush).toHaveBeenCalledWith('s1', [
      textDelta('s1', 2, 'reply-1', 'Hello world'),
    ])

    // Late rAF must be a no-op (cancelled when max-wait flushed)
    scheduled[0]()
    expect(onFlush).toHaveBeenCalledTimes(1)
    batcher.dispose()
  })

  it('cancel on schedule flush also clears maxWait so timer does not double-flush', () => {
    vi.useFakeTimers()
    const batcher = createTestBatcher({ maxWaitMs: 40 })
    batcher.push(textDelta('s1', 1, 'reply-1', 'Hi'))

    // Frame schedule wins first
    scheduled[0]()
    expect(onFlush).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(100)
    expect(onFlush).toHaveBeenCalledTimes(1)
    batcher.dispose()
  })
})
