"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { cn } from "@/lib/cn";

import { getStoredFontSize } from "./terminal/terminal-font";
import { TerminalControls } from "./terminal/TerminalControls";
import { useFullscreenResize } from "./terminal/useFullscreenResize";
import { useXtermTerminal } from "./terminal/useXtermTerminal";

// Re-exported for consumers/tests that target the public DirectTerminal module.
export { buildTerminalThemes } from "./terminal/terminal-themes";
export { resolveMonoFontFamily } from "./terminal/terminal-font";

interface DirectTerminalProps {
  sessionId: string;
  projectId?: string;
  /** Actual tmux session name. When provided, the terminal server uses it directly instead of resolving from sessionId. */
  tmuxName?: string;
  startFullscreen?: boolean;
  /** Visual variant. Orchestrator keeps the same design-system blue accent as the rest of the app. */
  variant?: "agent" | "orchestrator";
  appearance?: "theme" | "dark";
  /** @deprecated Terminal now fills its flex parent via flex:1. This prop is ignored. */
  height?: string;
  isOpenCodeSession?: boolean;
  reloadCommand?: string;
  chromeless?: boolean;
  /** When true, focus the terminal immediately after it mounts so keyboard input works without clicking first. */
  autoFocus?: boolean;
}

/**
 * Direct xterm.js terminal with native WebSocket connection.
 * Implements Extended Device Attributes (XDA) handler to enable
 * tmux clipboard support (OSC 52) without requiring iTerm2 attachment.
 */
export function DirectTerminal({
  sessionId,
  projectId,
  tmuxName,
  startFullscreen = false,
  variant = "agent",
  appearance = "theme",
  height: _height = "max(440px, calc(100dvh - 440px))",
  isOpenCodeSession = false,
  reloadCommand,
  chromeless = false,
  autoFocus = false,
}: DirectTerminalProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { resolvedTheme } = useTheme();

  const terminalRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(startFullscreen);
  const [fontSize, setFontSize] = useState(getStoredFontSize());

  const { error, followOutput, scrollToLatest, muxStatus, terminalInstance, fitAddon } =
    useXtermTerminal(terminalRef, sessionId, {
      appearance,
      variant,
      fontSize,
      autoFocus,
      projectId,
      tmuxName,
    });

  useFullscreenResize(fullscreen, sessionId, projectId, terminalInstance, fitAddon, terminalRef);

  // Sync fullscreen to URL query param
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (fullscreen) {
      params.set("fullscreen", "true");
    } else {
      params.delete("fullscreen");
    }
    const newUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname;
    router.replace(newUrl, { scroll: false });
  }, [fullscreen, pathname, router, searchParams]);

  const isDarkChrome = appearance === "dark" || resolvedTheme !== "light";

  return (
    <div
      className={cn(
        "overflow-hidden border border-[var(--color-border-default)] flex flex-col",
        fullscreen ? "fixed inset-0 z-50 rounded-none border-0" : "relative h-full",
        isDarkChrome ? "bg-[#0a0a0f]" : "bg-[#fafafa]",
        chromeless && "border-0",
      )}
    >
      <TerminalControls
        sessionId={sessionId}
        chromeless={chromeless}
        isOpenCodeSession={isOpenCodeSession}
        reloadCommand={reloadCommand}
        fontSize={fontSize}
        setFontSize={setFontSize}
        fullscreen={fullscreen}
        toggleFullscreen={() => setFullscreen((prev) => !prev)}
        muxStatus={muxStatus}
        error={error}
      />
      {/* Terminal area — flex:1 so it fills remaining space after the chrome bar */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        {!followOutput ? (
          <button
            type="button"
            onClick={scrollToLatest}
            className="absolute bottom-3 right-3 z-20 flex h-8 w-8 items-center justify-center rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)] shadow-md active:scale-95"
            aria-label="Jump to latest"
            title="Jump to latest"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
          </button>
        ) : null}
        <div ref={terminalRef} className="w-full flex flex-col flex-1 min-h-0 overflow-hidden" />
      </div>
    </div>
  );
}
