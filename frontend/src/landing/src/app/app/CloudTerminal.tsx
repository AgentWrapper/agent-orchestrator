"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useLayoutEffect, useRef, useState } from "react";

import { CloudAPI } from "@/lib/cloud-api";
import {
  CloudTerminalConnectionState,
  CloudTerminalKind,
  ensureCloudTerminalConnection,
} from "@/lib/cloud-terminal-pool";

interface CloudTerminalProps {
  api: CloudAPI;
  orgId: string;
  sessionId: string;
  layoutKey?: string;
  kind?: CloudTerminalKind;
}

export function CloudTerminal({
  api,
  orgId,
  sessionId,
  layoutKey = "",
  kind = "agent",
}: CloudTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [connection, setConnection] =
    useState<CloudTerminalConnectionState>("connecting");
  const [notice, setNotice] = useState<string | null>(null);

  useLayoutEffect(() => {
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
    const fitTerminal = () => fit.fit();
    fitTerminal();
    const firstFrame = window.requestAnimationFrame(fitTerminal);
    const secondFrame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(fitTerminal);
    });

    const persistentConnection = ensureCloudTerminalConnection(
      api,
      orgId,
      sessionId,
      kind,
    );
    persistentConnection.resize(terminal.rows, terminal.cols);
    const unsubscribe = persistentConnection.subscribe((event) => {
      if (event.type === "state") {
        setConnection(event.state);
      } else if (event.type === "reset") {
        terminal.reset();
        terminal.clear();
      } else if (event.type === "notice") {
        setNotice(event.message);
      } else {
        setNotice(null);
        terminal.write(event.data);
      }
    });
    const input = terminal.onData((data) =>
      persistentConnection.sendInput(data),
    );
    const resize = terminal.onResize(({ rows, cols }) =>
      persistentConnection.resize(rows, cols),
    );
    const observer = new ResizeObserver(() => {
      fitTerminal();
      persistentConnection.resize(terminal.rows, terminal.cols);
    });
    observer.observe(host);
    if (host.parentElement) observer.observe(host.parentElement);

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      unsubscribe();
      input.dispose();
      resize.dispose();
      terminal.dispose();
    };
  }, [api, kind, layoutKey, orgId, sessionId]);

  return (
    <div className="relative h-full min-h-0 w-full bg-[#101317]">
      {connection !== "connected" ? (
        <div
          className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-[#101317]/92"
          aria-live="polite"
        >
          <div className="text-center">
            <div className="relative mx-auto mb-3 size-8">
              <span className="absolute inset-0 rounded-full border border-[#4d8dff]/20" />
              <span className="absolute inset-1 animate-spin rounded-full border border-transparent border-t-[#6f9eff] motion-reduce:animate-none" />
              <span className="absolute inset-3 rounded-full bg-[#6f9eff]/70" />
            </div>
            <p className="text-xs text-[#c4c8cf]">
              {connection === "connecting"
                ? "Connecting terminal…"
                : connection === "disconnected"
                  ? "Reconnecting terminal…"
                  : "Retrying terminal…"}
            </p>
            <p className="mt-1 font-mono text-[10px] text-[#68717d]">
              /workspace/repository
            </p>
          </div>
        </div>
      ) : null}
      {notice ? (
        <div
          className="absolute inset-x-3 bottom-3 z-20 rounded border border-amber-400/30 bg-[#1a1710]/95 px-3 py-2 text-xs text-amber-100 shadow-lg"
          role="status"
        >
          {notice}
        </div>
      ) : null}
      <div ref={hostRef} className="h-full min-h-0 w-full p-2" />
    </div>
  );
}
