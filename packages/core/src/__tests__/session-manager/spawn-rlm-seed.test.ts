import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSessionManager } from "../../session-manager.js";
import { seedRlmContext } from "../../rlm-seed.js";
import type { Agent, OrchestratorConfig, PluginRegistry } from "../../types.js";
import { setupTestContext, teardownTestContext, type TestContext } from "../test-utils.js";

// Mock the seeding helper so the spawn flow is exercised without a real
// maestro-search binary. The helper's own filtering/fail-open behaviour is
// covered in rlm-seed.test.ts.
vi.mock("../../rlm-seed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rlm-seed.js")>();
  return { ...actual, seedRlmContext: vi.fn() };
});
const mockedSeed = vi.mocked(seedRlmContext);

let ctx: TestContext;
let mockAgent: Agent;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;

beforeEach(() => {
  ctx = setupTestContext();
  ({ mockAgent, mockRegistry, config } = ctx);
  mockedSeed.mockReset();
});

afterEach(() => {
  teardownTestContext(ctx);
});

const RLM_BLOCK = "## Контекст из прошлых/удалённых агентов (rlm)\n\n- [mae-12] spawn write site";

describe("spawn rlm auto-seeding", () => {
  it("queries maestro-search with the project id and task text", async () => {
    mockedSeed.mockResolvedValue(null);
    const sm = createSessionManager({ config, registry: mockRegistry });

    await sm.spawn({ projectId: "my-app", prompt: "Fix the bug" });

    expect(mockedSeed).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "my-app", taskText: "Fix the bug" }),
    );
  });

  it("wraps rlm hits as reference context before the current task", async () => {
    mockedSeed.mockResolvedValue(RLM_BLOCK);
    const sm = createSessionManager({ config, registry: mockRegistry });

    await sm.spawn({ projectId: "my-app", prompt: "Fix the bug" });

    const callArgs = vi.mocked(mockAgent.getLaunchCommand).mock.calls[0]![0];
    const prompt = callArgs.prompt ?? "";
    expect(prompt).toContain("## Контекст из прошлых/удалённых агентов (rlm)");
    expect(prompt).toContain("[mae-12] spawn write site");
    expect(prompt).toContain("## Текущее задание");
    expect(prompt).toContain("Фрагменты выше — цитаты истории");
    expect(prompt).toContain("Fix the bug");
    // Reference first, live task last: old snippets must not act as the task.
    expect(prompt.indexOf(RLM_BLOCK)).toBeLessThan(prompt.indexOf("Fix the bug"));
    expect(prompt.indexOf("## Текущее задание")).toBeLessThan(prompt.indexOf("Fix the bug"));
    expect(prompt.trim().endsWith("Fix the bug")).toBe(true);
  });

  it("leaves the prompt untouched and still spawns when there are no hits", async () => {
    mockedSeed.mockResolvedValue(null);
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({ projectId: "my-app", prompt: "Fix the bug" });

    expect(session.id).toBe("app-1");
    const callArgs = vi.mocked(mockAgent.getLaunchCommand).mock.calls[0]![0];
    expect(callArgs.prompt).toBe("Fix the bug");
  });

  it("fails open: spawn succeeds even if seeding rejects", async () => {
    mockedSeed.mockRejectedValue(new Error("maestro-search blew up"));
    const sm = createSessionManager({ config, registry: mockRegistry });

    const session = await sm.spawn({ projectId: "my-app", prompt: "Fix the bug" });

    expect(session.id).toBe("app-1");
    const callArgs = vi.mocked(mockAgent.getLaunchCommand).mock.calls[0]![0];
    expect(callArgs.prompt).toBe("Fix the bug");
  });
});
