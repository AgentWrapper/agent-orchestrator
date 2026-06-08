import type { SessionId, SessionKind } from "../types.js";
import { escapeRegex } from "./regex.js";

export function deriveSessionKindFromMetadata(
  sessionId: SessionId,
  meta: Record<string, string>,
  sessionPrefix?: string,
): SessionKind {
  if (meta["role"] === "orchestrator") return "orchestrator";
  if (!sessionPrefix) return "worker";
  if (sessionId === `${sessionPrefix}-orchestrator`) return "orchestrator";
  if (new RegExp(`^${escapeRegex(sessionPrefix)}-orchestrator-\\d+$`).test(sessionId)) {
    return "orchestrator";
  }
  return "worker";
}
