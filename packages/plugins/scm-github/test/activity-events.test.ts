/**
 * Regression tests for plugin-internal activity events (issue #1659).
 *
 * Covers scm.gh_unavailable (MUST emit, deduped once-per-process).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { recordActivityEventMock } = vi.hoisted(() => ({
  recordActivityEventMock: vi.fn(),
}));

vi.mock("@aoagents/ao-core", async () => {
  const actual = (await vi.importActual("@aoagents/ao-core")) as Record<string, unknown>;
  return {
    ...actual,
    recordActivityEvent: recordActivityEventMock,
  };
});

import {
  enrichSessionsPRBatch,
  setExecFileAsync,
  setExecGhAsync,
  clearETagCache,
  clearPRMetadataCache,
  _resetGhUnavailableEmittedForTesting,
  _resetBatchEnrichPRFailedEmittedForTesting,
} from "../src/graphql-batch.js";
import type { PRInfo } from "@aoagents/ao-core";

const samplePRs: PRInfo[] = [
  {
    owner: "octocat",
    repo: "hello-world",
    number: 42,
    url: "https://github.com/octocat/hello-world/pull/42",
    title: "Add new feature",
    branch: "feature/new",
    baseBranch: "main",
    isDraft: false,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  clearETagCache();
  clearPRMetadataCache();
  _resetGhUnavailableEmittedForTesting();
  _resetBatchEnrichPRFailedEmittedForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scm.gh_unavailable (MUST emit)", () => {
  it("emits when verifyGhCLI fails because gh is missing/unauthenticated", async () => {
    const execFileMock = vi.fn().mockImplementation((file: string) => {
      if (file === "gh") {
        const err = new Error("spawn gh ENOENT") as Error & { code?: string };
        err.code = "ENOENT";
        return Promise.reject(err);
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });
    setExecFileAsync(execFileMock as unknown as Parameters<typeof setExecFileAsync>[0]);

    // The batch-level try/catch swallows verifyGhCLI's throw — but the event
    // fires before the throw, which is what we care about for RCA.
    const result = await enrichSessionsPRBatch(samplePRs);
    expect(result.enrichment.size).toBe(0);

    expect(recordActivityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "scm",
        kind: "scm.gh_unavailable",
        level: "error",
        data: expect.objectContaining({
          plugin: "scm-github",
          errorMessage: expect.any(String),
        }),
      }),
    );
  });

  it("emits exactly once across multiple gh-missing failures (deduped per-process)", async () => {
    const execFileMock = vi.fn().mockImplementation((file: string) => {
      if (file === "gh") {
        return Promise.reject(new Error("gh ENOENT"));
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });
    setExecFileAsync(execFileMock as unknown as Parameters<typeof setExecFileAsync>[0]);

    await enrichSessionsPRBatch(samplePRs);
    await enrichSessionsPRBatch(samplePRs);
    await enrichSessionsPRBatch(samplePRs);

    const ghUnavailableCalls = recordActivityEventMock.mock.calls.filter(
      ([event]) => event.kind === "scm.gh_unavailable",
    );
    expect(ghUnavailableCalls).toHaveLength(1);
  });
});

describe("scm.batch_enrich_pr_failed (poll-path emit)", () => {
  it("emits exactly once per PR across repeated extraction failures", async () => {
    const execFileMock = vi.fn().mockResolvedValue({ stdout: "gh version", stderr: "" });
    setExecFileAsync(execFileMock as unknown as Parameters<typeof setExecFileAsync>[0]);

    const execGhMock = vi.fn(
      async (_args: string[], _timeout: number, operation: string): Promise<string> => {
        if (operation === "gh.api.guard-pr-list") {
          return 'HTTP/2 200 OK\netag: W/"pr-list"\n\n[]';
        }
        if (operation === "gh.api.graphql-batch") {
          return `HTTP/2 200 OK\n\n${JSON.stringify({
            data: {
              pr0: {
                pullRequest: { unexpectedShape: true },
              },
            },
          })}`;
        }
        throw new Error(`Unexpected gh operation: ${operation}`);
      },
    );
    setExecGhAsync(execGhMock);

    await enrichSessionsPRBatch(samplePRs);
    await enrichSessionsPRBatch(samplePRs);

    const extractionFailureCalls = recordActivityEventMock.mock.calls.filter(
      ([event]) => event.kind === "scm.batch_enrich_pr_failed",
    );
    expect(extractionFailureCalls).toHaveLength(1);
    expect(extractionFailureCalls[0]?.[0]).toEqual(
      expect.objectContaining({
        source: "scm",
        kind: "scm.batch_enrich_pr_failed",
        level: "warn",
        data: expect.objectContaining({
          plugin: "scm-github",
          prNumber: 42,
          prOwner: "octocat",
          prRepo: "hello-world",
        }),
      }),
    );
  });
});
