import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  AGENT_REPORT_CLOCK_SKEW_TOLERANCE_MS,
  AGENT_REPORTED_STATES,
  AGENT_REPORT_FRESHNESS_MS,
  AGENT_REPORT_METADATA_KEYS,
  applyAgentReport,
  isAgentReportFresh,
  mapAgentReportToLifecycle,
  normalizeAgentReportedState,
  readAgentReport,
  readAgentReportAuditTrail,
  validateAgentReportTransition,
} from "../agent-report.js";
import { writeMetadata, writeCanonicalLifecycle, readMetadataRaw } from "../metadata.js";
import { createInitialCanonicalLifecycle } from "../lifecycle-state.js";
import type { CanonicalSessionLifecycle } from "../types.js";

let dataDir: string;

beforeEach(() => {
  dataDir = join(tmpdir(), `ao-test-agent-report-${randomUUID()}`);
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function seedWorkerSession(
  sessionId: string,
  init?: Partial<CanonicalSessionLifecycle["session"]>,
): CanonicalSessionLifecycle {
  const lifecycle = createInitialCanonicalLifecycle("worker");
  // Default the seeded lifecycle to "working" with an existing startedAt so
  // tests exercise the transition-applied path (not the first-start path).
  lifecycle.session.state = "working";
  lifecycle.session.reason = "task_in_progress";
  lifecycle.session.startedAt = "2024-12-01T00:00:00.000Z";
  if (init) {
    Object.assign(lifecycle.session, init);
  }
  lifecycle.runtime.state = "alive";
  lifecycle.runtime.reason = "process_running";
  writeMetadata(dataDir, sessionId, {
    worktree: "/tmp/worktree",
    branch: "feat/x",
    status: "working",
    project: "demo",
  });
  writeCanonicalLifecycle(dataDir, sessionId, lifecycle);
  return lifecycle;
}

describe("normalizeAgentReportedState", () => {
  it("accepts canonical values", () => {
    for (const state of AGENT_REPORTED_STATES) {
      expect(normalizeAgentReportedState(state)).toBe(state);
    }
  });

  it("accepts hyphen and short aliases", () => {
    expect(normalizeAgentReportedState("needs-input")).toBe("needs_input");
    expect(normalizeAgentReportedState("fixing-ci")).toBe("fixing_ci");
    expect(normalizeAgentReportedState("addressing-reviews")).toBe("addressing_reviews");
    expect(normalizeAgentReportedState("pr-created")).toBe("pr_created");
    expect(normalizeAgentReportedState("draft-pr-created")).toBe("draft_pr_created");
    expect(normalizeAgentReportedState("ready-for-review")).toBe("ready_for_review");
    expect(normalizeAgentReportedState("ci")).toBe("fixing_ci");
    expect(normalizeAgentReportedState("reviews")).toBe("addressing_reviews");
    expect(normalizeAgentReportedState("complete")).toBe("completed");
    expect(normalizeAgentReportedState("input")).toBe("needs_input");
    expect(normalizeAgentReportedState("start")).toBe("started");
    expect(normalizeAgentReportedState("work")).toBe("working");
    expect(normalizeAgentReportedState("wait")).toBe("waiting");
  });

  it("does not alias `done` (agents cannot self-report terminal done)", () => {
    expect(normalizeAgentReportedState("done")).toBeNull();
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(normalizeAgentReportedState(" WAITING ")).toBe("waiting");
    expect(normalizeAgentReportedState("Needs-Input")).toBe("needs_input");
  });

  it("returns null for unknown values", () => {
    expect(normalizeAgentReportedState("foo")).toBeNull();
    expect(normalizeAgentReportedState("")).toBeNull();
  });
});

describe("mapAgentReportToLifecycle", () => {
  it("maps every reportable state to a canonical pair", () => {
    for (const state of AGENT_REPORTED_STATES) {
      const mapped = mapAgentReportToLifecycle(state);
      expect(mapped.sessionState).toBeTypeOf("string");
      expect(mapped.sessionReason).toBeTypeOf("string");
    }
  });

  it("maps needs_input to the canonical needs_input state", () => {
    expect(mapAgentReportToLifecycle("needs_input")).toEqual({
      sessionState: "needs_input",
      sessionReason: "awaiting_user_input",
    });
  });

  it("maps waiting and completed to idle (non-terminal)", () => {
    expect(mapAgentReportToLifecycle("waiting").sessionState).toBe("idle");
    expect(mapAgentReportToLifecycle("completed").sessionState).toBe("idle");
  });

  it("maps fixing_ci and addressing_reviews to working with the right reason", () => {
    expect(mapAgentReportToLifecycle("fixing_ci")).toEqual({
      sessionState: "working",
      sessionReason: "fixing_ci",
    });
    expect(mapAgentReportToLifecycle("addressing_reviews")).toEqual({
      sessionState: "working",
      sessionReason: "resolving_review_comments",
    });
  });

  it("maps PR workflow reports to the expected session phase", () => {
    expect(mapAgentReportToLifecycle("pr_created")).toEqual({
      sessionState: "idle",
      sessionReason: "pr_created",
    });
    expect(mapAgentReportToLifecycle("draft_pr_created")).toEqual({
      sessionState: "working",
      sessionReason: "task_in_progress",
    });
    expect(mapAgentReportToLifecycle("ready_for_review")).toEqual({
      sessionState: "idle",
      sessionReason: "awaiting_external_review",
    });
  });
});

describe("validateAgentReportTransition", () => {
  it("rejects orchestrator sessions", () => {
    const lifecycle = createInitialCanonicalLifecycle("orchestrator");
    const result = validateAgentReportTransition(lifecycle, "working");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/orchestrator/);
  });

  it("rejects terminated sessions", () => {
    const lifecycle = createInitialCanonicalLifecycle("worker");
    lifecycle.session.state = "terminated";
    const result = validateAgentReportTransition(lifecycle, "working");
    expect(result.ok).toBe(false);
  });

  it("rejects all reports when session is done (terminal state cannot reopen)", () => {
    const lifecycle = createInitialCanonicalLifecycle("worker");
    lifecycle.session.state = "done";
    // `completed` maps back to `idle` and would reanimate a `done` session, so
    // it must also be rejected — not just the obvious working/needs_input ones.
    expect(validateAgentReportTransition(lifecycle, "working").ok).toBe(false);
    expect(validateAgentReportTransition(lifecycle, "completed").ok).toBe(false);
    expect(validateAgentReportTransition(lifecycle, "needs_input").ok).toBe(false);
  });

  it("rejects reports on merged or closed PRs", () => {
    const lifecycle = createInitialCanonicalLifecycle("worker");
    lifecycle.pr.state = "merged";
    expect(validateAgentReportTransition(lifecycle, "working").ok).toBe(false);

    lifecycle.pr.state = "closed";
    expect(validateAgentReportTransition(lifecycle, "working").ok).toBe(false);
  });

  it("rejects reports when runtime is missing or exited", () => {
    const missing = createInitialCanonicalLifecycle("worker");
    missing.runtime.state = "missing";
    expect(validateAgentReportTransition(missing, "working").ok).toBe(false);

    const exited = createInitialCanonicalLifecycle("worker");
    exited.runtime.state = "exited";
    expect(validateAgentReportTransition(exited, "working").ok).toBe(false);
  });

  it("accepts valid worker transitions", () => {
    const lifecycle = createInitialCanonicalLifecycle("worker");
    lifecycle.session.state = "working";
    lifecycle.runtime.state = "alive";
    expect(validateAgentReportTransition(lifecycle, "fixing_ci").ok).toBe(true);
    expect(validateAgentReportTransition(lifecycle, "needs_input").ok).toBe(true);
  });
});

describe("applyAgentReport", () => {
  const sessionId = "demo-1";

  beforeEach(() => {
    seedWorkerSession(sessionId);
  });

  it("writes canonical lifecycle and metadata keys", () => {
    const now = new Date("2025-01-01T12:00:00.000Z");
    const result = applyAgentReport(dataDir, sessionId, {
      state: "needs_input",
      note: " please clarify the spec ",
      now,
    });

    expect(result.report.state).toBe("needs_input");
    expect(result.report.timestamp).toBe(now.toISOString());
    expect(result.report.note).toBe("please clarify the spec");
    expect(result.nextState).toBe("needs_input");

    const meta = readMetadataRaw(dataDir, sessionId);
    expect(meta).not.toBeNull();
    expect(meta![AGENT_REPORT_METADATA_KEYS.STATE]).toBe("needs_input");
    expect(meta![AGENT_REPORT_METADATA_KEYS.AT]).toBe(now.toISOString());
    expect(meta![AGENT_REPORT_METADATA_KEYS.NOTE]).toBe("please clarify the spec");
    const audit = readAgentReportAuditTrail(dataDir, sessionId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      accepted: true,
      source: "report",
      actor: "unknown",
      reportState: "needs_input",
      note: "please clarify the spec",
      before: {
        legacyStatus: "working",
        sessionState: "working",
      },
      after: {
        legacyStatus: "needs_input",
        sessionState: "needs_input",
      },
    });
  });

  it("records pr_created with PR metadata and pr_open lifecycle", () => {
    const now = new Date("2025-01-02T09:30:00.000Z");
    const result = applyAgentReport(dataDir, sessionId, {
      state: "pr_created",
      prUrl: "https://github.com/test/repo/pull/42",
      now,
    });

    expect(result.legacyStatus).toBe("pr_open");
    expect(result.report.prNumber).toBe(42);
    expect(result.report.prUrl).toBe("https://github.com/test/repo/pull/42");
    expect(result.report.prIsDraft).toBe(false);

    const meta = readMetadataRaw(dataDir, sessionId)!;
    expect(meta[AGENT_REPORT_METADATA_KEYS.PR_URL]).toBe("https://github.com/test/repo/pull/42");
    expect(meta[AGENT_REPORT_METADATA_KEYS.PR_NUMBER]).toBe("42");
    expect(meta[AGENT_REPORT_METADATA_KEYS.PR_IS_DRAFT]).toBe("false");

    const payload = JSON.parse(meta["lifecycle"]);
    expect(payload.session.state).toBe("idle");
    expect(payload.session.reason).toBe("pr_created");
    expect(payload.pr.state).toBe("open");
    expect(payload.pr.reason).toBe("in_progress");
    expect(payload.pr.number).toBe(42);
    expect(payload.pr.url).toBe("https://github.com/test/repo/pull/42");
  });

  it("does not invent an open PR without a URL or number", () => {
    const now = new Date("2025-01-02T09:35:00.000Z");

    const result = applyAgentReport(dataDir, sessionId, {
      state: "pr_created",
      now,
    });

    expect(result.legacyStatus).toBe("idle");

    const meta = readMetadataRaw(dataDir, sessionId)!;
    const payload = JSON.parse(meta["lifecycle"]);
    expect(payload.pr.state).toBe("none");
    expect(payload.pr.reason).toBe("not_created");
    expect(meta[AGENT_REPORT_METADATA_KEYS.PR_URL]).toBeUndefined();
    expect(meta[AGENT_REPORT_METADATA_KEYS.PR_NUMBER]).toBeUndefined();
  });

  it("keeps draft PR creation in working and marks the report as draft", () => {
    const now = new Date("2025-01-02T10:00:00.000Z");
    const result = applyAgentReport(dataDir, sessionId, {
      state: "draft_pr_created",
      prUrl: "https://github.com/test/repo/pull/43",
      now,
    });

    expect(result.legacyStatus).toBe("pr_open");
    expect(result.nextState).toBe("working");
    expect(result.report.prIsDraft).toBe(true);

    const meta = readMetadataRaw(dataDir, sessionId)!;
    expect(meta[AGENT_REPORT_METADATA_KEYS.PR_IS_DRAFT]).toBe("true");
    const payload = JSON.parse(meta["lifecycle"]);
    expect(payload.session.state).toBe("working");
    expect(payload.pr.state).toBe("open");
    expect(payload.pr.reason).toBe("in_progress");
  });

  it("promotes ready_for_review to review_pending and clears draft metadata", () => {
    applyAgentReport(dataDir, sessionId, {
      state: "draft_pr_created",
      prUrl: "https://github.com/test/repo/pull/44",
      now: new Date("2025-01-02T10:00:00.000Z"),
    });

    const result = applyAgentReport(dataDir, sessionId, {
      state: "ready_for_review",
      prNumber: 44,
      now: new Date("2025-01-02T10:05:00.000Z"),
    });

    expect(result.legacyStatus).toBe("review_pending");
    expect(result.report.prIsDraft).toBe(false);

    const meta = readMetadataRaw(dataDir, sessionId)!;
    expect(meta[AGENT_REPORT_METADATA_KEYS.PR_IS_DRAFT]).toBe("false");
    const payload = JSON.parse(meta["lifecycle"]);
    expect(payload.session.state).toBe("idle");
    expect(payload.pr.state).toBe("open");
    expect(payload.pr.reason).toBe("review_pending");
    expect(payload.pr.number).toBe(44);
  });

  it("preserves prior PR URL when ready_for_review only supplies a PR number", () => {
    applyAgentReport(dataDir, sessionId, {
      state: "draft_pr_created",
      prUrl: "https://github.com/test/repo/pull/45",
      now: new Date("2025-01-02T10:00:00.000Z"),
    });

    applyAgentReport(dataDir, sessionId, {
      state: "ready_for_review",
      prNumber: 45,
      now: new Date("2025-01-02T10:05:00.000Z"),
    });

    const meta = readMetadataRaw(dataDir, sessionId)!;
    expect(meta[AGENT_REPORT_METADATA_KEYS.PR_URL]).toBe("https://github.com/test/repo/pull/45");
    expect(meta[AGENT_REPORT_METADATA_KEYS.PR_NUMBER]).toBe("45");
  });

  it("does not clear PR metadata on later non-PR workflow reports", () => {
    applyAgentReport(dataDir, sessionId, {
      state: "pr_created",
      prUrl: "https://github.com/test/repo/pull/46",
      now: new Date("2025-01-02T10:00:00.000Z"),
    });

    applyAgentReport(dataDir, sessionId, {
      state: "working",
      now: new Date("2025-01-02T10:05:00.000Z"),
    });

    const meta = readMetadataRaw(dataDir, sessionId)!;
    expect(meta[AGENT_REPORT_METADATA_KEYS.PR_URL]).toBe("https://github.com/test/repo/pull/46");
    expect(meta[AGENT_REPORT_METADATA_KEYS.PR_NUMBER]).toBe("46");
    expect(meta[AGENT_REPORT_METADATA_KEYS.PR_IS_DRAFT]).toBe("false");
  });

  it("rejects conflicting PR URL and PR number inputs", () => {
    expect(() =>
      applyAgentReport(dataDir, sessionId, {
        state: "pr_created",
        prUrl: "https://github.com/test/repo/pull/47",
        prNumber: 99,
        now: new Date("2025-01-02T10:00:00.000Z"),
      }),
    ).toThrow(/does not match PR URL/);
  });

  it("sets startedAt on the first working transition", () => {
    const now = new Date("2025-01-01T12:00:00.000Z");
    // Re-seed with startedAt explicitly null so we exercise the first-start
    // branch of applyAgentReport.
    seedWorkerSession(sessionId, {
      state: "not_started",
      reason: "spawn_requested",
      startedAt: null,
    });
    applyAgentReport(dataDir, sessionId, { state: "started", now });
    const meta = readMetadataRaw(dataDir, sessionId);
    expect(meta).not.toBeNull();
    // The canonical payload is stored in lifecycle as JSON.
    const payload = JSON.parse(meta!["lifecycle"]);
    expect(payload.session.state).toBe("working");
    expect(payload.session.reason).toBe("agent_acknowledged");
    expect(payload.session.startedAt).toBe(now.toISOString());
  });

  it("clears a previous note when none is supplied", () => {
    applyAgentReport(dataDir, sessionId, {
      state: "working",
      note: "first note",
      now: new Date("2025-01-01T11:00:00.000Z"),
    });
    applyAgentReport(dataDir, sessionId, {
      state: "working",
      now: new Date("2025-01-01T12:00:00.000Z"),
    });
    const meta = readMetadataRaw(dataDir, sessionId);
    expect(meta).not.toBeNull();
    expect(meta![AGENT_REPORT_METADATA_KEYS.NOTE] ?? "").toBe("");
  });

  it("throws when the transition is rejected", () => {
    // Force lifecycle into a terminated state and try to re-report.
    const lifecycle = createInitialCanonicalLifecycle("worker");
    lifecycle.session.state = "terminated";
    writeCanonicalLifecycle(dataDir, sessionId, lifecycle);
    expect(() =>
      applyAgentReport(dataDir, sessionId, {
        state: "working",
        now: new Date(),
      }),
    ).toThrow(/terminated/);
    const audit = readAgentReportAuditTrail(dataDir, sessionId);
    expect(audit[0]).toMatchObject({
      accepted: false,
      reportState: "working",
      rejectionReason: "session is terminated",
      before: {
        sessionState: "terminated",
      },
      after: {
        sessionState: "terminated",
      },
    });
  });

  it("throws when the session does not exist", () => {
    expect(() =>
      applyAgentReport(dataDir, "missing-session", {
        state: "working",
        now: new Date(),
      }),
    ).toThrow(/not found/);
  });

  it("bounds the on-disk audit trail to recent entries", { timeout: 15000 }, () => {
    for (let index = 0; index < 260; index += 1) {
      applyAgentReport(dataDir, sessionId, {
        state: "working",
        note: `entry-${index}-${"x".repeat(1200)}`,
        now: new Date(`2025-01-01T12:${String(index % 60).padStart(2, "0")}:00.000Z`),
      });
    }

    const audit = readAgentReportAuditTrail(dataDir, sessionId);
    expect(audit.length).toBeLessThanOrEqual(200);

    const auditFilePath = join(dataDir, ".agent-report-audit", `${sessionId}.ndjson`);
    const rawAudit = readFileSync(auditFilePath, "utf8");
    expect(Buffer.byteLength(rawAudit, "utf8")).toBeLessThan(300_000);
  });
});

describe("readAgentReport + isAgentReportFresh", () => {
  it("returns null when metadata lacks report keys", () => {
    expect(readAgentReport({})).toBeNull();
    expect(readAgentReport(null)).toBeNull();
    expect(readAgentReport(undefined)).toBeNull();
  });

  it("returns null for unknown states or bad timestamps", () => {
    expect(
      readAgentReport({
        [AGENT_REPORT_METADATA_KEYS.STATE]: "not-a-state",
        [AGENT_REPORT_METADATA_KEYS.AT]: new Date().toISOString(),
      }),
    ).toBeNull();
    expect(
      readAgentReport({
        [AGENT_REPORT_METADATA_KEYS.STATE]: "working",
        [AGENT_REPORT_METADATA_KEYS.AT]: "not-a-timestamp",
      }),
    ).toBeNull();
  });

  it("parses a valid report with note", () => {
    const at = "2025-01-01T00:00:00.000Z";
    const report = readAgentReport({
      [AGENT_REPORT_METADATA_KEYS.STATE]: "fixing_ci",
      [AGENT_REPORT_METADATA_KEYS.AT]: at,
      [AGENT_REPORT_METADATA_KEYS.NOTE]: "still debugging",
    });
    expect(report).toEqual({ state: "fixing_ci", timestamp: at, note: "still debugging" });
  });

  it("treats an empty note as absent", () => {
    const at = "2025-01-01T00:00:00.000Z";
    const report = readAgentReport({
      [AGENT_REPORT_METADATA_KEYS.STATE]: "working",
      [AGENT_REPORT_METADATA_KEYS.AT]: at,
      [AGENT_REPORT_METADATA_KEYS.NOTE]: "",
    });
    expect(report?.note).toBeUndefined();
  });

  it("parses PR workflow payload fields when present", () => {
    const at = "2025-01-01T00:00:00.000Z";
    const report = readAgentReport({
      [AGENT_REPORT_METADATA_KEYS.STATE]: "pr_created",
      [AGENT_REPORT_METADATA_KEYS.AT]: at,
      [AGENT_REPORT_METADATA_KEYS.PR_NUMBER]: "55",
      [AGENT_REPORT_METADATA_KEYS.PR_URL]: "https://github.com/test/repo/pull/55",
      [AGENT_REPORT_METADATA_KEYS.PR_IS_DRAFT]: "false",
    });
    expect(report).toEqual({
      state: "pr_created",
      timestamp: at,
      prNumber: 55,
      prUrl: "https://github.com/test/repo/pull/55",
      prIsDraft: false,
    });
  });

  it("reports freshness against the default window", () => {
    const now = new Date("2025-01-01T12:05:00.000Z");
    const freshAt = "2025-01-01T12:04:00.000Z"; // 1m old
    const staleAt = "2025-01-01T11:55:00.000Z"; // 10m old
    const fresh = readAgentReport({
      [AGENT_REPORT_METADATA_KEYS.STATE]: "working",
      [AGENT_REPORT_METADATA_KEYS.AT]: freshAt,
    })!;
    const stale = readAgentReport({
      [AGENT_REPORT_METADATA_KEYS.STATE]: "working",
      [AGENT_REPORT_METADATA_KEYS.AT]: staleAt,
    })!;
    expect(isAgentReportFresh(fresh, now)).toBe(true);
    expect(isAgentReportFresh(stale, now)).toBe(false);
  });

  it("accepts small future skew inside the tolerance window", () => {
    const now = new Date("2025-01-01T12:00:00.000Z");
    const slightlyFuture = readAgentReport({
      [AGENT_REPORT_METADATA_KEYS.STATE]: "working",
      [AGENT_REPORT_METADATA_KEYS.AT]: new Date(
        now.getTime() + AGENT_REPORT_CLOCK_SKEW_TOLERANCE_MS - 1,
      ).toISOString(),
    })!;
    expect(isAgentReportFresh(slightlyFuture, now)).toBe(true);
  });

  it("rejects future timestamps outside the skew tolerance", () => {
    const now = new Date("2025-01-01T12:00:00.000Z");
    const future = readAgentReport({
      [AGENT_REPORT_METADATA_KEYS.STATE]: "working",
      [AGENT_REPORT_METADATA_KEYS.AT]: new Date(
        now.getTime() + AGENT_REPORT_CLOCK_SKEW_TOLERANCE_MS + 1,
      ).toISOString(),
    })!;
    expect(isAgentReportFresh(future, now)).toBe(false);
  });

  it("exposes the default freshness window (5 minutes)", () => {
    expect(AGENT_REPORT_FRESHNESS_MS).toBe(5 * 60 * 1000);
  });
});
