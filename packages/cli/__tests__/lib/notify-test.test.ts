import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  closeDb,
  readObservabilitySummary,
  type Notifier,
  type OrchestratorConfig,
  type OrchestratorEvent,
  type PluginRegistry,
} from "@aoagents/ao-core";
import {
  addSinkNotifierConfig,
  createNotifyTestEvent,
  parseNotifyDataJson,
  resolveNotifyTestTargets,
  runNotifyTest,
  startNotifySink,
} from "../../src/lib/notify-test.js";

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  const testHome = process.env["HOME"] ?? process.env["USERPROFILE"] ?? tmpdir();
  return {
    configPath: join(testHome, "agent-orchestrator.yaml"),
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["alerts"],
    },
    projects: {
      demo: {
        name: "Demo",
        path: "/tmp/demo",
        defaultBranch: "main",
        sessionPrefix: "demo",
      },
    },
    notifiers: {
      alerts: { plugin: "slack" },
      ops: { plugin: "slack" },
    },
    notificationRouting: {
      urgent: ["alerts"],
      action: ["alerts", "ops"],
      warning: ["ops"],
      info: ["alerts"],
    },
    reactions: {},
    ...overrides,
  };
}

function makeRegistry(notifiers: Record<string, Partial<Notifier> | undefined>): PluginRegistry {
  return {
    register: vi.fn(),
    get: vi.fn((slot: string, name: string) => {
      if (slot !== "notifier") return null;
      return notifiers[name] ?? null;
    }),
    list: vi.fn(() => []),
    loadBuiltins: vi.fn(),
    loadFromConfig: vi.fn(),
  } as unknown as PluginRegistry;
}

describe("notify test helper", () => {
  let tempRoot: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    tempRoot = join(tmpdir(), `ao-notify-test-${randomUUID()}`);
    mkdirSync(tempRoot, { recursive: true });
    originalHome = process.env["HOME"];
    originalUserProfile = process.env["USERPROFILE"];
    process.env["HOME"] = tempRoot;
    process.env["USERPROFILE"] = tempRoot;
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env["USERPROFILE"];
    } else {
      process.env["USERPROFILE"] = originalUserProfile;
    }
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("builds realistic CI and PR template data", () => {
    const { event } = createNotifyTestEvent({ templateName: "ci-failing" });

    expect(event.type).toBe("ci.failing");
    expect(event.priority).toBe("action");
    expect(event.data).toMatchObject({
      schemaVersion: 3,
      semanticType: "ci.failing",
      subject: {
        pr: {
          number: 1579,
          url: "https://github.com/ComposioHQ/agent-orchestrator/pull/1579",
        },
      },
      ci: {
        status: "failing",
        failedChecks: [
          { name: "typecheck", status: "failed" },
          { name: "unit-tests", status: "failed" },
        ],
      },
    });
    expect(event.data.prUrl).toBeUndefined();
  });

  it("merges valid --data JSON and rejects invalid JSON", () => {
    expect(parseNotifyDataJson('{"runId":"abc","attempt":2}')).toEqual({
      runId: "abc",
      attempt: 2,
    });
    expect(() => parseNotifyDataJson("{bad json")).toThrow("Invalid --data JSON");
    expect(() => parseNotifyDataJson('"not an object"')).toThrow("--data must be a JSON object");
  });

  it("resolves aliases and falls back to plugin-name registry lookup", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const registry = makeRegistry({
      slack: { name: "slack", notify },
    });

    const config = makeConfig();
    const result = await runNotifyTest(config, registry, { to: ["alerts"] });

    expect(result.ok).toBe(true);
    expect(result.targets).toEqual([{ reference: "alerts", pluginName: "slack" }]);
    expect(registry.get).toHaveBeenCalledWith("notifier", "alerts");
    expect(registry.get).toHaveBeenCalledWith("notifier", "slack");
    expect(notify).toHaveBeenCalledTimes(1);

    const summary = readObservabilitySummary(config);
    expect(summary.projects["demo"]?.metrics["notification_delivery"]?.success).toBe(1);
  });

  it("resolves explicit routes through notificationRouting before defaults", () => {
    const targets = resolveNotifyTestTargets(makeConfig(), "info", { route: "action" });

    expect(targets).toEqual([
      { reference: "alerts", pluginName: "slack" },
      { reference: "ops", pluginName: "slack" },
    ]);
  });

  it("deduplicates --all targets across configured, default, and routed refs", () => {
    const config = makeConfig({
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: ["alerts", "ops"],
      },
      notificationRouting: {
        urgent: ["alerts"],
        action: ["ops"],
        warning: ["alerts", "ops"],
        info: ["alerts"],
      },
    });

    const targets = resolveNotifyTestTargets(config, "info", { all: true });

    expect(targets.map((target) => target.reference)).toEqual(["alerts", "ops"]);
  });

  it("does not send in dry-run mode", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const registry = makeRegistry({
      alerts: { name: "alerts", notify },
    });

    const result = await runNotifyTest(makeConfig(), registry, { dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.deliveries[0]?.status).toBe("dry_run");
    expect(notify).not.toHaveBeenCalled();
    expect(readObservabilitySummary(makeConfig()).projects["demo"]).toBeUndefined();
  });

  it("uses notifyWithActions when available", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const notifyWithActions = vi.fn().mockResolvedValue(undefined);
    const registry = makeRegistry({
      alerts: { name: "alerts", notify, notifyWithActions },
    });

    const result = await runNotifyTest(makeConfig(), registry, { actions: true });

    expect(result.ok).toBe(true);
    expect(result.deliveries[0]?.method).toBe("notifyWithActions");
    expect(notifyWithActions).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("warns and falls back to notify when actions are unsupported", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const registry = makeRegistry({
      alerts: { name: "alerts", notify },
    });

    const result = await runNotifyTest(makeConfig(), registry, { actions: true });

    expect(result.ok).toBe(true);
    expect(result.deliveries[0]?.method).toBe("notify");
    expect(result.warnings[0]).toContain("notifyWithActions() is unavailable");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("continues after partial delivery failures", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("webhook failed"));
    const passing = vi.fn().mockResolvedValue(undefined);
    const registry = makeRegistry({
      alerts: { name: "alerts", notify: failing },
      ops: { name: "ops", notify: passing },
    });

    const config = makeConfig();
    const result = await runNotifyTest(config, registry, { route: "action" });

    expect(result.ok).toBe(false);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(passing).toHaveBeenCalledTimes(1);
    expect(result.deliveries.map((delivery) => delivery.status)).toEqual(["failed", "sent"]);
    const summary = readObservabilitySummary(config);
    expect(summary.projects["demo"]?.metrics["notification_delivery"]).toMatchObject({
      success: 1,
      failure: 1,
    });
  });

  it("reports unresolved targets and no-target configs as failures", async () => {
    const unresolved = await runNotifyTest(makeConfig(), makeRegistry({}), { to: ["missing"] });
    expect(unresolved.ok).toBe(false);
    expect(unresolved.deliveries[0]?.status).toBe("unresolved");

    const noTargets = await runNotifyTest(
      makeConfig({
        defaults: {
          runtime: "tmux",
          agent: "claude-code",
          workspace: "worktree",
          notifiers: [],
        },
        notifiers: {},
        notificationRouting: {
          urgent: [],
          action: [],
          warning: [],
          info: [],
        },
      }),
      makeRegistry({}),
    );
    expect(noTargets.ok).toBe(false);
    expect(noTargets.errors[0]).toContain("No notifier targets resolved");
  });

  it("captures a local webhook sink payload", async () => {
    const sink = await startNotifySink(0);
    try {
      const config = addSinkNotifierConfig(makeConfig({ notifiers: {} }), sink.url);
      const notify = vi.fn(async (event: OrchestratorEvent) => {
        await fetch(sink.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "notification", event }),
        });
      });
      const registry = makeRegistry({
        sink: { name: "sink", notify },
      });

      const result = await runNotifyTest(config, registry, { to: ["sink"] });
      const request = await sink.waitForRequest();

      expect(result.ok).toBe(true);
      expect(request?.json).toMatchObject({
        type: "notification",
        event: {
          message: "Test notification from ao notify test",
        },
      });
    } finally {
      await sink.close();
    }
  });
});
