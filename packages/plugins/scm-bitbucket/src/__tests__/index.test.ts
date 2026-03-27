import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { create, manifest } from "../index.js";

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------
const fetchMock = vi.fn() as Mock;
vi.stubGlobal("fetch", fetchMock);

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["content-type", "application/json"]]),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

// Provide env vars so the plugin creates a real client
// Uses BITBUCKET_API_TOKEN (preferred) with legacy BITBUCKET_APP_PASSWORD fallback
beforeEach(() => {
  vi.stubEnv("BITBUCKET_USERNAME", "testuser");
  vi.stubEnv("BITBUCKET_API_TOKEN", "testpass");
  fetchMock.mockReset();
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe("manifest", () => {
  it("has correct name and slot", () => {
    expect(manifest.name).toBe("bitbucket");
    expect(manifest.slot).toBe("scm");
  });
});

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

describe("create", () => {
  it("returns an SCM object with required methods", () => {
    const scm = create();
    expect(scm.name).toBe("bitbucket");
    expect(typeof scm.detectPR).toBe("function");
    expect(typeof scm.getPRState).toBe("function");
    expect(typeof scm.getCIChecks).toBe("function");
    expect(typeof scm.getCISummary).toBe("function");
    expect(typeof scm.getReviews).toBe("function");
    expect(typeof scm.getReviewDecision).toBe("function");
    expect(typeof scm.getPendingComments).toBe("function");
    expect(typeof scm.getReviewThreads).toBe("function");
    expect(typeof scm.getMergeability).toBe("function");
    expect(typeof scm.mergePR).toBe("function");
    expect(typeof scm.closePR).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const pr = {
  number: 42,
  url: "https://bitbucket.org/myws/myrepo/pull-requests/42",
  title: "feat: add thing",
  owner: "myws",
  repo: "myrepo",
  branch: "feat/thing",
  baseBranch: "main",
  isDraft: false,
};

const project = {
  repo: "myws/myrepo",
  path: "/tmp/myrepo",
  defaultBranch: "main",
} as never;

// ---------------------------------------------------------------------------
// getPRState
// ---------------------------------------------------------------------------

describe("getPRState", () => {
  it("maps OPEN to open", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ state: "OPEN" }));
    const scm = create();
    expect(await scm.getPRState(pr)).toBe("open");
  });

  it("maps MERGED to merged", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ state: "MERGED" }));
    const scm = create();
    expect(await scm.getPRState(pr)).toBe("merged");
  });

  it("maps DECLINED to closed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ state: "DECLINED" }));
    const scm = create();
    expect(await scm.getPRState(pr)).toBe("closed");
  });

  it("maps SUPERSEDED to closed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ state: "SUPERSEDED" }));
    const scm = create();
    expect(await scm.getPRState(pr)).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// getCIChecks
// ---------------------------------------------------------------------------

describe("getCIChecks", () => {
  it("maps Bitbucket commit statuses to CICheck", async () => {
    // First call: get PR to find HEAD sha
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ source: { commit: { hash: "abc123" } } }),
    );
    // Second call: get commit statuses
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        values: [
          {
            key: "build-1",
            name: "CI Build",
            state: "SUCCESSFUL",
            url: "https://ci.example.com/1",
            created_on: "2026-01-01T00:00:00Z",
            updated_on: "2026-01-01T00:01:00Z",
          },
          {
            key: "lint-1",
            name: "Lint",
            state: "FAILED",
            url: "https://ci.example.com/2",
            created_on: "2026-01-01T00:00:00Z",
            updated_on: "2026-01-01T00:01:00Z",
          },
          {
            key: "test-1",
            name: "Tests",
            state: "INPROGRESS",
            url: "https://ci.example.com/3",
            created_on: "2026-01-01T00:00:00Z",
            updated_on: null,
          },
        ],
      }),
    );

    const scm = create();
    const checks = await scm.getCIChecks(pr);

    expect(checks).toHaveLength(3);
    expect(checks[0].name).toBe("CI Build");
    expect(checks[0].status).toBe("passed");
    expect(checks[1].name).toBe("Lint");
    expect(checks[1].status).toBe("failed");
    expect(checks[2].name).toBe("Tests");
    expect(checks[2].status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// getCISummary
// ---------------------------------------------------------------------------

describe("getCISummary", () => {
  it("returns failing when any check fails", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ source: { commit: { hash: "abc" } } }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        values: [
          { key: "a", name: "A", state: "SUCCESSFUL", url: "", created_on: "", updated_on: "" },
          { key: "b", name: "B", state: "FAILED", url: "", created_on: "", updated_on: "" },
        ],
      }),
    );
    const scm = create();
    expect(await scm.getCISummary(pr)).toBe("failing");
  });

  it("returns none when no statuses", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ source: { commit: { hash: "abc" } } }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ values: [] }));
    const scm = create();
    expect(await scm.getCISummary(pr)).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// getReviews
// ---------------------------------------------------------------------------

describe("getReviews", () => {
  it("extracts reviews from participants with REVIEWER role", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        participants: [
          {
            user: { display_name: "Alice", uuid: "{a}", type: "user" },
            role: "REVIEWER",
            approved: true,
            state: "approved",
          },
          {
            user: { display_name: "Bob", uuid: "{b}", type: "user" },
            role: "REVIEWER",
            approved: false,
            state: "changes_requested",
          },
          {
            user: { display_name: "Author", uuid: "{c}", type: "user" },
            role: "AUTHOR",
            approved: false,
            state: null,
          },
        ],
        updated_on: "2026-01-01T00:00:00Z",
      }),
    );

    const scm = create();
    const reviews = await scm.getReviews(pr);

    expect(reviews).toHaveLength(2);
    expect(reviews[0].author).toBe("Alice");
    expect(reviews[0].state).toBe("approved");
    expect(reviews[1].author).toBe("Bob");
    expect(reviews[1].state).toBe("changes_requested");
  });
});

// ---------------------------------------------------------------------------
// getReviewDecision
// ---------------------------------------------------------------------------

describe("getReviewDecision", () => {
  it("returns changes_requested when any reviewer requests changes", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        participants: [
          { user: { display_name: "A", uuid: "{a}", type: "user" }, role: "REVIEWER", state: "approved" },
          { user: { display_name: "B", uuid: "{b}", type: "user" }, role: "REVIEWER", state: "changes_requested" },
        ],
        updated_on: "2026-01-01T00:00:00Z",
      }),
    );
    const scm = create();
    expect(await scm.getReviewDecision(pr)).toBe("changes_requested");
  });

  it("returns approved when all reviewers approve", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        participants: [
          { user: { display_name: "A", uuid: "{a}", type: "user" }, role: "REVIEWER", state: "approved" },
        ],
        updated_on: "2026-01-01T00:00:00Z",
      }),
    );
    const scm = create();
    expect(await scm.getReviewDecision(pr)).toBe("approved");
  });

  it("returns none when no reviewers", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        participants: [
          { user: { display_name: "Author", uuid: "{a}", type: "user" }, role: "AUTHOR", state: null },
        ],
        updated_on: "2026-01-01T00:00:00Z",
      }),
    );
    const scm = create();
    expect(await scm.getReviewDecision(pr)).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// mergePR
// ---------------------------------------------------------------------------

describe("mergePR", () => {
  it("calls merge endpoint with squash strategy by default", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const scm = create();
    await scm.mergePR(pr);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/pullrequests/42/merge");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.merge_strategy).toBe("squash");
    expect(body.close_source_branch).toBe(true);
  });

  it("maps rebase to fast_forward", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const scm = create();
    await scm.mergePR(pr, "rebase");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.merge_strategy).toBe("fast_forward");
  });
});

// ---------------------------------------------------------------------------
// closePR
// ---------------------------------------------------------------------------

describe("closePR", () => {
  it("calls decline endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const scm = create();
    await scm.closePR(pr);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/pullrequests/42/decline");
    expect(opts.method).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// verifyWebhook
// ---------------------------------------------------------------------------

describe("verifyWebhook", () => {
  it("verifies HMAC-SHA256 signature", async () => {
    const { createHmac } = await import("node:crypto");
    const secret = "test-secret";
    vi.stubEnv("BITBUCKET_WEBHOOK_SECRET", secret);

    const body = '{"test": true}';
    const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

    const scm = create();
    const result = await scm.verifyWebhook!(
      {
        method: "POST",
        headers: {
          "x-hub-signature": sig,
          "x-event-key": "pullrequest:created",
          "x-request-uuid": "delivery-123",
        },
        body,
      },
      Object.assign({}, project, { scm: { plugin: "bitbucket", webhook: { secretEnvVar: "BITBUCKET_WEBHOOK_SECRET" } } }) as never,
    );

    expect(result.ok).toBe(true);
    expect(result.eventType).toBe("pullrequest:created");
  });
});

// ---------------------------------------------------------------------------
// parseWebhook
// ---------------------------------------------------------------------------

describe("parseWebhook", () => {
  it("parses pullrequest:created event", async () => {
    const scm = create();
    const event = await scm.parseWebhook!(
      {
        method: "POST",
        headers: {
          "x-event-key": "pullrequest:created",
          "x-request-uuid": "del-1",
        },
        body: JSON.stringify({
          repository: { full_name: "myws/myrepo" },
          pullrequest: {
            id: 10,
            source: { branch: { name: "feat/x" }, commit: { hash: "aaa" } },
          },
        }),
      },
      project as never,
    );

    expect(event).not.toBeNull();
    expect(event!.kind).toBe("pull_request");
    expect(event!.action).toBe("opened");
    expect(event!.prNumber).toBe(10);
    expect(event!.provider).toBe("bitbucket");
  });

  it("parses repo:commit_status_updated as ci event", async () => {
    const scm = create();
    const event = await scm.parseWebhook!(
      {
        method: "POST",
        headers: { "x-event-key": "repo:commit_status_updated" },
        body: JSON.stringify({ repository: { full_name: "myws/myrepo" } }),
      },
      project as never,
    );

    expect(event).not.toBeNull();
    expect(event!.kind).toBe("ci");
  });
});
