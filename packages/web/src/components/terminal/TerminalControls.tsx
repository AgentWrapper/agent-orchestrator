"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { cn } from "@/lib/cn";
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from "./terminal-font";

type MuxStatus = "connecting" | "connected" | "reconnecting" | "disconnected";
type DisplayStatus = MuxStatus | "error";

interface TerminalControlsProps {
  sessionId: string;
  chromeless: boolean;
  isOpenCodeSession: boolean;
  reloadCommand?: string;
  fontSize: number;
  setFontSize: Dispatch<SetStateAction<number>>;
  fullscreen: boolean;
  toggleFullscreen: () => void;
  muxStatus: MuxStatus;
  error: string | null;
}

export function TerminalControls({
  sessionId,
  chromeless,
  isOpenCodeSession,
  reloadCommand,
  fontSize,
  setFontSize,
  fullscreen,
  toggleFullscreen,
  muxStatus,
  error,
}: TerminalControlsProps) {
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);

  async function handleReload(): Promise<void> {
    if (!isOpenCodeSession || reloading) return;
    setReloadError(null);
    setReloading(true);
    try {
      let commandToSend = reloadCommand;

      if (!commandToSend) {
        const remapRes = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/remap`, {
          method: "POST",
        });
        if (!remapRes.ok) {
          throw new Error(`Failed to remap OpenCode session: ${remapRes.status}`);
        }
        const remapData = (await remapRes.json()) as { opencodeSessionId?: unknown };
        if (
          typeof remapData.opencodeSessionId !== "string" ||
          remapData.opencodeSessionId.length === 0
        ) {
          throw new Error("Missing OpenCode session id after remap");
        }
        commandToSend = `/exit\nopencode --session ${remapData.opencodeSessionId}\n`;
      }

      const sendRes = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: commandToSend }),
      });
      if (!sendRes.ok) {
        throw new Error(`Failed to send reload command: ${sendRes.status}`);
      }
    } catch (err) {
      setReloadError(err instanceof Error ? err.message : "Failed to reload OpenCode session");
    } finally {
      setReloading(false);
    }
  }

  // Local errors (e.g. xterm.js load failure) take priority over mux connection state
  const displayStatus: DisplayStatus = error ? "error" : muxStatus;

  const statusDotClass =
    displayStatus === "connected"
      ? "bg-[var(--color-status-ready)]"
      : displayStatus === "error" || displayStatus === "disconnected"
        ? "bg-[var(--color-status-error)]"
        : "bg-[var(--color-status-attention)] animate-[pulse_1.5s_ease-in-out_infinite]";

  const statusText =
    displayStatus === "connected"
      ? "Connected"
      : displayStatus === "error"
        ? (error ?? "Error")
        : displayStatus === "disconnected"
          ? "Disconnected"
          : "Connecting…";

  const statusTextColor =
    displayStatus === "connected"
      ? "text-[var(--color-status-ready)]"
      : displayStatus === "error" || displayStatus === "disconnected"
        ? "text-[var(--color-status-error)]"
        : "text-[var(--color-text-tertiary)]";

  const accentColor = "var(--color-accent)";

  const fontSizeControls = (
    <div className="flex items-center">
      <button
        onClick={() => setFontSize((prev) => Math.max(FONT_SIZE_MIN, prev - 1))}
        disabled={fontSize <= FONT_SIZE_MIN}
        className="w-5 h-5 text-xs flex items-center justify-center rounded hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        aria-label="Decrease font size"
      >
        −
      </button>
      <span className="w-9 text-center text-xs font-medium text-[var(--color-text-secondary)]">
        {fontSize}px
      </span>
      <button
        onClick={() => setFontSize((prev) => Math.min(FONT_SIZE_MAX, prev + 1))}
        disabled={fontSize >= FONT_SIZE_MAX}
        className="w-5 h-5 text-xs flex items-center justify-center rounded hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        aria-label="Increase font size"
      >
        +
      </button>
    </div>
  );

  const reloadButton = isOpenCodeSession ? (
    <button
      onClick={handleReload}
      disabled={reloading || muxStatus !== "connected"}
      title="Restart OpenCode session (/exit then resume mapped session)"
      aria-label="Restart OpenCode session"
      className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-70"
    >
      {reloading ? (
        <>
          <svg
            className="h-3 w-3 animate-spin"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M12 3a9 9 0 109 9" />
          </svg>
          restarting
        </>
      ) : (
        <>
          <svg
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M21 12a9 9 0 11-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
          restart
        </>
      )}
    </button>
  ) : null;

  const fullscreenButton = (
    <button
      onClick={toggleFullscreen}
      className={cn(
        "flex items-center gap-1 px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)]",
        !isOpenCodeSession && !chromeless && "ml-auto",
      )}
      aria-label={fullscreen ? "exit fullscreen" : "fullscreen"}
    >
      {fullscreen ? (
        <>
          <svg
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" />
          </svg>
          exit fullscreen
        </>
      ) : (
        <>
          <svg
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
          </svg>
          fullscreen
        </>
      )}
    </button>
  );

  if (chromeless) {
    return (
      <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-[6px] border border-[var(--color-border-subtle)] bg-[color-mix(in_srgb,var(--color-bg-elevated)_92%,transparent)] px-1.5 py-1 shadow-[0_8px_24px_rgba(0,0,0,0.18)] backdrop-blur-sm">
        {reloadButton}
        {fullscreenButton}
      </div>
    );
  }

  return (
    <div className="terminal-chrome-bar flex items-center gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-3 py-2">
      {/* Pane label — matches the workspace pane-header style used elsewhere */}
      <span className="terminal-chrome-pane-label">TERMINAL</span>
      {/* Identity group: session name on top, status+XDA below on mobile */}
      <div className="terminal-chrome-identity">
        <span className="terminal-chrome-session-id font-[var(--font-mono)] text-[11px]" style={{ color: accentColor }}>
          {sessionId}
        </span>
        <div className="terminal-chrome-status-row">
          <div className={cn("h-2 w-2 shrink-0 rounded-full", statusDotClass)} />
          <span
            className={cn("text-[10px] font-medium uppercase tracking-[0.06em]", statusTextColor)}
          >
            {statusText}
          </span>
          <span
            className="px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]"
            style={{
              color: accentColor,
              background: `color-mix(in srgb, ${accentColor} 12%, transparent)`,
            }}
          >
            XDA
          </span>
        </div>
      </div>
      <div className="flex-1" />
      {fontSizeControls}
      {reloadButton}
      {reloadError ? (
        <span
          className="max-w-[40ch] truncate text-[10px] font-medium text-[var(--color-status-error)]"
          title={reloadError}
        >
          {reloadError}
        </span>
      ) : null}
      {fullscreenButton}
    </div>
  );
}
