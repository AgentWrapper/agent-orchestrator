"use client";

import React, { useEffect, useRef, useState, useMemo, useCallback, type ReactNode } from "react";
import type { ClientMessage, ServerMessage, SessionPatch } from "@/lib/mux-protocol";

interface MuxContextValue {
  subscribeTerminal: (id: string, callback: (data: string) => void) => () => void;
  writeTerminal: (id: string, data: string) => void;
  openTerminal: (id: string, tmuxName?: string) => void;
  closeTerminal: (id: string) => void;
  resizeTerminal: (id: string, cols: number, rows: number) => void;
  status: "connecting" | "connected" | "reconnecting" | "disconnected";
  sessions: SessionPatch[];
  /** Last session-fetch error from the server, null when healthy. */
  lastError: string | null;
}

const MuxContext = React.createContext<MuxContextValue | undefined>(undefined);

export function useMux(): MuxContextValue {
  const context = React.useContext(MuxContext);
  if (!context) {
    throw new Error("useMux() must be used within <MuxProvider>");
  }
  return context;
}

/** Like useMux() but returns undefined when outside a MuxProvider (safe for tests). */
export function useMuxOptional(): MuxContextValue | undefined {
  return React.useContext(MuxContext);
}

interface RuntimeTerminalConfig {
  directTerminalPort?: unknown;
  proxyWsPath?: unknown;
}

function normalizePortValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return undefined;
  return String(parsed);
}

function normalizePathValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) return undefined;
  return trimmed;
}

function buildMuxWsUrl(runtimeConfig: { directTerminalPort?: string; proxyWsPath?: string }): string {
  const loc = window.location;
  const protocol = loc.protocol === "https:" ? "wss:" : "ws:";

  // Runtime proxy path takes priority (set by `ao start` via TERMINAL_WS_PATH env var)
  const proxyWsPath = runtimeConfig.proxyWsPath ?? process.env.NEXT_PUBLIC_TERMINAL_WS_PATH;
  if (proxyWsPath) {
    const basePath = proxyWsPath.replace(/\/ws\/?$/, "");
    return `${protocol}//${loc.host}${basePath}/mux`;
  }

  // Port-less or standard ports: use path-based routing (reverse proxy expected)
  if (loc.port === "" || loc.port === "443" || loc.port === "80") {
    return `${protocol}//${loc.hostname}/ao-terminal-mux`;
  }

  // Direct port connection — prefer runtime-configured port, fall back to env/default
  const port = runtimeConfig.directTerminalPort ?? process.env.NEXT_PUBLIC_DIRECT_TERMINAL_PORT ?? "14801";
  return `${protocol}//${loc.hostname}:${port}/mux`;
}

export function MuxProvider({ children }: { children: ReactNode }) {
  const wsRef = useRef<WebSocket | null>(null);
  const subscribersRef = useRef(new Map<string, Set<(data: string) => void>>());
  const openedTerminalsRef = useRef(new Map<string, string | undefined>());
  const [status, setStatus] = useState<"connecting" | "connected" | "reconnecting" | "disconnected">(
    "connecting",
  );
  const [sessions, setSessions] = useState<SessionPatch[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runtimeConfigRef = useRef<{ directTerminalPort?: string; proxyWsPath?: string }>({});
  const isDestroyedRef = useRef(false);

  const connect = useCallback(() => {
    if (wsRef.current) {
      return;
    }

    setStatus("connecting");

    try {
      const url = buildMuxWsUrl(runtimeConfigRef.current);
      console.log("[MuxProvider] Connecting to", url);
      const ws = new WebSocket(url);
      // Assign immediately so cleanup can close it even during CONNECTING state
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        if (isDestroyedRef.current) {
          ws.close();
          return;
        }
        console.log("[MuxProvider] Connected");
        setStatus("connected");
        reconnectAttempt.current = 0;

        // Re-open previously opened terminals
        for (const [terminalId, tmuxName] of openedTerminalsRef.current) {
          const openMsg: ClientMessage = {
            ch: "terminal",
            id: terminalId,
            type: "open",
            ...(tmuxName && { tmuxName }),
          };
          ws.send(JSON.stringify(openMsg));
        }

        // Always subscribe to sessions
        const subMsg: ClientMessage = {
          ch: "subscribe",
          topics: ["sessions"],
        };
        ws.send(JSON.stringify(subMsg));
      });

      ws.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(event.data as string) as ServerMessage;

          if (msg.ch === "terminal") {
            if (msg.type === "data") {
              // Push to subscribers
              const subs = subscribersRef.current.get(msg.id);
              if (subs) {
                for (const callback of subs) {
                  callback(msg.data);
                }
              }
            } else if (msg.type === "opened") {
              // Terminal opened successfully — preserve existing tmuxName
              if (!openedTerminalsRef.current.has(msg.id)) {
                openedTerminalsRef.current.set(msg.id, undefined);
              }
            } else if (msg.type === "exited") {
              // PTY exited and could not be re-attached — remove so it isn't
              // re-opened on reconnect, and surface a terminal-level error chunk
              openedTerminalsRef.current.delete(msg.id);
              const subs = subscribersRef.current.get(msg.id);
              if (subs) {
                const notice = `\r\n\x1b[31m[Terminal exited with code ${msg.code}]\x1b[0m\r\n`;
                for (const callback of subs) {
                  callback(notice);
                }
              }
            } else if (msg.type === "error") {
              console.error(`[MuxProvider] Terminal error for ${msg.id}:`, msg.message);
            }
          } else if (msg.ch === "sessions") {
            if (msg.type === "snapshot") {
              setSessions(msg.sessions);
              setLastError(null);
            } else if (msg.type === "error") {
              setLastError(msg.error);
            }
          }
        } catch (err) {
          console.error("[MuxProvider] Error processing message:", err);
        }
      });

      ws.addEventListener("error", (err) => {
        console.error("[MuxProvider] WebSocket error:", err);
      });

      ws.addEventListener("close", () => {
        console.log("[MuxProvider] Disconnected");
        if (wsRef.current === ws) wsRef.current = null;

        // Don't reconnect if the provider has been unmounted
        if (isDestroyedRef.current) return;

        // Reconnect with exponential backoff
        const delayMs = Math.min(1000 * Math.pow(2, reconnectAttempt.current), 30_000);
        reconnectAttempt.current += 1;
        setStatus("reconnecting");

        reconnectTimer.current = setTimeout(() => {
          console.log(`[MuxProvider] Reconnecting (attempt ${reconnectAttempt.current})...`);
          connect();
        }, delayMs);
      });
    } catch (err) {
      console.error("[MuxProvider] Failed to create WebSocket:", err);
      setStatus("disconnected");
    }
  }, []);

  // Fetch runtime config then connect. This ensures buildMuxWsUrl() has the
  // server-configured port/path before the WebSocket is opened.
  useEffect(() => {
    // Reset destroyed flag so StrictMode double-invoke works correctly:
    // cleanup sets it to true, but the re-run must treat itself as alive.
    isDestroyedRef.current = false;
    let cancelled = false;

    const init = async () => {
      try {
        const res = await fetch("/api/runtime/terminal");
        if (res.ok) {
          const data = (await res.json()) as RuntimeTerminalConfig;
          runtimeConfigRef.current = {
            directTerminalPort: normalizePortValue(data.directTerminalPort),
            proxyWsPath: normalizePathValue(data.proxyWsPath),
          };
        }
      } catch {
        // Ignore — fall back to env/default values
      }
      if (!cancelled) connect();
    };

    void init();

    return () => {
      cancelled = true;
      isDestroyedRef.current = true;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  const subscribeTerminal = useCallback(
    (id: string, callback: (data: string) => void): (() => void) => {
      // Add to subscribers
      let subs = subscribersRef.current.get(id);
      if (!subs) {
        subs = new Set();
        subscribersRef.current.set(id, subs);
      }
      subs.add(callback);

      // Request open if not already open
      if (!openedTerminalsRef.current.has(id) && wsRef.current?.readyState === WebSocket.OPEN) {
        const openMsg: ClientMessage = {
          ch: "terminal",
          id,
          type: "open",
        };
        wsRef.current.send(JSON.stringify(openMsg));
      }

      // Return unsubscribe function
      return () => {
        const subs = subscribersRef.current.get(id);
        if (subs) {
          subs.delete(callback);
          if (subs.size === 0) {
            subscribersRef.current.delete(id);
          }
        }
      };
    },
    [],
  );

  const writeTerminal = useCallback((id: string, data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg: ClientMessage = {
        ch: "terminal",
        id,
        type: "data",
        data,
      };
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const openTerminal = useCallback((id: string, tmuxName?: string) => {
    openedTerminalsRef.current.set(id, tmuxName);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg: ClientMessage = {
        ch: "terminal",
        id,
        type: "open",
        ...(tmuxName && { tmuxName }),
      };
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const closeTerminal = useCallback((id: string) => {
    openedTerminalsRef.current.delete(id);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg: ClientMessage = {
        ch: "terminal",
        id,
        type: "close",
      };
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const resizeTerminal = useCallback((id: string, cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg: ClientMessage = {
        ch: "terminal",
        id,
        type: "resize",
        cols,
        rows,
      };
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const contextValue: MuxContextValue = useMemo(
    () => ({
      subscribeTerminal,
      writeTerminal,
      openTerminal,
      closeTerminal,
      resizeTerminal,
      status,
      sessions,
      lastError,
    }),
    [subscribeTerminal, writeTerminal, openTerminal, closeTerminal, resizeTerminal, status, sessions, lastError],
  );

  return <MuxContext.Provider value={contextValue}>{children}</MuxContext.Provider>;
}
