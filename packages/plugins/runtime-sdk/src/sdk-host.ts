/**
 * sdk-host.ts — the long-lived runtime-sdk HOST: barrel + standalone entry-point.
 *
 * Dual-purpose, like runtime-process/pty-host.ts:
 *   1. Barrel — re-exports the transport-agnostic `SessionHost` core and the
 *      socket-server seam so consumers and tests keep importing from
 *      "./sdk-host.js" unchanged after the host was split into host/ + providers/.
 *   2. Standalone script — `node sdk-host.js <aoSessionId>` runs `runStandalone()`
 *      (host/socket-server.ts), wiring `SessionHost` to a real `net` server and
 *      the right provider driver, then surviving parent exit (spawned detached by
 *      index.ts, which resolves THIS file as "sdk-host.js").
 *
 * The host owns the session so it survives orchestrator/Maestro restarts; the
 * provider session id is captured from the SDK `init` and persisted so a fresh
 * host can reattach via `options.resume`.
 *
 * Module layout after the split (#6):
 *   host/session-host.ts   — SessionHost core (unit-tested, no sockets/SDK)
 *   host/socket-server.ts  — net server, backpressure, control commands, dispatch
 *   host/history-log.ts    — durable events.ndjson sink + sidecar offset indexes (#4)
 *   providers/claude-agent-sdk.ts — default Claude path (+ MiMo full-agent)
 *   providers/openai-compatible.ts — GLM / MiMo legacy chat-loop
 *   providers/mimo-anthropic.ts    — MiMo Anthropic-compatible env setup
 */

export {
  SessionHost,
  type SessionHostOptions,
  type Send,
} from "./host/session-host.js";
export {
  makeSubscriberSink,
  SUBSCRIBER_BUFFER_CAP,
  type SubscriberSocket,
  readAppendSystemPrompt,
  resolveHostDispatch,
  runStandalone,
  handleClientCommand,
} from "./host/socket-server.js";
export {
  createEventLogSink,
  // #4 indexed-history readers (seek via sidecar .idx; full-scan fallback).
  readTailLines,
  readAllLines,
  readLinesFrom,
  readEpochIndex,
  readTurnIndex,
  rebuildIndex,
  indexPaths,
  CHECKPOINT_INTERVAL,
  type IndexRecord,
} from "./host/history-log.js";

import { runStandalone } from "./host/socket-server.js";

// ===========================================================================
// Standalone entry-point — run only when invoked directly as sdk-host.js/.ts.
// ===========================================================================

const isMain =
  process.argv[1]?.endsWith("sdk-host.js") || process.argv[1]?.endsWith("sdk-host.ts");

if (isMain) {
  void runStandalone();
}
