import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSessionManager, waitForComposerReady } from "../session-manager.js";
import { seedRlmContext } from "../rlm-seed.js";
import type { RuntimeHandle } from "../types.js";
import { setupTestContext, teardownTestContext, type TestContext } from "./test-utils.js";

// Seeding is exercised elsewhere (spawn-rlm-seed.test.ts); mock it to null so the
// worker prompt equals the user prompt and these assertions stay focused on the
// delivery path.
vi.mock("../rlm-seed.js", () => ({ seedRlmContext: vi.fn() }));
const mockedSeed = vi.mocked(seedRlmContext);

const HANDLE: RuntimeHandle = { id: "h1", runtimeName: "mock", data: {} };

describe("waitForComposerReady", () => {
  it("resolves once output is non-empty and stable across polls", async () => {
    const runtime = {
      getOutput: vi.fn().mockResolvedValue("$ ready\n"),
      isAlive: vi.fn().mockResolvedValue(true),
    };
    await waitForComposerReady(runtime, HANDLE, 1000, 1);
    expect(runtime.getOutput).toHaveBeenCalled();
  });

  it("returns early (without reading output) when the runtime is not alive", async () => {
    const runtime = {
      getOutput: vi.fn().mockResolvedValue(""),
      isAlive: vi.fn().mockResolvedValue(false),
    };
    await waitForComposerReady(runtime, HANDLE, 1000, 1);
    expect(runtime.getOutput).not.toHaveBeenCalled();
  });

  it("returns at the deadline when output never stabilizes (no hang)", async () => {
    let n = 0;
    const runtime = {
      getOutput: vi.fn().mockImplementation(() => Promise.resolve(`changing-${n++}\n`)),
      isAlive: vi.fn().mockResolvedValue(true),
    };
    await waitForComposerReady(runtime, HANDLE, 50, 10);
    expect(runtime.getOutput).toHaveBeenCalled();
  });
});

describe("initial-prompt delivery path", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupTestContext();
    mockedSeed.mockReset();
    mockedSeed.mockResolvedValue(null);
  });

  afterEach(() => {
    teardownTestContext(ctx);
  });

  it("inline agents deliver the prompt via the launch command, not sendMessage", async () => {
    const { config, mockRegistry, mockRuntime, mockAgent } = ctx;
    const sm = createSessionManager({ config, registry: mockRegistry });

    await sm.spawn({ projectId: "my-app", prompt: "INLINE-TASK" });

    // The prompt is baked into the launch command (positional/flag arg) — the
    // racy typed-into-the-TUI path is never used for inline agents.
    const launchConfig = vi.mocked(mockAgent.getLaunchCommand).mock.calls[0]![0];
    expect(launchConfig.prompt).toBe("INLINE-TASK");
    expect(mockRuntime.sendMessage).not.toHaveBeenCalled();
  });

  it("post-launch agents wait for composer readiness, then send the prompt", async () => {
    const { config, mockRegistry, mockRuntime, mockAgent } = ctx;
    // Only post-launch agents (e.g. grok) type the initial task into the TUI.
    (mockAgent as { promptDelivery?: string }).promptDelivery = "post-launch";
    const sm = createSessionManager({ config, registry: mockRegistry });

    await sm.spawn({ projectId: "my-app", prompt: "POST-TASK" });

    // Readiness probe ran (output polled) before the prompt was delivered.
    expect(mockRuntime.getOutput).toHaveBeenCalled();
    expect(mockRuntime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      "POST-TASK",
    );
  });
});
