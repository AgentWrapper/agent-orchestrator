import { describe, it, expect } from "vitest";
import { sessionFromMetadata } from "../utils/session-from-metadata.js";
import { AGENT_REPORT_METADATA_KEYS } from "../agent-report.js";

describe("sessionFromMetadata — multi-PR (issue #1821)", () => {
  const baseOptions = { projectId: "my-app" };

  it("1.1 — single PR backwards compat: only pr field in metadata", () => {
    const session = sessionFromMetadata(
      "app-1",
      { pr: "https://github.com/acme/main/pull/10", branch: "feat/pr-10" },
      baseOptions,
    );
    expect(session.pr).not.toBeNull();
    expect(session.pr?.number).toBe(10);
    expect(session.prs).toHaveLength(1);
    expect(session.prs[0]).toBe(session.pr);
  });

  it("1.2 — multiple PRs from prs field: primary is first", () => {
    const session = sessionFromMetadata(
      "app-1",
      {
        prs: "https://github.com/acme/main/pull/10,https://github.com/acme/sub/pull/5",
        branch: "feat/pr-10",
      },
      baseOptions,
    );
    expect(session.prs).toHaveLength(2);
    expect(session.prs[0].number).toBe(10);
    expect(session.prs[1].number).toBe(5);
    expect(session.pr).toBe(session.prs[0]);
  });

  it("1.3 — secondary PR gets its own number, not the primary's", () => {
    const session = sessionFromMetadata(
      "app-1",
      {
        prs: "https://github.com/acme/main/pull/10,https://github.com/acme/sub/pull/42",
        branch: "feat/pr-10",
      },
      baseOptions,
    );
    expect(session.prs[0].number).toBe(10);
    expect(session.prs[1].number).toBe(42);
  });

  it("1.4 — isDraft applies only to primary PR, secondary is always false", () => {
    const session = sessionFromMetadata(
      "app-1",
      {
        prs: "https://github.com/acme/main/pull/10,https://github.com/acme/sub/pull/11",
        branch: "feat/pr-10",
        [AGENT_REPORT_METADATA_KEYS.PR_IS_DRAFT]: "true",
      },
      baseOptions,
    );
    expect(session.prs[0].isDraft).toBe(true);
    expect(session.prs[1].isDraft).toBe(false);
  });

  it("1.5 — empty prs field falls back to pr field", () => {
    const session = sessionFromMetadata(
      "app-1",
      {
        pr: "https://github.com/acme/main/pull/10",
        prs: "",
        branch: "feat/pr-10",
      },
      baseOptions,
    );
    expect(session.prs).toHaveLength(1);
    expect(session.prs[0].number).toBe(10);
  });

  it("1.6 — no PR fields → pr is null and prs is empty", () => {
    const session = sessionFromMetadata("app-1", {}, baseOptions);
    expect(session.pr).toBeNull();
    expect(session.prs).toHaveLength(0);
  });

  it("1.7 — prs field takes precedence over pr field when both are present", () => {
    const session = sessionFromMetadata(
      "app-1",
      {
        pr: "https://github.com/acme/main/pull/10",
        prs: "https://github.com/acme/main/pull/20,https://github.com/acme/main/pull/21",
        branch: "feat/pr-20",
      },
      baseOptions,
    );
    expect(session.prs).toHaveLength(2);
    expect(session.prs[0].number).toBe(20);
    expect(session.prs[1].number).toBe(21);
    expect(session.pr?.number).toBe(20);
  });

  it("1.8 — URLs with whitespace around commas are trimmed", () => {
    const session = sessionFromMetadata(
      "app-1",
      {
        prs: "https://github.com/acme/main/pull/10 , https://github.com/acme/main/pull/11",
        branch: "feat/pr-10",
      },
      baseOptions,
    );
    expect(session.prs).toHaveLength(2);
    expect(session.prs[0].number).toBe(10);
    expect(session.prs[1].number).toBe(11);
  });

  it("1.9 — owner and repo parsed correctly for each PR", () => {
    const session = sessionFromMetadata(
      "app-1",
      {
        prs: "https://github.com/org-a/repo-x/pull/10,https://github.com/org-b/repo-y/pull/99",
        branch: "feat/pr-10",
      },
      baseOptions,
    );
    expect(session.prs[0].owner).toBe("org-a");
    expect(session.prs[0].repo).toBe("repo-x");
    expect(session.prs[1].owner).toBe("org-b");
    expect(session.prs[1].repo).toBe("repo-y");
  });
});
