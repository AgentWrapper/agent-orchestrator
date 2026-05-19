/**
 * Regression tests for plugin-internal activity events (issue #1659).
 *
 * Covers tracker.dep_missing (MUST emit, deduped once-per-process).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { recordActivityEventMock, requestMock } = vi.hoisted(() => ({
  recordActivityEventMock: vi.fn(),
  requestMock: vi.fn(),
}));

vi.mock("node:https", () => ({
  request: requestMock,
}));

vi.mock("@aoagents/ao-core", async () => {
  const actual = (await vi.importActual("@aoagents/ao-core")) as Record<string, unknown>;
  return {
    ...actual,
    recordActivityEvent: recordActivityEventMock,
  };
});

// @composio/core is intentionally not installed — the real dynamic import
// will fail with ERR_MODULE_NOT_FOUND, which is exactly the dep_missing
// shape we want to exercise.

import { create, _resetDepMissingEmittedForTesting } from "./index.js";
import type { ProjectConfig } from "@aoagents/ao-core";

beforeEach(() => {
  vi.clearAllMocks();
  recordActivityEventMock.mockReset();
  requestMock.mockReset();
  _resetDepMissingEmittedForTesting();
  process.env.COMPOSIO_API_KEY = "test-key";
  process.env.COMPOSIO_ENTITY_ID = "test-entity";
  delete process.env.LINEAR_API_KEY;
});

afterEach(() => {
  delete process.env.COMPOSIO_API_KEY;
  delete process.env.COMPOSIO_ENTITY_ID;
  delete process.env.LINEAR_API_KEY;
  vi.useRealTimers();
});

function makeProject(): ProjectConfig {
  return {
    name: "test-project",
    repo: "test/repo",
    path: "/repo/path",
    defaultBranch: "main",
    sessionPrefix: "test",
    tracker: { teamId: "TEAM-1" },
  };
}

describe("tracker.dep_missing (MUST emit)", () => {
  it("emits when Composio SDK is not installed", async () => {
    const tracker = create();

    // Any tracker call routes through the composio transport, which will
    // fail to load the missing SDK on first use.
    await expect(tracker.getIssue("TEST-1", makeProject())).rejects.toThrow(
      /Composio SDK.*not installed/,
    );

    expect(recordActivityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "tracker",
        kind: "tracker.dep_missing",
        level: "error",
        data: expect.objectContaining({
          plugin: "tracker-linear",
          package: "@composio/core",
        }),
      }),
    );
  });

  it("emits exactly once across multiple calls (deduped per-process)", async () => {
    const tracker = create();

    await expect(tracker.getIssue("TEST-1", makeProject())).rejects.toThrow();
    await expect(tracker.getIssue("TEST-2", makeProject())).rejects.toThrow();
    await expect(tracker.getIssue("TEST-3", makeProject())).rejects.toThrow();

    const depMissingCalls = recordActivityEventMock.mock.calls.filter(
      ([event]) => event.kind === "tracker.dep_missing",
    );
    expect(depMissingCalls).toHaveLength(1);
  });
});

describe("tracker.api_timeout", () => {
  it("rejects direct transport timeouts even when activity logging throws", async () => {
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_ENTITY_ID;
    process.env.LINEAR_API_KEY = "linear-key";
    vi.useFakeTimers();

    const req = {
      setTimeout: vi.fn(),
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    req.setTimeout.mockImplementation((_timeoutMs: number, cb: () => void) => {
      setTimeout(cb, 0);
      return req;
    });
    req.on.mockReturnValue(req);
    requestMock.mockReturnValue(req);
    recordActivityEventMock.mockImplementationOnce(() => {
      throw new Error("activity sink failed");
    });

    const tracker = create();
    const timeoutExpectation = expect(tracker.getIssue("TEST-1", makeProject())).rejects.toThrow(
      "Linear API request timed out after 30s",
    );

    await vi.runAllTimersAsync();
    await timeoutExpectation;
    expect(req.destroy).toHaveBeenCalled();
    expect(recordActivityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "tracker",
        kind: "tracker.api_timeout",
        level: "warn",
        data: expect.objectContaining({
          plugin: "tracker-linear",
          transport: "direct",
          timeoutMs: 30_000,
        }),
      }),
    );
  });
});
