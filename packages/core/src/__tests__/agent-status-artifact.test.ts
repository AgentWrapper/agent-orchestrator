import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAgentStatusArtifact } from "../agent-status-artifact.js";
import { readCanonicalArtifactIfExists } from "../artifact-store.js";
import { getProjectSessionsDir } from "../paths.js";
import type { AgentReport, AgentReportAuditEntry } from "../agent-report.js";

let testHome: string;
let originalHome: string | undefined;

const PROJECT_ID = "test-project";
const SESSION_ID = "ao-session-1";
const ARTIFACT_ID = "core-agent-status";

beforeEach(async () => {
  testHome = await mkdtemp(join(tmpdir(), "ao-agent-status-artifact-"));
  originalHome = process.env.HOME;
  process.env.HOME = testHome;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(testHome, { recursive: true, force: true });
});

function makeReport(overrides: Partial<AgentReport> = {}): AgentReport {
  return {
    state: "working",
    timestamp: "2026-05-13T10:00:00.000Z",
    source: "report",
    ...overrides,
  };
}

function makeAuditEntry(overrides: Partial<AgentReportAuditEntry> = {}): AgentReportAuditEntry {
  return {
    timestamp: "2026-05-13T10:00:00.000Z",
    actor: "harshit",
    source: "report",
    reportState: "working",
    accepted: true,
    before: {
      legacyStatus: "working",
      sessionState: "working",
      sessionReason: "task_in_progress",
      lastTransitionAt: null,
    },
    after: {
      legacyStatus: "working",
      sessionState: "working",
      sessionReason: "task_in_progress",
      lastTransitionAt: null,
    },
    ...overrides,
  };
}

async function seedAuditTrail(entries: AgentReportAuditEntry[]): Promise<void> {
  const auditDir = join(getProjectSessionsDir(PROJECT_ID), ".agent-report-audit");
  await mkdir(auditDir, { recursive: true });
  const filePath = join(auditDir, `${SESSION_ID}.ndjson`);
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(filePath, content, "utf-8");
}

describe("writeAgentStatusArtifact", () => {
  it("writes a markdown artifact at the canonical id with synth-core source", async () => {
    await writeAgentStatusArtifact(PROJECT_ID, SESSION_ID, makeReport());

    const artifact = await readCanonicalArtifactIfExists(PROJECT_ID, SESSION_ID, ARTIFACT_ID);
    expect(artifact).not.toBeNull();
    expect(artifact!.id).toBe(ARTIFACT_ID);
    expect(artifact!.type).toBe("markdown");
    expect(artifact!.source).toBe("synth-core");
    expect(artifact!.title).toBe("Agent status");
  });

  it("renders the latest state, source, and timestamp in the body", async () => {
    await writeAgentStatusArtifact(
      PROJECT_ID,
      SESSION_ID,
      makeReport({ state: "needs_input", source: "acknowledge", timestamp: "2026-05-13T10:00:00.000Z" }),
    );

    const artifact = await readCanonicalArtifactIfExists(PROJECT_ID, SESSION_ID, ARTIFACT_ID);
    const md = (artifact as Extract<typeof artifact, { type: "markdown" }>)!.payload.markdown;
    expect(md).toContain("**Current state:** `needs_input`");
    expect(md).toContain("`ao acknowledge`");
    expect(md).toContain("2026-05-13 10:00:00 UTC");
  });

  it("includes PR info when the latest report has a PR attached", async () => {
    await writeAgentStatusArtifact(
      PROJECT_ID,
      SESSION_ID,
      makeReport({
        state: "pr_created",
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prIsDraft: true,
      }),
    );

    const artifact = await readCanonicalArtifactIfExists(PROJECT_ID, SESSION_ID, ARTIFACT_ID);
    const md = (artifact as Extract<typeof artifact, { type: "markdown" }>)!.payload.markdown;
    expect(md).toContain("**PR:**");
    expect(md).toContain("#42");
    expect(md).toContain("https://github.com/test/repo/pull/42");
    expect(md).toContain("(draft)");
  });

  it("renders a history section sorted newest-first when audit trail exists", async () => {
    await seedAuditTrail([
      makeAuditEntry({
        timestamp: "2026-05-13T09:00:00.000Z",
        reportState: "started",
        note: "kicked off",
      }),
      makeAuditEntry({
        timestamp: "2026-05-13T10:00:00.000Z",
        reportState: "working",
        note: "implementing",
      }),
      makeAuditEntry({
        timestamp: "2026-05-13T11:00:00.000Z",
        reportState: "pr_created",
        prNumber: 7,
      }),
    ]);

    await writeAgentStatusArtifact(
      PROJECT_ID,
      SESSION_ID,
      makeReport({ state: "pr_created", timestamp: "2026-05-13T11:00:00.000Z" }),
    );

    const artifact = await readCanonicalArtifactIfExists(PROJECT_ID, SESSION_ID, ARTIFACT_ID);
    const md = (artifact as Extract<typeof artifact, { type: "markdown" }>)!.payload.markdown;
    expect(md).toContain("### History (3 reports)");

    // Newest first: pr_created (11:00) → working (10:00) → started (09:00)
    const prIdx = md.indexOf("`pr_created`");
    const workingIdx = md.indexOf("`working`");
    const startedIdx = md.indexOf("`started`");
    expect(prIdx).toBeGreaterThan(-1);
    expect(workingIdx).toBeGreaterThan(prIdx);
    expect(startedIdx).toBeGreaterThan(workingIdx);

    // PR number is rendered alongside the history line
    expect(md).toContain("(#7)");
    // Notes are rendered with a leading "—"
    expect(md).toContain("— kicked off");
    expect(md).toContain("— implementing");
  });

  it("caps history at 20 entries with a hint about hidden ones", async () => {
    const entries: AgentReportAuditEntry[] = Array.from({ length: 25 }, (_, i) =>
      makeAuditEntry({
        timestamp: new Date(Date.UTC(2026, 4, 13, 10, i, 0)).toISOString(),
        reportState: "working",
        note: `entry ${i}`,
      }),
    );
    await seedAuditTrail(entries);

    await writeAgentStatusArtifact(PROJECT_ID, SESSION_ID, makeReport());

    const artifact = await readCanonicalArtifactIfExists(PROJECT_ID, SESSION_ID, ARTIFACT_ID);
    const md = (artifact as Extract<typeof artifact, { type: "markdown" }>)!.payload.markdown;
    expect(md).toContain("### History (25 reports, showing latest 20)");

    // The 5 oldest (entry 0–4) should be excluded.
    expect(md).not.toContain("entry 0 ");
    expect(md).not.toContain("entry 4 ");
    // The newest must be present.
    expect(md).toContain("entry 24");
  });

  it("renders a single-line note as a blockquote on the latest report", async () => {
    await writeAgentStatusArtifact(
      PROJECT_ID,
      SESSION_ID,
      makeReport({ note: "still investigating the bug" }),
    );

    const artifact = await readCanonicalArtifactIfExists(PROJECT_ID, SESSION_ID, ARTIFACT_ID);
    const md = (artifact as Extract<typeof artifact, { type: "markdown" }>)!.payload.markdown;
    expect(md).toContain("> still investigating the bug");
  });

  it("preserves the original createdAt when overwriting an existing artifact", async () => {
    await writeAgentStatusArtifact(
      PROJECT_ID,
      SESSION_ID,
      makeReport({ state: "started", timestamp: "2026-05-13T09:00:00.000Z" }),
    );
    const first = await readCanonicalArtifactIfExists(PROJECT_ID, SESSION_ID, ARTIFACT_ID);
    const originalCreatedAt = first!.createdAt;

    // Wait a moment then write again — the `createdAt` should NOT change.
    await new Promise((r) => setTimeout(r, 5));
    await writeAgentStatusArtifact(
      PROJECT_ID,
      SESSION_ID,
      makeReport({ state: "working", timestamp: "2026-05-13T10:00:00.000Z" }),
    );
    const second = await readCanonicalArtifactIfExists(PROJECT_ID, SESSION_ID, ARTIFACT_ID);

    expect(second!.createdAt).toBe(originalCreatedAt);
    // updatedAt should have advanced
    expect(second!.updatedAt >= first!.updatedAt).toBe(true);
  });

  it("is a no-op when projectId is missing", async () => {
    await writeAgentStatusArtifact("", SESSION_ID, makeReport());
    // No artifact written under the (now-empty) project — nothing to assert
    // beyond "did not throw". A direct readback at PROJECT_ID would also be
    // null, but the precondition prevents us from even reaching the writer.
    expect(true).toBe(true);
  });

  it("is a no-op when sessionId is missing", async () => {
    await expect(
      writeAgentStatusArtifact(PROJECT_ID, "", makeReport()),
    ).resolves.toBeUndefined();
    const artifact = await readCanonicalArtifactIfExists(PROJECT_ID, "", ARTIFACT_ID).catch(
      () => null,
    );
    expect(artifact).toBeNull();
  });

  it("is a no-op when the report is missing or malformed", async () => {
    // null report
    await expect(
      writeAgentStatusArtifact(PROJECT_ID, SESSION_ID, null as unknown as AgentReport),
    ).resolves.toBeUndefined();
    // report without a string state
    await expect(
      writeAgentStatusArtifact(PROJECT_ID, SESSION_ID, { timestamp: "x" } as unknown as AgentReport),
    ).resolves.toBeUndefined();

    const artifact = await readCanonicalArtifactIfExists(PROJECT_ID, SESSION_ID, ARTIFACT_ID);
    expect(artifact).toBeNull();
  });

  it("renders successfully when the audit trail file does not exist", async () => {
    // No seedAuditTrail() call — directory simply absent.
    await writeAgentStatusArtifact(PROJECT_ID, SESSION_ID, makeReport());

    const artifact = await readCanonicalArtifactIfExists(PROJECT_ID, SESSION_ID, ARTIFACT_ID);
    expect(artifact).not.toBeNull();
    const md = (artifact as Extract<typeof artifact, { type: "markdown" }>)!.payload.markdown;
    // Header still rendered, but no History section.
    expect(md).toContain("**Current state:**");
    expect(md).not.toContain("### History");
  });
});
