"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

import { CloudAPI } from "@/lib/cloud-api";

interface CloudTerminalProps {
  api: CloudAPI;
  sessionId: string;
}

function bytesToBase64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = window.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function CloudTerminal({ api, sessionId }: CloudTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState<
    "connecting" | "connected" | "disconnected" | "error"
  >("connecting");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: "var(--font-ibm-plex-mono), monospace",
      fontSize: 13,
      scrollback: 10_000,
      theme: {
        background: "#0a0b0d",
        foreground: "#f4f5f7",
        cursor: "#4d8dff",
        selectionBackground: "#4d8dff55",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();

    let active = true;
    let socket: WebSocket | null = null;
    let lastSequence = 0;
    let reconnectTimer: number | undefined;

    const sendResize = () => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify({
          type: "resize",
          rows: terminal.rows,
          cols: terminal.cols,
        }),
      );
    };

    const connect = async () => {
      if (!active) return;
      setConnection("connecting");
      try {
        const { ticket } = await api.terminalTicket(sessionId);
        if (!active) return;
        socket = new WebSocket(api.terminalURL(ticket, lastSequence));
        socket.addEventListener("open", () => {
          setConnection("connected");
          sendResize();
        });
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data)) as {
            type: "output" | "error";
            data?: string;
            sequence?: number;
            message?: string;
          };
          if (message.type === "output" && message.data) {
            terminal.write(base64ToBytes(message.data));
            lastSequence = Math.max(lastSequence, message.sequence ?? 0);
          } else if (message.type === "error" && message.message) {
            terminal.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`);
          }
        });
        socket.addEventListener("close", () => {
          if (!active) return;
          setConnection("disconnected");
          reconnectTimer = window.setTimeout(() => void connect(), 1000);
        });
        socket.addEventListener("error", () => setConnection("error"));
      } catch (error) {
        if (!active) return;
        setConnection("error");
        terminal.writeln(
          `\r\n\x1b[31m${error instanceof Error ? error.message : "Terminal connection failed."}\x1b[0m`,
        );
        reconnectTimer = window.setTimeout(() => void connect(), 2000);
      }
    };

    const input = terminal.onData((data) => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: "input", data: bytesToBase64(data) }));
    });
    const resize = terminal.onResize(sendResize);
    const observer = new ResizeObserver(() => {
      fit.fit();
      sendResize();
    });
    observer.observe(host);
    void connect();

    return () => {
      active = false;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      observer.disconnect();
      input.dispose();
      resize.dispose();
      socket?.close();
      terminal.dispose();
    };
  }, [api, sessionId]);

  return (
    <div className="relative h-full min-h-0 bg-[#0a0b0d]">
      <div
        className="absolute right-3 top-2 z-10 font-mono text-[10px] uppercase tracking-[0.12em] text-white/40"
        aria-live="polite"
      >
        {connection}
      </div>
      <div ref={hostRef} className="h-full min-h-[24rem] p-2 pt-7" />
    </div>
  );
}
