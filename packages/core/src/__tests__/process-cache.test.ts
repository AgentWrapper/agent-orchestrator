import { describe, it, expect, vi, beforeEach } from "vitest";
import { memoizeAsync, _clearProcessCacheForTests } from "../process-cache.js";

beforeEach(() => {
  _clearProcessCacheForTests();
});

describe("memoizeAsync", () => {
  it("runs the underlying fn only once for a given key", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    await memoizeAsync("k", fn);
    await memoizeAsync("k", fn);
    await memoizeAsync("k", fn);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns the same resolved value across calls", async () => {
    const fn = vi.fn().mockResolvedValue({ value: 42 });

    const a = await memoizeAsync("k", fn);
    const b = await memoizeAsync("k", fn);

    expect(a).toBe(b);
  });

  it("uses different keys for different work", async () => {
    const fnA = vi.fn().mockResolvedValue("a");
    const fnB = vi.fn().mockResolvedValue("b");

    expect(await memoizeAsync("a", fnA)).toBe("a");
    expect(await memoizeAsync("b", fnB)).toBe("b");
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);
  });

  it("caches rejections too — failed checks don't re-run within a process", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(memoizeAsync("k", fn)).rejects.toThrow("boom");
    await expect(memoizeAsync("k", fn)).rejects.toThrow("boom");

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns the in-flight promise to concurrent callers (no double-fire)", async () => {
    let resolveFn: (v: string) => void = () => {};
    const fn = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );

    const a = memoizeAsync("k", fn);
    const b = memoizeAsync("k", fn);

    expect(fn).toHaveBeenCalledTimes(1);

    resolveFn("done");
    expect(await a).toBe("done");
    expect(await b).toBe("done");
  });
});
