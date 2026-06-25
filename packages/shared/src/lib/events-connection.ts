// packages/shared/src/lib/events-connection.ts
type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected';

let connectionState: ConnectionState = 'idle';
const listeners: Set<(state: ConnectionState) => void> = new Set();

export function setEventsConnectionState(state: ConnectionState): void {
  connectionState = state;
  listeners.forEach((listener) => listener(state));
}

export function getEventsConnectionState(): ConnectionState {
  return connectionState;
}

export function subscribeEventsConnectionState(
  callback: (state: ConnectionState) => void
): () => void {
  listeners.add(callback);
  callback(connectionState);
  return () => listeners.delete(callback);
}
