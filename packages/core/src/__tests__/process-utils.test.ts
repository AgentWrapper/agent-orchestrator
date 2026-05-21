import { afterEach, describe, expect, it, vi } from "vitest";
import { isProcessAlive } from "../process-utils.js";

describe("isProcessAlive", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not signal invalid pids", () => {
    const kill = vi.spyOn(process, "kill");

    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("treats EPERM as alive", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("denied") as Error & { code: string };
      error.code = "EPERM";
      throw error;
    });

    expect(isProcessAlive(123)).toBe(true);
  });

  it("treats missing processes as not alive", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("gone") as Error & { code: string };
      error.code = "ESRCH";
      throw error;
    });

    expect(isProcessAlive(123)).toBe(false);
  });
});
