import { describe, it, expect, vi } from "vitest";
import { CleanupStack } from "../cleanup-stack.js";

describe("CleanupStack", () => {
  it("runs nothing on an empty stack", async () => {
    const stack = new CleanupStack();
    await expect(stack.runAll()).resolves.toBeUndefined();
  });

  it("runs pushed cleanups in LIFO order", async () => {
    const calls: string[] = [];
    const stack = new CleanupStack();
    stack.push(() => {
      calls.push("a");
    });
    stack.push(() => {
      calls.push("b");
    });
    stack.push(() => {
      calls.push("c");
    });

    await stack.runAll();

    expect(calls).toEqual(["c", "b", "a"]);
  });

  it("does not run any cleanups after dismiss()", async () => {
    const fn = vi.fn();
    const stack = new CleanupStack();
    stack.push(fn);

    stack.dismiss();
    await stack.runAll();

    expect(fn).not.toHaveBeenCalled();
  });

  it("awaits async cleanups", async () => {
    const calls: string[] = [];
    const stack = new CleanupStack();
    stack.push(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      calls.push("first-pushed");
    });
    stack.push(() => {
      calls.push("second-pushed");
    });

    await stack.runAll();

    // LIFO: second-pushed runs first (sync), then async first-pushed completes.
    expect(calls).toEqual(["second-pushed", "first-pushed"]);
  });

  it("continues running subsequent cleanups when one throws", async () => {
    const calls: string[] = [];
    const stack = new CleanupStack();
    stack.push(() => {
      calls.push("a");
    });
    stack.push(() => {
      throw new Error("boom");
    });
    stack.push(() => {
      calls.push("c");
    });

    await stack.runAll();

    // c runs first (LIFO), middle throws but is swallowed, a still runs.
    expect(calls).toEqual(["c", "a"]);
  });

  it("forwards thrown errors to the onError callback when provided", async () => {
    const errors: unknown[] = [];
    const stack = new CleanupStack();
    stack.push(() => {
      throw new Error("first");
    });
    stack.push(async () => {
      throw new Error("second");
    });

    await stack.runAll((err) => errors.push(err));

    expect(errors).toHaveLength(2);
    expect((errors[0] as Error).message).toBe("second"); // LIFO
    expect((errors[1] as Error).message).toBe("first");
  });

  it("is a no-op when runAll is called twice", async () => {
    const fn = vi.fn();
    const stack = new CleanupStack();
    stack.push(fn);

    await stack.runAll();
    await stack.runAll();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("treats push after dismiss as a no-op (cleanup will not run)", async () => {
    const fn = vi.fn();
    const stack = new CleanupStack();
    stack.dismiss();
    stack.push(fn);

    await stack.runAll();

    expect(fn).not.toHaveBeenCalled();
  });

  it("treats push after runAll as a no-op (symmetric with dismiss)", async () => {
    const fn = vi.fn();
    const stack = new CleanupStack();
    await stack.runAll();
    stack.push(fn);

    await stack.runAll();

    expect(fn).not.toHaveBeenCalled();
  });
});
