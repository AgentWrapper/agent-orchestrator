import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionTransitionNotificationData,
  getDashboardNotificationStorePath,
  readDashboardNotifications,
  type OrchestratorEvent,
} from "@aoagents/ao-core";
import { create, manifest } from "./index.js";

let tempDir: string | null = null;

function makeConfigPath(): string {
  tempDir = mkdtempSync(join(tmpdir(), "ao-dashboard-plugin-"));
  return join(tempDir, "agent-orchestrator.yaml");
}

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "session.needs_input",
    priority: "action",
    sessionId: "worker-1",
    projectId: "demo",
    timestamp: new Date("2026-05-13T12:00:00.000Z"),
    message: "Agent needs input",
    data: buildSessionTransitionNotificationData({
      eventType: "session.needs_input",
      sessionId: "worker-1",
      projectId: "demo",
      context: {
        pr: {
          number: 1,
          url: "https://github.com/acme/app/pull/1",
          title: "Demo PR",
          branch: "demo/pr",
          baseBranch: "main",
          owner: "acme",
          repo: "app",
          isDraft: false,
        },
        issueId: null,
        issueTitle: null,
        summary: "Demo session",
        branch: "demo/pr",
      },
      oldStatus: "working",
      newStatus: "needs_input",
    }),
    ...overrides,
  };
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
  vi.restoreAllMocks();
});

describe("notifier-dashboard", () => {
  it("has dashboard notifier metadata", () => {
    expect(manifest.name).toBe("dashboard");
    expect(manifest.slot).toBe("notifier");
  });

  it("persists notifications to the config-specific dashboard store", async () => {
    const configPath = makeConfigPath();
    const notifier = create({ configPath, limit: 50 });

    await notifier.notify(makeEvent());

    const records = readDashboardNotifications(configPath);
    expect(records).toHaveLength(1);
    expect(records[0].event.sessionId).toBe("worker-1");
    expect(records[0].event.data).toMatchObject({
      schemaVersion: 3,
      subject: { pr: { url: "https://github.com/acme/app/pull/1" } },
    });
  });

  it("persists actions with notifications", async () => {
    const configPath = makeConfigPath();
    const notifier = create({ configPath });

    await notifier.notifyWithActions?.(makeEvent(), [
      { label: "Open PR", url: "https://github.com/acme/app/pull/1" },
    ]);

    const records = readDashboardNotifications(configPath);
    expect(records[0].actions).toEqual([
      { label: "Open PR", url: "https://github.com/acme/app/pull/1" },
    ]);
  });

  it("retains only the configured limit", async () => {
    const configPath = makeConfigPath();
    const notifier = create({ configPath, limit: 2 });

    await notifier.notify(makeEvent({ id: "evt-1" }));
    await notifier.notify(makeEvent({ id: "evt-2" }));
    await notifier.notify(makeEvent({ id: "evt-3" }));

    expect(readDashboardNotifications(configPath, 50).map((record) => record.event.id)).toEqual([
      "evt-2",
      "evt-3",
    ]);
  });

  it("warns and no-ops when configPath is missing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const notifier = create();

    await notifier.notify(makeEvent());

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No configPath available"));
  });

  it("uses the expected store path shape", () => {
    const configPath = makeConfigPath();
    expect(getDashboardNotificationStorePath(configPath)).toContain(
      "dashboard-notifications.jsonl",
    );
  });
});
