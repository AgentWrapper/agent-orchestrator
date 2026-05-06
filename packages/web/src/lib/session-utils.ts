export function matchesSessionPrefix(sessionId: string, prefix: string): boolean {
  return sessionId === prefix || sessionId.startsWith(`${prefix}-`);
}
