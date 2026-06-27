/**
 * host/history-log.ts — durable NDJSON history persistence for a session.
 *
 * The append-only `events.ndjson` is the source of truth for replay, restart
 * recovery, and reading older history. The host writes to it through the sink
 * created here; SessionHost stays transport- and storage-agnostic (it only knows
 * a `persist(line)` callback).
 */

import { appendFileSync } from "node:fs";

/**
 * Create the durable event-log sink: appends one already-encoded NDJSON line per
 * call to `events.ndjson`. Synchronous on purpose — ordering must match emission
 * exactly, and the host isolates this sink in a try/catch so a write hiccup never
 * kills the turn or the live stream.
 */
export function createEventLogSink(eventLogPath: string): (line: string) => void {
  return (line: string) => appendFileSync(eventLogPath, line);
}
