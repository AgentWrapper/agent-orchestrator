import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let parseAsync: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  parseAsync = vi.fn().mockResolvedValue(undefined);
  vi.doMock("../src/program.js", () => ({
    createProgram: () => ({ parseAsync }),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

vi.mock("../src/lib/update-check.js", () => ({
  maybeShowUpdateNotice: vi.fn(),
  scheduleBackgroundRefresh: vi.fn(),
}));

describe("cli entrypoint", () => {
  it("parses the created program", async () => {
    await import("../src/index.js");
    expect(parseAsync).toHaveBeenCalledOnce();
  });

  it("prints a clean message and exits 1 on ConfigNotFoundError", async () => {
    const { ConfigNotFoundError } = await import("@aoagents/ao-core");
    const error = new ConfigNotFoundError();
    let rejectionHandler:
      | ((reason: unknown) => unknown)
      | undefined;

    parseAsync.mockImplementation(
      () => {
        const chainable = {
          catch: (handler: (reason: unknown) => unknown) => {
            rejectionHandler = handler;
            return chainable;
          },
          then: (_fn: () => void) => chainable,
        };
        return chainable as unknown as Promise<void>;
      },
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    await import("../src/index.js");

    expect(rejectionHandler).toBeTypeOf("function");
    rejectionHandler?.(error);

    expect(errorSpy).toHaveBeenCalledWith(`Error: ${error.message}`);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("re-throws non-ConfigNotFoundError errors", async () => {
    const error = new Error("unexpected");
    let rejectionHandler:
      | ((reason: unknown) => unknown)
      | undefined;

    parseAsync.mockImplementation(
      () => {
        const chainable = {
          catch: (handler: (reason: unknown) => unknown) => {
            rejectionHandler = handler;
            return chainable;
          },
          then: (_fn: () => void) => chainable,
        };
        return chainable as unknown as Promise<void>;
      },
    );

    await import("../src/index.js");

    expect(rejectionHandler).toBeTypeOf("function");
    expect(() => rejectionHandler?.(error)).toThrow(error);
  });
});
