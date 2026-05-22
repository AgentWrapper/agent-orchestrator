/**
 * Regression tests for Composio→direct transport fallback.
 *
 * When COMPOSIO_API_KEY is present but @composio/core cannot be loaded, the
 * tracker must fall back to the direct LINEAR_API_KEY transport instead of
 * hard-failing — provided a LINEAR_API_KEY is available. A bare COMPOSIO_API_KEY
 * (commonly exported globally for unrelated Composio work) must not break an
 * otherwise-valid Linear setup.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const { requestMock, recordActivityEventMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  recordActivityEventMock: vi.fn(),
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
// fails with ERR_MODULE_NOT_FOUND, exercising the fallback path.

import { create, _resetDepMissingEmittedForTesting } from "../src/index.js";
import type { ProjectConfig } from "@aoagents/ao-core";

const project: ProjectConfig = {
  name: "test",
  repo: "acme/integrator",
  path: "/tmp/repo",
  defaultBranch: "main",
  sessionPrefix: "test",
  tracker: { plugin: "linear", teamId: "team-uuid-1", workspaceSlug: "acme" },
};

const sampleIssueNode = {
  id: "uuid-123",
  identifier: "INT-123",
  title: "Fix login bug",
  description: "Users can't log in with SSO",
  url: "https://linear.app/acme/issue/INT-123",
  priority: 2,
  branchName: "feat/INT-123",
  state: { name: "In Progress", type: "started" },
  labels: { nodes: [{ name: "bug" }] },
  assignee: { name: "Alice Smith", displayName: "Alice" },
  team: { key: "INT" },
};

/** Queue a successful Linear API response for the direct transport. */
function mockLinearAPI(responseData: unknown, statusCode = 200) {
  const body = JSON.stringify({ data: responseData });
  requestMock.mockImplementationOnce(
    (
      _opts: Record<string, unknown>,
      callback: (res: EventEmitter & { statusCode: number }) => void,
    ) => {
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(() => {
          const res = Object.assign(new EventEmitter(), { statusCode });
          callback(res);
          process.nextTick(() => {
            res.emit("data", Buffer.from(body));
            res.emit("end");
          });
        }),
        destroy: vi.fn(),
        setTimeout: vi.fn(),
      });
      return req;
    },
  );
}

let savedComposioKey: string | undefined;
let savedComposioEntity: string | undefined;
let savedLinearKey: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  requestMock.mockReset();
  recordActivityEventMock.mockReset();
  _resetDepMissingEmittedForTesting();
  savedComposioKey = process.env["COMPOSIO_API_KEY"];
  savedComposioEntity = process.env["COMPOSIO_ENTITY_ID"];
  savedLinearKey = process.env["LINEAR_API_KEY"];
});

afterEach(() => {
  if (savedComposioKey === undefined) delete process.env["COMPOSIO_API_KEY"];
  else process.env["COMPOSIO_API_KEY"] = savedComposioKey;
  if (savedComposioEntity === undefined) delete process.env["COMPOSIO_ENTITY_ID"];
  else process.env["COMPOSIO_ENTITY_ID"] = savedComposioEntity;
  if (savedLinearKey === undefined) delete process.env["LINEAR_API_KEY"];
  else process.env["LINEAR_API_KEY"] = savedLinearKey;
});

describe("Composio→direct transport fallback", () => {
  it("falls back to the direct transport when @composio/core is missing but LINEAR_API_KEY is set", async () => {
    process.env["COMPOSIO_API_KEY"] = "composio-key";
    process.env["LINEAR_API_KEY"] = "lin_api_test_key";
    mockLinearAPI({ issue: sampleIssueNode });

    const tracker = create();
    const issue = await tracker.getIssue("INT-123", project);

    expect(issue.id).toBe("INT-123");
    expect(issue.title).toBe("Fix login bug");
    expect(requestMock).toHaveBeenCalled();
  });

  it("does not emit tracker.dep_missing when fallback succeeds", async () => {
    process.env["COMPOSIO_API_KEY"] = "composio-key";
    process.env["LINEAR_API_KEY"] = "lin_api_test_key";
    mockLinearAPI({ issue: sampleIssueNode });

    const tracker = create();
    await tracker.getIssue("INT-123", project);

    const depMissingCalls = recordActivityEventMock.mock.calls.filter(
      ([event]) => event?.kind === "tracker.dep_missing",
    );
    expect(depMissingCalls).toHaveLength(0);
  });

  it("still throws when @composio/core is missing and no LINEAR_API_KEY is available", async () => {
    process.env["COMPOSIO_API_KEY"] = "composio-key";
    delete process.env["LINEAR_API_KEY"];

    const tracker = create();
    await expect(tracker.getIssue("INT-123", project)).rejects.toThrow(
      /Composio SDK.*not installed/,
    );
  });
});
