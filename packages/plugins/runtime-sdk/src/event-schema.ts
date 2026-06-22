/**
 * event-schema.ts — the PROVIDER SEAM.
 *
 * A normalized, model-AGNOSTIC streaming event schema. `runtime-sdk` translates
 * Anthropic Agent-SDK messages into these events (see sdk-translator.ts); a
 * future adapter for a different model (an OpenAI-compatible / Codex / other
 * driver) emits the SAME events, so downstream consumers (Maestro) render them
 * unchanged. NOTHING in this file may reference Agent-SDK field names — keep the
 * wire schema clean of Claude-specifics.
 *
 * Wire format: one JSON object per line (NDJSON), both on disk (events.ndjson)
 * and over the live socket. Every event carries the common envelope (EventMeta)
 * plus a type-discriminated body (EventBody).
 */

/** Bump when the wire shape changes incompatibly. */
export const SCHEMA_VERSION = 1;

/** The discriminator values that may appear on the wire as `type`. */
export type NormalizedEventType =
  | "session"
  | "text-delta"
  | "reasoning"
  | "tool_use"
  | "tool_result"
  | "result"
  | "usage"
  | "permission_request"
  | "permission_resolved"
  | "error";

/** Envelope fields stamped on every event by the host. */
export interface EventMeta {
  /** Schema version (SCHEMA_VERSION). */
  v: number;
  /** Monotonic per-session sequence number; starts at 0, +1 per event. */
  seq: number;
  /** ISO-8601 UTC timestamp of when the host emitted the event. */
  ts: string;
  /**
   * Provider session id (Claude SDK session_id). `null` until the session has
   * initialised — in streaming-input mode `init` is deferred until the first
   * user turn, so early lifecycle events may carry `null`.
   */
  session_id: string | null;
  /** 1-based user-turn index this event belongs to; 0 for pre-first-turn events. */
  turn: number;
}

/** Session lifecycle. `init` is the moment the provider session id is known. */
export interface SessionEventBody {
  type: "session";
  subtype: "init" | "resumed" | "end";
  session_id: string;
  model?: string;
  cwd?: string;
  permission_mode?: string;
  tools?: string[];
}

/** A chunk of streamed assistant answer text. */
export interface TextDeltaEventBody {
  type: "text-delta";
  /** Content-block index within the current assistant message. */
  block: number;
  text: string;
}

/** A chunk of streamed model reasoning / thinking. */
export interface ReasoningEventBody {
  type: "reasoning";
  block: number;
  text: string;
}

/** The model invoked a tool (full, decoded input). */
export interface ToolUseEventBody {
  type: "tool_use";
  block: number;
  /** Provider tool-call id (used to correlate with tool_result). */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The result of a tool call. */
export interface ToolResultEventBody {
  type: "tool_result";
  tool_use_id: string;
  is_error: boolean;
  /** Tool output, normalized to a string. */
  content: string;
}

/** A turn / run completed. */
export interface ResultEventBody {
  type: "result";
  subtype: string;
  is_error: boolean;
  /** Final assistant text for the turn. */
  text: string;
  num_turns: number;
  duration_ms: number;
}

/** Token / cost accounting, emitted alongside `result`. */
export interface UsageEventBody {
  type: "usage";
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_cost_usd: number;
  model: string;
}

/** A tool requires approval (the canUseTool seam). Answered out-of-band. */
export interface PermissionRequestEventBody {
  type: "permission_request";
  request_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  suggestions?: unknown[];
}

/** The answer to a prior permission_request. */
export interface PermissionResolvedEventBody {
  type: "permission_resolved";
  request_id: string;
  behavior: "allow" | "deny";
  message?: string;
}

/** A host- or provider-level error. */
export interface ErrorEventBody {
  type: "error";
  message: string;
  fatal: boolean;
}

export type EventBody =
  | SessionEventBody
  | TextDeltaEventBody
  | ReasoningEventBody
  | ToolUseEventBody
  | ToolResultEventBody
  | ResultEventBody
  | UsageEventBody
  | PermissionRequestEventBody
  | PermissionResolvedEventBody
  | ErrorEventBody;

/** A fully-stamped event as it appears on the wire / on disk. */
export type NormalizedEvent = EventBody & EventMeta;
