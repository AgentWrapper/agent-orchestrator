import { afterEach, describe, expect, it, vi } from "vitest";

interface MockPty {
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  exit?: (event: { exitCode: number }) => void;
}

describe("TerminalManager", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.doUnmock("node-pty");
    vi.doUnmock("node:child_process");
  });

  it("keeps the PTY alive across brief subscriber gaps", async () => {
    vi.useFakeTimers();

    const ptys: MockPty[] = [];
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawn: vi.fn(() => ({ on: vi.fn() })),
        execFileSync: vi.fn(() => Buffer.from("")),
      };
    });
    const ptySpawn = vi.fn(() => {
      const pty: MockPty = {
        onData: vi.fn(),
        onExit: vi.fn((callback: (event: { exitCode: number }) => void) => {
          pty.exit = callback;
        }),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(() => pty.exit?.({ exitCode: 0 })),
      };
      ptys.push(pty);
      return pty;
    });
    vi.doMock("node-pty", () => ({ spawn: ptySpawn }));

    const { TerminalManager } = await import("../mux-websocket");
    const manager = new TerminalManager("/usr/bin/true");

    const firstUnsubscribe = manager.subscribe(
      "session-abc",
      vi.fn(),
      undefined,
      "tmux-session-abc",
    );
    expect(ptySpawn).toHaveBeenCalledTimes(1);

    firstUnsubscribe();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(ptys[0]?.kill).not.toHaveBeenCalled();

    const secondUnsubscribe = manager.subscribe(
      "session-abc",
      vi.fn(),
      undefined,
      "tmux-session-abc",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ptySpawn).toHaveBeenCalledTimes(1);
    expect(ptys[0]?.kill).not.toHaveBeenCalled();

    secondUnsubscribe();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ptys[0]?.kill).toHaveBeenCalledTimes(1);
  });
});
