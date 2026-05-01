"use client";

import { useState, useEffect } from "react";

// Simple pub/sub for terminal connection state aggregation.
// DirectTerminal components report their connection status here;
// CompactTopBar reads the aggregated reconnecting state.

const listeners: Set<(reconnecting: boolean) => void> = new Set();
let anyReconnecting = false;
const terminalStates = new Map<string, boolean>();

export function reportTerminalReconnecting(id: string, reconnecting: boolean): void {
  terminalStates.set(id, reconnecting);
  const next = [...terminalStates.values()].some(Boolean);
  if (next !== anyReconnecting) {
    anyReconnecting = next;
    for (const fn of listeners) fn(anyReconnecting);
  }
}

export function useAggregatedTerminalConnection(): { reconnecting: boolean } {
  const [reconnecting, setReconnecting] = useState(anyReconnecting);

  useEffect(() => {
    setReconnecting(anyReconnecting);
    listeners.add(setReconnecting);
    return () => {
      listeners.delete(setReconnecting);
    };
  }, []);

  return { reconnecting };
}
