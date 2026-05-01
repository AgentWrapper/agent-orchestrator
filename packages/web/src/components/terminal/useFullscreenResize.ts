"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { Terminal as TerminalType } from "@xterm/xterm";
import type { FitAddon as FitAddonType } from "@xterm/addon-fit";
import { useMux } from "@/hooks/useMux";

/**
 * Re-fit the terminal when entering/leaving fullscreen.
 *
 * The container animates via a CSS transition, so we poll the container
 * height with RAF until it stabilises before calling fit(). Backup timers
 * and a 'transitionend' listener cover browsers where RAF polling alone
 * doesn't settle cleanly.
 */
export function useFullscreenResize(
  fullscreen: boolean,
  sessionId: string,
  projectId: string | undefined,
  terminalInstance: RefObject<TerminalType | null>,
  fitAddon: RefObject<FitAddonType | null>,
  containerRef: RefObject<HTMLDivElement | null>,
): void {
  const { resizeTerminal: resizeTerminalMux, status: muxStatus } = useMux();
  const muxStatusRef = useRef(muxStatus);
  muxStatusRef.current = muxStatus;

  useEffect(() => {
    const fit = fitAddon.current;
    const terminal = terminalInstance.current;
    const container = containerRef.current;

    if (!fit || !terminal || muxStatusRef.current !== "connected" || !container) {
      return;
    }

    let resizeAttempts = 0;
    const maxAttempts = 60;
    let cancelled = false;
    let rafId = 0;
    let lastHeight = -1;

    const resizeTerminal = () => {
      if (cancelled) return;
      resizeAttempts++;

      const currentHeight = container.getBoundingClientRect().height;
      const settled = lastHeight >= 0 && Math.abs(currentHeight - lastHeight) < 1;
      lastHeight = currentHeight;

      if (!settled && resizeAttempts < maxAttempts) {
        rafId = requestAnimationFrame(resizeTerminal);
        return;
      }

      terminal.refresh(0, terminal.rows - 1);
      fit.fit();
      terminal.refresh(0, terminal.rows - 1);

      resizeTerminalMux(sessionId, terminal.cols, terminal.rows, projectId);
    };

    rafId = requestAnimationFrame(resizeTerminal);

    const handleTransitionEnd = (e: TransitionEvent) => {
      if (cancelled) return;
      if (e.target === container.parentElement) {
        resizeAttempts = 0;
        lastHeight = -1;
        setTimeout(() => {
          if (!cancelled) rafId = requestAnimationFrame(resizeTerminal);
        }, 50);
      }
    };

    const parent = container.parentElement;
    parent?.addEventListener("transitionend", handleTransitionEnd);

    // Backup timers in case RAF polling doesn't settle
    const timer1 = setTimeout(() => {
      if (cancelled) return;
      resizeAttempts = 0;
      lastHeight = -1;
      resizeTerminal();
    }, 300);
    const timer2 = setTimeout(() => {
      if (cancelled) return;
      resizeAttempts = 0;
      lastHeight = -1;
      resizeTerminal();
    }, 600);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      parent?.removeEventListener("transitionend", handleTransitionEnd);
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, [fullscreen, sessionId, projectId, resizeTerminalMux, containerRef, fitAddon, terminalInstance]);
}
