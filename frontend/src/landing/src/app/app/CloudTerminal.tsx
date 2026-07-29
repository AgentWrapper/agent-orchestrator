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
      fontFamily:
        '"JetBrainsMono Nerd Font Mono", "FiraCode Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      scrollback: 10_000,
      theme: {
        background: "#101317",
        foreground: "#d7d7d2",
        cursor: "#36c2b4",
        cursorAccent: "#101317",
        selectionBackground: "#4d8dff4d",
        selectionInactiveBackground: "#80808033",
        black: "#1f2329",
        red: "#f05d5e",
        green: "#44c97a",
        yellow: "#e5c34b",
        blue: "#5b9cff",
        magenta: "#c678dd",
        cyan: "#56b6c2",
        white: "#d7dae0",
        brightBlack: "#7f8792",
        brightRed: "#ff7b7c",
        brightGreen: "#62df91",
        brightYellow: "#f2d66d",
        brightBlue: "#79b1ff",
        brightMagenta: "#d99aee",
        brightCyan: "#79d4df",
        brightWhite: "#f4f5f7",
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
    <div className="relative h-full min-h-0 bg-[#101317]">
      {connection !== "connected" && (
        <div
          className="absolute right-3 top-2 z-10 rounded-md bg-[#15171b] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.05em] text-[#9ba1aa]"
          aria-live="polite"
        >
          {connection}
        </div>
      )}
      <div ref={hostRef} className="h-full min-h-0 p-2" />
    </div>
  );
}
