import { describe, expect, it } from "vitest";
import type { StreamMessage } from "../../types/streamMessages";
import {
  AGENT_STREAM_SILENCE_MS,
  annotateLivePartialFlags,
  convergeAgentStreamOnLegacyEnd,
  createAgentSessionStreamState,
  isAgentStreamActive,
  reduceAgentStreamEvent,
  shouldPreferAgentStream,
} from "./agentStreamCore"

describe('agentStreamCore', () => {
  it('appends text deltas once and ignores replayed sequence numbers', () => {
    const first = reduceAgentStreamEvent([], undefined, {
      type: 'text_delta', sessionId: 'session-1', sequence: 1, itemId: 'reply-1', delta: 'Hello ',
    })
    const second = reduceAgentStreamEvent(first.messages, first.stream, {
      type: 'text_delta', sessionId: 'session-1', sequence: 2, itemId: 'reply-1', delta: 'world',
    })
    const replay = reduceAgentStreamEvent(second.messages, second.stream, {
      type: 'text_delta', sessionId: 'session-1', sequence: 2, itemId: 'reply-1', delta: 'world',
    })

    expect(second.messages).toHaveLength(1)
    expect(second.messages[0].content).toBe('Hello world')
    expect(replay.ignored).toBe(true)
    expect(replay.messages).toBe(second.messages)
    expect(typeof second.stream.lastEventAt).toBe('number')
    expect(shouldPreferAgentStream(second.stream)).toBe(true)
  })

  it('stamps lastEventAt and fails open after silence timeout', () => {
    const applied = reduceAgentStreamEvent([], undefined, {
      type: 'text_delta',
      sessionId: 'session-1',
      sequence: 1,
      itemId: 'reply-1',
      delta: 'hi',
      timestamp: '2026-01-01T00:00:00.000Z',
    })
    expect(applied.stream.lastEventAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'))
    expect(isAgentStreamActive(applied.stream)).toBe(true)
    expect(shouldPreferAgentStream(applied.stream, applied.stream.lastEventAt! + 1000)).toBe(true)
    expect(shouldPreferAgentStream(
      applied.stream,
      applied.stream.lastEventAt! + AGENT_STREAM_SILENCE_MS,
    )).toBe(false)

    // Missing lastEventAt still prefers an active stream (safe default).
    expect(shouldPreferAgentStream({ phase: 'running', lastSequence: 1 })).toBe(true)
    expect(convergeAgentStreamOnLegacyEnd(applied.stream)).toEqual(expect.objectContaining({
      phase: 'done',
      permission: undefined,
      plan: undefined,
      statusMessage: undefined,
    }))
    expect(convergeAgentStreamOnLegacyEnd({ phase: 'done', lastSequence: 1 })).toBeUndefined()
  })

  it('opens a new assistant bubble after a turn is finalized (multi-turn)', () => {
    const first = reduceAgentStreamEvent([], undefined, {
      type: 'text_delta', sessionId: 'session-1', sequence: 1, itemId: 'reply-1', delta: '回复1',
    })
    const done = reduceAgentStreamEvent(first.messages, first.stream, {
      type: 'done', sessionId: 'session-1', sequence: 2, stopReason: 'end_turn',
    })
    expect(done.messages).toHaveLength(1)
    expect(done.messages[0]).toEqual(expect.objectContaining({
      role: 'assistant', content: '回复1', partial: false,
    }))

    // Later work in the same session must not reopen the finalized bubble.
    const third = reduceAgentStreamEvent(done.messages, done.stream, {
      type: 'text_delta', sessionId: 'session-1', sequence: 3, itemId: 'reply-3', delta: '回复3',
    })
    expect(third.messages).toHaveLength(2)
    expect(third.messages[0]).toEqual(expect.objectContaining({
      role: 'assistant', content: '回复1', partial: false,
    }))
    expect(third.messages[1]).toEqual(expect.objectContaining({
      role: 'assistant', content: '回复3', partial: true,
    }))
  })

  it('does not reopen a finalized assistant bubble even when itemId matches', () => {
    const first = reduceAgentStreamEvent([], undefined, {
      type: 'text_delta', sessionId: 'session-1', sequence: 1, itemId: 'same-item', delta: '第一段',
    })
    const done = reduceAgentStreamEvent(first.messages, first.stream, {
      type: 'done', sessionId: 'session-1', sequence: 2, stopReason: 'end_turn',
    })
    const again = reduceAgentStreamEvent(done.messages, done.stream, {
      type: 'text_delta', sessionId: 'session-1', sequence: 3, itemId: 'same-item', delta: '第二段',
    })

    expect(again.messages).toHaveLength(2)
    expect(again.messages[0].content).toBe('第一段')
    expect(again.messages[1].content).toBe('第二段')
  })

  it('opens a new assistant bubble after tools even when itemId is reused', () => {
    // Providers often keep one default text itemId for the whole turn.
    const first = reduceAgentStreamEvent([], undefined, {
      type: 'text_delta', sessionId: 'session-1', sequence: 1, itemId: 'assistant-text',
      delta: '先查工具组折叠逻辑。',
    })
    const tool = reduceAgentStreamEvent(first.messages, first.stream, {
      type: 'tool_call', sessionId: 'session-1', sequence: 2,
      toolCallId: 'tool-1', title: 'grep', name: 'Grep',
    })
    const second = reduceAgentStreamEvent(tool.messages, tool.stream, {
      type: 'text_delta', sessionId: 'session-1', sequence: 3, itemId: 'assistant-text',
      delta: '根因是默认折叠，正在改为自动展开。',
    })

    const assistants = second.messages.filter(message => message.role === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants[0]).toEqual(expect.objectContaining({
      content: '先查工具组折叠逻辑。',
      partial: false,
    }))
    expect(assistants[1]).toEqual(expect.objectContaining({
      content: '根因是默认折叠，正在改为自动展开。',
      partial: true,
    }))
    // Tool sits between the two reply bubbles.
    expect(second.messages.map(message => message.role)).toEqual([
      'assistant', 'tool_use', 'assistant',
    ])
  })

  it('does not grow an earlier partial bubble when tools sit after it', () => {
    const first = reduceAgentStreamEvent([], undefined, {
      type: 'text_delta', sessionId: 'session-1', sequence: 1, itemId: 'assistant-text', delta: '回复A',
    })
    // Simulate a tool message already after the open bubble without sealing
    // via tool_call (defensive: trailing-only merge must still hold).
    const withTool = {
      messages: [
        ...first.messages,
        {
          role: 'tool_use',
          content: 'shell',
          partial: false,
          toolUseId: 'tool-x',
          toolName: 'Bash',
        } as StreamMessage,
      ],
      stream: first.stream,
    }
    const second = reduceAgentStreamEvent(withTool.messages, withTool.stream, {
      type: 'text_delta', sessionId: 'session-1', sequence: 2, itemId: 'assistant-text', delta: '回复B',
    })

    expect(second.messages.filter(message => message.role === 'assistant')).toHaveLength(2)
    expect(second.messages[0].content).toBe('回复A')
    expect(second.messages[2].content).toBe('回复B')
  })

  it('supports replace-style thinking updates without duplicating text', () => {
    const first = reduceAgentStreamEvent([], undefined, {
      type: 'thinking_update', sessionId: 'session-1', sequence: 1, itemId: 'thought-1', text: 'Checking', mode: 'replace',
    })
    const second = reduceAgentStreamEvent(first.messages, first.stream, {
      type: 'thinking_update', sessionId: 'session-1', sequence: 2, itemId: 'thought-1', text: 'Checking files', mode: 'replace',
    })

    expect(second.messages).toHaveLength(1)
    expect(second.messages[0]).toEqual(expect.objectContaining({
      role: 'thinking', content: 'Checking files', isThinking: true, partial: true,
    }))
  })

  it('correlates tool output with its call and finalizes the lifecycle', () => {
    const call = reduceAgentStreamEvent([], undefined, {
      type: 'tool_call', sessionId: 'session-1', sequence: 1,
      toolCallId: 'tool-1', title: 'Run tests', name: 'shell', input: { command: 'npm test' },
    })
    expect(call.messages[0]).toEqual(expect.objectContaining({
      role: 'tool_use', toolUseId: 'tool-1', toolStatus: 'pending', partial: true, isDelta: true,
    }))
    const output = reduceAgentStreamEvent(call.messages, call.stream, {
      type: 'tool_update', sessionId: 'session-1', sequence: 2,
      toolCallId: 'tool-1', status: 'in_progress', output: { stream: 'stdout', text: 'PASS\n' },
    })
    expect(output.messages[0]).toEqual(expect.objectContaining({
      role: 'tool_use', toolStatus: 'in_progress', partial: true, isDelta: true,
    }))
    const complete = reduceAgentStreamEvent(output.messages, output.stream, {
      type: 'tool_update', sessionId: 'session-1', sequence: 3,
      toolCallId: 'tool-1', status: 'completed', resultDelta: 'Done',
    })

    expect(complete.messages).toHaveLength(2)
    expect(complete.messages[0]).toEqual(expect.objectContaining({
      role: 'tool_use', toolUseId: 'tool-1', toolStatus: 'completed', partial: false, isDelta: false,
    }))
    expect(complete.messages[1]).toEqual(expect.objectContaining({
      role: 'tool_result', toolUseId: 'tool-1', toolResult: 'PASS\nDone', isDelta: false, partial: false,
    }))
  })

  it('tool_update completed sets toolStatus=completed and partial=false on tool_use and tool_result', () => {
    const complete = reduceAgentStreamEvent([], undefined, {
      type: 'tool_update',
      sessionId: 'session-1',
      sequence: 1,
      toolCallId: 'mcp-wait-1',
      name: 'wait_agent_idle',
      status: 'completed',
      resultDelta: 'idle',
    })

    expect(complete.messages).toHaveLength(2)
    expect(complete.messages[0]).toEqual(expect.objectContaining({
      role: 'tool_use',
      toolUseId: 'mcp-wait-1',
      toolName: 'wait_agent_idle',
      toolStatus: 'completed',
      partial: false,
    }))
    expect(complete.messages[1]).toEqual(expect.objectContaining({
      role: 'tool_result',
      toolUseId: 'mcp-wait-1',
      toolResult: 'idle',
      partial: false,
      isDelta: false,
      isError: false,
    }))
  })

  it('tool_update failed sets toolStatus=failed and clears partial on both rows', () => {
    const failed = reduceAgentStreamEvent([], undefined, {
      type: 'tool_update',
      sessionId: 'session-1',
      sequence: 1,
      toolCallId: 'tool-fail',
      name: 'Bash',
      status: 'failed',
      error: 'timeout',
    })

    expect(failed.messages[0]).toEqual(expect.objectContaining({
      role: 'tool_use',
      toolStatus: 'failed',
      partial: false,
    }))
    expect(failed.messages[1]).toEqual(expect.objectContaining({
      role: 'tool_result',
      partial: false,
      isDelta: false,
      isError: true,
      toolResult: 'timeout',
    }))
  })

  it('flushes partial messages and pending tools on terminal errors', () => {
    const messages = [
      { role: 'assistant', content: 'Partial reply', partial: true } as StreamMessage,
      { role: 'tool_use', content: '', partial: true, toolUseId: 'tool-1', toolName: 'shell' } as StreamMessage,
    ]
    const terminal = reduceAgentStreamEvent(messages, createAgentSessionStreamState(), {
      type: 'error', sessionId: 'session-1', sequence: 4, message: 'Agent disconnected',
    })

    expect(terminal.streaming).toBe(false)
    expect(terminal.error).toBe('Agent disconnected')
    expect(terminal.stream.phase).toBe('error')
    expect(terminal.messages[0]).toEqual(expect.objectContaining({ partial: false }))
    expect(terminal.messages[2]).toEqual(expect.objectContaining({
      role: 'tool_result', toolUseId: 'tool-1', isError: true, toolResult: 'Agent disconnected',
    }))
  })

  it('replaces plan and status state, then clears pending permission on completion', () => {
    const plan = reduceAgentStreamEvent([], undefined, {
      type: 'plan', sessionId: 'session-1', sequence: 1, title: 'Implementation',
      entries: [{ id: 'step-1', title: 'Inspect files', status: 'in_progress' }],
    })
    const status = reduceAgentStreamEvent(plan.messages, plan.stream, {
      type: 'status', sessionId: 'session-1', sequence: 2, status: 'running', message: 'Inspecting files',
    })
    const permission = reduceAgentStreamEvent(status.messages, status.stream, {
      type: 'permission_request', sessionId: 'session-1', sequence: 3,
      request: {
        requestId: 'permission-1',
        title: 'Allow edit?',
        options: [{ optionId: 'allow', label: 'Allow once', kind: 'allow_once' }],
      },
    })
    const done = reduceAgentStreamEvent(permission.messages, permission.stream, {
      type: 'done', sessionId: 'session-1', sequence: 4, stopReason: 'end_turn',
    })

    expect(status.stream.plan?.entries[0]?.title).toBe('Inspect files')
    expect(status.stream.statusMessage).toBe('Inspecting files')
    expect(permission.stream.phase).toBe('waiting_permission')
    expect(done.stream).toEqual(expect.objectContaining({
      phase: 'done',
      permission: undefined,
      statusMessage: undefined,
      plan: undefined,
      terminalReason: 'end_turn',
    }))
    expect(done.streaming).toBe(false)
  })

  it('clears plan on error, cancelled, and status idle so the activity panel closes', () => {
    const withPlan = reduceAgentStreamEvent([], undefined, {
      type: 'plan', sessionId: 'session-1', sequence: 1,
      entries: [{ id: 'step-1', title: 'Inspect files', status: 'completed' }],
    })

    const errored = reduceAgentStreamEvent(withPlan.messages, withPlan.stream, {
      type: 'error', sessionId: 'session-1', sequence: 2, message: 'boom',
    })
    expect(errored.stream.plan).toBeUndefined()

    const cancelled = reduceAgentStreamEvent(withPlan.messages, withPlan.stream, {
      type: 'cancelled', sessionId: 'session-1', sequence: 2, reason: 'user',
    })
    expect(cancelled.stream.plan).toBeUndefined()

    const idle = reduceAgentStreamEvent(withPlan.messages, withPlan.stream, {
      type: 'status', sessionId: 'session-1', sequence: 2, status: 'idle',
    })
    expect(idle.stream.plan).toBeUndefined()
    expect(idle.stream.statusMessage).toBeUndefined()
    expect(idle.stream.phase).toBe('idle')
  })

  it('matches legacy toolCallId rows on tool_update so stream output keeps flowing after fail-open', () => {
    // Silence fail-open may replace stream messages with process.ts rows that
    // only carry toolCallId (no toolUseId / partial).
    const legacyMessages = [
      {
        role: 'tool_use',
        content: '',
        toolCallId: 'call-legacy',
        toolName: 'Bash',
        toolInput: { command: 'sleep 1' },
      } as StreamMessage,
    ]
    const updated = reduceAgentStreamEvent(legacyMessages, {
      phase: 'running',
      lastSequence: 0,
      lastEventAt: Date.now(),
    }, {
      type: 'tool_update',
      sessionId: 'session-1',
      sequence: 1,
      toolCallId: 'call-legacy',
      status: 'in_progress',
      resultDelta: 'tick\n',
    })

    expect(updated.messages).toHaveLength(2)
    expect(updated.messages[0]).toEqual(expect.objectContaining({
      role: 'tool_use',
      toolUseId: 'call-legacy',
      toolStatus: 'in_progress',
      partial: true,
    }))
    expect(updated.messages[1]).toEqual(expect.objectContaining({
      role: 'tool_result',
      toolUseId: 'call-legacy',
      toolResult: 'tick\n',
      partial: true,
      isDelta: true,
    }))
  })

  it('merges text_delta into a trailing partial assistant that lacks streamItemId', () => {
    const legacyPartial = [
      {
        role: 'assistant',
        content: 'legacy head ',
        partial: true,
      } as StreamMessage,
    ]
    const next = reduceAgentStreamEvent(legacyPartial, {
      phase: 'running',
      lastSequence: 0,
      lastEventAt: Date.now(),
    }, {
      type: 'text_delta',
      sessionId: 'session-1',
      sequence: 1,
      itemId: 'assistant-text',
      delta: 'stream tail',
    })

    expect(next.messages).toHaveLength(1)
    expect(next.messages[0]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'legacy head stream tail',
      partial: true,
      streamItemId: 'assistant-text',
    }))
  })

  it('annotateLivePartialFlags re-stamps open tools and trailing narrative while streaming', () => {
    const messages = [
      { role: 'thinking', content: 'done thought', partial: false, isThinking: true } as StreamMessage,
      {
        role: 'tool_use',
        content: '',
        toolCallId: 't1',
        toolName: 'Grep',
        partial: false,
      } as StreamMessage,
      { role: 'assistant', content: 'reply so far', partial: false } as StreamMessage,
    ]

    const annotated = annotateLivePartialFlags(messages, true)
    expect(annotated[1]).toEqual(expect.objectContaining({
      role: 'tool_use',
      partial: true,
      toolUseId: 't1',
    }))
    expect(annotated[2]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'reply so far',
      partial: true,
    }))
    // Earlier sealed thinking stays sealed.
    expect(annotated[0]).toEqual(expect.objectContaining({
      role: 'thinking',
      partial: false,
    }))

    expect(annotateLivePartialFlags(messages, false)).toBe(messages)
  })
})
