import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { OrchestratorEvent } from "../types.js";
import {
  appendDashboardNotificationRecord,
  createDashboardNotificationRecord,
  normalizeDashboardNotificationLimit,
  readDashboardNotificationsFromFile,
  writeDashboardNotificationsToFile,
} from "../dashboard-notifications.js";

let tempDir: string | null = null;

function makeTempPath(): string {
  tempDir = mkdtempSync(join(tmpdir(), "ao-dashboard-notifications-"));
  return join(tempDir, "dashboard-notifications.jsonl");
}

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "ci.failing",
    priority: "action",
    sessionId: "app-1",
    projectId: "demo",
    timestamp: new Date("2026-05-13T10:00:00.000Z"),
    message: "CI is failing",
    data: { prUrl: "https://github.com/acme/app/pull/1" },
    ...overrides,
  };
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("dashboard notifications", () => {
  it("serializes events and actions into dashboard records", () => {
    const record = createDashboardNotificationRecord(
      makeEvent(),
      [{ label: "View PR", url: "https://github.com/acme/app/pull/1" }],
      new Date("2026-05-13T11:00:00.000Z"),
    );

    expect(record.id).toBe("evt-1:2026-05-13T11:00:00.000Z");
    expect(record.event.timestamp).toBe("2026-05-13T10:00:00.000Z");
    expect(record.event.data.prUrl).toBe("https://github.com/acme/app/pull/1");
    expect(record.actions).toEqual([
      { label: "View PR", url: "https://github.com/acme/app/pull/1" },
    ]);
  });

  it("writes and reads JSONL records", () => {
    const filePath = makeTempPath();
    const record = createDashboardNotificationRecord(makeEvent());

    writeDashboardNotificationsToFile(filePath, [record], 50);

    expect(readDashboardNotificationsFromFile(filePath)).toEqual([record]);
    expect(readFileSync(filePath, "utf-8")).toContain('"sessionId":"app-1"');
  });

  it("retains only the latest limit records", () => {
    const filePath = makeTempPath();
    for (let i = 1; i <= 4; i++) {
      appendDashboardNotificationRecord(
        filePath,
        createDashboardNotificationRecord(
          makeEvent({ id: `evt-${i}` }),
          undefined,
          new Date(`2026-05-13T11:00:0${i}.000Z`),
        ),
        2,
      );
    }

    expect(
      readDashboardNotificationsFromFile(filePath, 50).map((record) => record.event.id),
    ).toEqual(["evt-3", "evt-4"]);
  });

  it("skips malformed JSONL lines", () => {
    const filePath = makeTempPath();
    const record = createDashboardNotificationRecord(makeEvent());
    writeFileSync(filePath, `not-json\n${JSON.stringify(record)}\n{"id":"bad"}\n`, "utf-8");

    expect(readDashboardNotificationsFromFile(filePath)).toEqual([record]);
  });

  it("clamps invalid limits", () => {
    expect(normalizeDashboardNotificationLimit(undefined)).toBe(50);
    expect(normalizeDashboardNotificationLimit(0)).toBe(1);
    expect(normalizeDashboardNotificationLimit("1000")).toBe(500);
    expect(normalizeDashboardNotificationLimit("75")).toBe(75);
  });
});
