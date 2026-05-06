import type { SessionId } from "../types.js";

export const SESSION_ID_COMPONENT_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function assertValidSessionIdComponent(
  sessionId: SessionId,
  context = "session ID",
): void {
  if (!SESSION_ID_COMPONENT_PATTERN.test(sessionId)) {
    throw new Error(`Invalid ${context}: ${sessionId}`);
  }
}
