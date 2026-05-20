import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodeReviewStore, type CodeReviewStore } from "../code-review-store.js";

let storeDir: string;
let store: CodeReviewStore;

beforeEach(() => {
  storeDir = join(tmpdir(), `ao-test-code-review-store-${randomUUID()}`);
  mkdirSync(storeDir, { recursive: true });
  store = createCodeReviewStore("app", { storeDir });
});

afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true });
});

describe("CodeReviewStore", () => {
  it("creates runs and lists summaries with finding counts", () => {
    const run = store.createRun(
      {
        linkedSessionId: "app-1",
        reviewerSessionId: "app-rev-1",
        status: "needs_triage",
        targetSha: "abc123",
        prNumber: 42,
      },
      new Date("2026-05-10T10:00:00.000Z"),
    );

    store.createFinding(
      {
        runId: run.id,
        linkedSessionId: "app-1",
        severity: "error",
        title: "Missing guard",
        body: "The handler reads a nullable value without checking it.",
        filePath: "src/auth.ts",
        startLine: 12,
        fingerprint: "auth-guard",
      },
      new Date("2026-05-10T10:01:00.000Z"),
    );
    const dismissed = store.createFinding(
      {
        runId: run.id,
        linkedSessionId: "app-1",
        severity: "info",
        title: "Naming nit",
        body: "Consider a clearer name.",
      },
      new Date("2026-05-10T10:02:00.000Z"),
    );
    store.updateFinding(dismissed.id, { status: "dismissed", dismissedBy: "operator" });

    const summaries = store.listRunSummaries({ linkedSessionId: "app-1" });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: run.id,
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
      status: "needs_triage",
      findingCount: 2,
      openFindingCount: 1,
      dismissedFindingCount: 1,
    });
  });

  it("filters runs and findings independently", () => {
    const first = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
      status: "clean",
    });
    const second = store.createRun({
      linkedSessionId: "app-2",
      reviewerSessionId: "app-rev-2",
      status: "failed",
    });
    store.createFinding({
      runId: second.id,
      linkedSessionId: "app-2",
      severity: "warning",
      title: "Race condition",
      body: "This update can be lost.",
    });

    expect(store.listRuns({ status: "clean" }).map((run) => run.id)).toEqual([first.id]);
    expect(store.listRuns({ linkedSessionId: "app-2" }).map((run) => run.id)).toEqual([second.id]);
    expect(store.listFindings({ linkedSessionId: "app-1" })).toEqual([]);
    expect(store.listFindings({ linkedSessionId: "app-2" })).toHaveLength(1);
  });

  it("rejects path traversal ids", () => {
    expect(() => store.getRun("../bad")).toThrow(/Unsafe review run id/);
    expect(() => store.getFinding("../bad")).toThrow(/Unsafe review finding id/);
  });
});
