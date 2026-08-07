import { describe, expect, it, vi } from "vitest";

import { SECTION_VIEWED_OBSERVER_OPTIONS } from "./use-section-viewed";

describe("section-viewed observer options", () => {
  /**
   * A fractional threshold is unsatisfiable for any section taller than the
   * viewport, because intersectionRatio is measured against the element, not the
   * screen. The features section is ~3000px tall; in a ~770px viewport a 0.4
   * threshold needs ~1200px of it visible at once, which can never happen.
   *
   * Observed before this was fixed: scrolling the whole page reported only the
   * hero, and every taller section below it silently reported nothing.
   */
  it("uses a zero threshold so tall sections can fire at all", () => {
    expect(SECTION_VIEWED_OBSERVER_OPTIONS.threshold).toBe(0);
  });

  it("bounds visibility with rootMargin rather than a ratio", () => {
    // Requires the section to reach the upper part of the viewport, so grazing
    // the bottom edge while scrolling past is not counted as "reached".
    expect(SECTION_VIEWED_OBSERVER_OPTIONS.rootMargin).toMatch(/-\d+%/);
  });

  it("never reintroduces a fractional threshold", () => {
    const { threshold } = SECTION_VIEWED_OBSERVER_OPTIONS;
    expect(typeof threshold === "number" && threshold > 0 && threshold < 1).toBe(false);
  });
});

describe("reporting once per section", () => {
  /**
   * An IntersectionObserver re-fires every time an element re-enters view, so
   * without the disconnect a visitor scrolling up and down a long page would
   * emit the same event repeatedly. That repeating shape is what produced AO's
   * original PostHog bill, so it is worth pinning.
   */
  it("disconnects after the first intersection", async () => {
    const disconnect = vi.fn();
    const observe = vi.fn();
    let fire: (entries: { isIntersecting: boolean }[]) => void = () => {};

    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
          fire = cb;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );

    const captured: string[] = [];
    vi.doMock("./index", () => ({
      track: (event: string) => captured.push(event),
    }));

    const { attachSectionObserver } = await import("./use-section-viewed");
    const node = { nodeType: 1 } as unknown as HTMLElement;
    attachSectionObserver(node, "features", (event) => captured.push(event));

    fire([{ isIntersecting: true }]);
    fire([{ isIntersecting: true }]);
    fire([{ isIntersecting: true }]);

    expect(captured).toEqual(["features"]);
    expect(disconnect).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });
});
