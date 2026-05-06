/**
 * Touch scroll support for xterm.js terminals.
 *
 * Provides native-feeling vertical swipe scrolling on mobile devices.
 * - Normal buffer: calls terminal.scrollLines() to scroll the scrollback.
 * - Alternate buffer (tmux, vim, etc.): enters tmux copy-mode and sends arrow keys.
 *
 * Usage:
 *   const cleanup = attachTouchScroll(terminal, (data) => writeTerminal(id, data));
 *   // later: cleanup();
 */

// Minimal interface matching the xterm Terminal members actually used here
interface TerminalLike {
  element: HTMLElement | undefined;
  buffer: { active: { type: string } };
  options: { fontSize?: number };
  scrollLines(amount: number): void;
}

export interface TouchScrollConfig {
  /** Pixels of movement before gesture direction is decided. Default: 8 */
  deadZone?: number;
  /** Ratio for vertical vs horizontal dominance. Default: 1.5 */
  verticalDominance?: number;
  /** Max lines scrolled per pointer event. Default: 6 */
  maxLinesPerEvent?: number;
  /** Speed multiplier for scroll amount. Default: 3 */
  speedMultiplier?: number;
  /** tmux prefix key (e.g. "\x02" for Ctrl-b, "\x01" for Ctrl-a). Default: "\x02" */
  tmuxPrefix?: string;
  /**
   * Called whenever the user swipes to view older content (scrolls away from
   * the live tail). Fires for both normal and alternate buffers. The viewport
   * `scroll` listener already covers normal-buffer scroll-away in xterm, but
   * in alternate buffer (tmux/vim) the viewport never scrolls, so this is the
   * only signal available.
   */
  onScrollAway?: () => void;
  /**
   * Called whenever the user swipes toward newer content. Lets the host
   * re-arm an idle timer that may auto-resume the live tail.
   */
  onScrollTowardLatest?: () => void;
}

const DEFAULT_CONFIG: Required<Omit<TouchScrollConfig, "onScrollAway" | "onScrollTowardLatest">> = {
  deadZone: 8,
  verticalDominance: 1.5,
  maxLinesPerEvent: 6,
  speedMultiplier: 3,
  tmuxPrefix: "\x02",
};

/**
 * Attach touch scroll handlers to an xterm terminal.
 * `sendData` writes raw terminal input (used for tmux copy-mode in alternate buffer).
 * Returns a cleanup function to remove the listeners.
 */
export function attachTouchScroll(
  terminal: TerminalLike,
  sendData: (data: string) => void,
  config: TouchScrollConfig = {},
): () => void {
  const opts = { ...DEFAULT_CONFIG, ...config };
  const touchRoot = terminal.element;

  if (!touchRoot) {
    return () => {};
  }

  // touch-action:none on the outer element (and all descendants) prevents the
  // browser from taking over the gesture mid-swipe as a native pan. Without
  // this, xterm@5's canvas overlay combined with pan-y causes pointermove to
  // stop firing after the first event, giving the "scrolls once per swipe" bug.
  const prevTouchAction = touchRoot.style.touchAction;
  touchRoot.style.touchAction = "none";
  const viewport = touchRoot.querySelector<HTMLElement>(".xterm-viewport");
  if (viewport) {
    viewport.style.touchAction = "none";
  }

  let startX = 0;
  let startY = 0;
  let lastY = 0;
  let scrollMode: boolean | null = null; // null = undecided, true = scroll, false = not scroll
  let enteredCopyMode = false;

  const lineHeight = () => (terminal.options.fontSize ?? 13) * 1.2;

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    startX = e.clientX;
    startY = e.clientY;
    lastY = e.clientY;
    scrollMode = null;
    enteredCopyMode = false;
  };

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // Decide gesture direction once movement exceeds dead zone
    if (scrollMode === null) {
      if (Math.max(absDx, absDy) < opts.deadZone) return;
      if (absDy < opts.verticalDominance * absDx) {
        scrollMode = false; // horizontal gesture, ignore
        return;
      }
      scrollMode = true;
      try {
        touchRoot.setPointerCapture(e.pointerId);
      } catch {
        // Element may be detached
      }
    }

    if (scrollMode !== true) return;

    e.preventDefault();

    let lineDelta = Math.round((e.clientY - lastY) / lineHeight());
    if (lineDelta > opts.maxLinesPerEvent) lineDelta = opts.maxLinesPerEvent;
    if (lineDelta < -opts.maxLinesPerEvent) lineDelta = -opts.maxLinesPerEvent;
    if (lineDelta === 0) return;

    lastY = e.clientY;

    const boostedDelta = lineDelta * opts.speedMultiplier;

    // Notify host of direction so it can manage followOutput / idle timers.
    // lineDelta > 0 = swipe down = view older content (scroll away from live tail).
    // lineDelta < 0 = swipe up   = view newer content (toward live tail).
    if (lineDelta > 0) {
      config.onScrollAway?.();
    } else {
      config.onScrollTowardLatest?.();
    }

    if (terminal.buffer.active.type === "normal") {
      // Natural touch-scroll direction: swipe finger DOWN (lineDelta > 0)
      // moves content down with the finger, revealing older scrollback above.
      // xterm's scrollLines(N) with positive N scrolls toward the BOTTOM of
      // the buffer (live tail / newer), so negate to match finger direction.
      terminal.scrollLines(-boostedDelta);
    } else {
      // Alternate buffer — use tmux copy-mode with arrow keys
      // Enter copy mode once per gesture
      if (!enteredCopyMode) {
        enteredCopyMode = true;
        sendData(opts.tmuxPrefix + "[");
      }
      // Invert: swipe up → scroll down (older), swipe down → scroll up (newer)
      const arrowKey = lineDelta > 0 ? "\x1b[A" : "\x1b[B";
      const count = Math.abs(boostedDelta);
      for (let i = 0; i < count; i++) {
        sendData(arrowKey);
      }
    }
  };

  const onPointerEnd = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    try {
      if (touchRoot.hasPointerCapture(e.pointerId)) {
        touchRoot.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore
    }
    scrollMode = null;
  };

  const captureOpts: AddEventListenerOptions = { capture: true };
  const moveCaptureOpts: AddEventListenerOptions = { capture: true, passive: false };

  touchRoot.addEventListener("pointerdown", onPointerDown, captureOpts);
  touchRoot.addEventListener("pointermove", onPointerMove, moveCaptureOpts);
  touchRoot.addEventListener("pointerup", onPointerEnd, captureOpts);
  touchRoot.addEventListener("pointercancel", onPointerEnd, captureOpts);

  return () => {
    touchRoot.removeEventListener("pointerdown", onPointerDown, captureOpts);
    touchRoot.removeEventListener("pointermove", onPointerMove, moveCaptureOpts);
    touchRoot.removeEventListener("pointerup", onPointerEnd, captureOpts);
    touchRoot.removeEventListener("pointercancel", onPointerEnd, captureOpts);
    touchRoot.style.touchAction = prevTouchAction;
  };
}
