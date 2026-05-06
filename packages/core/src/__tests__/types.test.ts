import { describe, expect, it } from "vitest";
import { isOrchestratorSession, isIssueNotFoundError } from "../types.js";

describe("isOrchestratorSession", () => {
  it("detects orchestrators by explicit role metadata", () => {
    expect(
      isOrchestratorSession({ id: "app-control", metadata: { role: "orchestrator" } }, "app"),
    ).toBe(true);
  });

  it("detects numbered worktree orchestrators by prefix pattern", () => {
    expect(isOrchestratorSession({ id: "app-orchestrator-1", metadata: {} }, "app")).toBe(true);
    expect(isOrchestratorSession({ id: "app-orchestrator-42", metadata: {} }, "app")).toBe(true);
  });

  it("does not false-positive on worker sessions", () => {
    expect(isOrchestratorSession({ id: "app-7", metadata: { role: "worker" } }, "app")).toBe(false);
  });

  it("does not false-positive when prefix ends with -orchestrator", () => {
    // my-orchestrator-1 is a worker when prefix is "my-orchestrator"
    expect(
      isOrchestratorSession({ id: "my-orchestrator-1", metadata: {} }, "my-orchestrator"),
    ).toBe(false);
    // my-orchestrator-orchestrator-1 is the real worktree orchestrator
    expect(
      isOrchestratorSession(
        { id: "my-orchestrator-orchestrator-1", metadata: {} },
        "my-orchestrator",
      ),
    ).toBe(true);
  });

  // Regression coverage for issue #1048: stale legacy `{projectId}-orchestrator`
  // records (foreign prefix — the projectId is "integrator" but the sessionPrefix
  // is "int") must NOT be treated as orchestrators. The session-manager's
  // repair-on-read path (`isRepairableOrchestratorRecord`) intentionally does
  // NOT backfill `role` onto foreign-prefix bare records, so they stay role-less
  // and fail the public predicate — which is exactly what prevents them from
  // leaking into the dashboard/CLI and causing the id divergence in #1048.
  it("rejects bare {projectId}-orchestrator legacy ids without role metadata", () => {
    expect(
      isOrchestratorSession({ id: "integrator-orchestrator", metadata: {} }, "int"),
    ).toBe(false);
  });

  it("accepts bare legacy ids when role metadata is explicitly stamped", () => {
    expect(
      isOrchestratorSession(
        { id: "integrator-orchestrator", metadata: { role: "orchestrator" } },
        "int",
      ),
    ).toBe(true);
  });
});

describe("isIssueNotFoundError", () => {
  it("matches 'Issue X not found'", () => {
    expect(isIssueNotFoundError(new Error("Issue INT-9999 not found"))).toBe(true);
  });

  it("matches 'could not resolve to an Issue'", () => {
    expect(isIssueNotFoundError(new Error("Could not resolve to an Issue"))).toBe(true);
  });

  it("matches 'no issue with identifier'", () => {
    expect(isIssueNotFoundError(new Error("No issue with identifier ABC-123"))).toBe(true);
  });

  it("matches 'invalid issue format'", () => {
    expect(isIssueNotFoundError(new Error("Invalid issue format: fix login bug"))).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isIssueNotFoundError(new Error("Unauthorized"))).toBe(false);
    expect(isIssueNotFoundError(new Error("Network timeout"))).toBe(false);
    expect(isIssueNotFoundError(new Error("API key not found"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isIssueNotFoundError(null)).toBe(false);
    expect(isIssueNotFoundError(undefined)).toBe(false);
    expect(isIssueNotFoundError("string")).toBe(false);
  });
});
