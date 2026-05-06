"use client";

import { useState, useEffect } from "react";
import { cn } from "@/lib/cn";

interface TerminalProps {
  sessionId: string;
}

/**
 * Terminal embed using ttyd (iframe).
 * ttyd handles xterm.js, WebSocket, ANSI rendering, resize, input — everything.
 * We just request a ttyd URL from our terminal server and embed it.
 */
export function Terminal({ sessionId }: TerminalProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const [terminalUrl, setTerminalUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const port = process.env.NEXT_PUBLIC_TERMINAL_PORT ?? "14800";
    // Use current hostname instead of hardcoded localhost
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    // URL-encode sessionId to prevent special characters from breaking the URL
    fetch(`${protocol}//${hostname}:${port}/terminal?session=${encodeURIComponent(sessionId)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ url: string }>;
      })
      .then((data) => {
        setTerminalUrl(data.url);
      })
      .catch((err) => {
        console.error("[Terminal] Failed to get terminal URL:", err);
        setError("Failed to connect to terminal server");
      });
  }, [sessionId]);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[2px] border border-[var(--color-border-default)] bg-black",
        fullscreen && "fixed inset-0 z-50 rounded-none border-0",
      )}
    >
      <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-3 py-2">
        <div
          className={cn(
            "h-2 w-2 rounded-full",
            terminalUrl ? "bg-[#3fb950]" : error ? "bg-[#f85149]" : "bg-[#d29922] animate-pulse",
          )}
        />
        <span className="font-[var(--font-mono)] text-xs text-[var(--color-text-muted)]">
          {sessionId}
        </span>
        <span
          className={cn(
            "text-[10px] font-medium uppercase tracking-wide",
            terminalUrl
              ? "text-[var(--color-accent-green)]"
              : error
                ? "text-[var(--color-accent-red)]"
                : "text-[var(--color-text-muted)]",
          )}
        >
          {terminalUrl ? "Connected" : (error ?? "Connecting...")}
        </span>
        <button
          onClick={() => setFullscreen(!fullscreen)}
          className="ml-auto rounded-[2px] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)]"
        >
          {fullscreen ? "exit fullscreen" : "fullscreen"}
        </button>
      </div>
      <div className="w-full" style={{ height: fullscreen ? "calc(100dvh - 40px)" : "max(440px, calc(100dvh - 440px))" }}>
        {terminalUrl ? (
          <iframe
            src={terminalUrl}
            className="h-full w-full border-0"
            title={`Terminal: ${sessionId}`}
            allow="clipboard-read; clipboard-write"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
            {error ?? "Connecting to terminal..."}
          </div>
        )}
      </div>
    </div>
  );
}
