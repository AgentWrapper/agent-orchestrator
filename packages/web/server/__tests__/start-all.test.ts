import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHUTDOWN_GRACE_MS,
  formatCleanShutdownMessage,
  formatForceKillFallbackMessage,
  getShutdownGraceMs,
} from "../start-all.js";

describe("start-all shutdown diagnostics", () => {
  it("uses a 15s default shutdown grace window with env override", () => {
    expect(DEFAULT_SHUTDOWN_GRACE_MS).toBe(15_000);
    expect(getShutdownGraceMs({})).toBe(15_000);
    expect(getShutdownGraceMs({ AO_SHUTDOWN_GRACE_MS: "30000" })).toBe(30_000);
    expect(getShutdownGraceMs({ AO_SHUTDOWN_GRACE_MS: "nope" })).toBe(15_000);
    expect(getShutdownGraceMs({ AO_SHUTDOWN_GRACE_MS: "0.5" })).toBe(15_000);
    expect(getShutdownGraceMs({ AO_SHUTDOWN_GRACE_MS: "1500.9" })).toBe(1_500);
  });

  it("keeps shutdown log wording explicit about clean vs safety-fallback exits", () => {
    expect(`info: ${formatCleanShutdownMessage(1234)}`).toMatchInlineSnapshot(
      `"info: all children shut down cleanly in 1234ms"`,
    );
    expect(`warn: ${formatForceKillFallbackMessage("next", 15000)}`).toMatchInlineSnapshot(
      `"warn: next did not exit within 15000ms — sent SIGKILL (safety fallback, no orphans leaked)"`,
    );
  });
});
