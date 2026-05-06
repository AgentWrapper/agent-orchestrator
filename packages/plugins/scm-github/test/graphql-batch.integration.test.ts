/**
 * Integration tests for GraphQL batch PR enrichment.
 *
 * These tests require a valid GitHub token and make real API calls.
 * They are skipped by default and can be run with:
 *   npm run test:integration
 */

import { describe, it, expect } from "vitest";
import { enrichSessionsPRBatch, generateBatchQuery } from "../src/graphql-batch.js";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const SKIP_INTEGRATION_TESTS = !GITHUB_TOKEN;

describe.skipIf(SKIP_INTEGRATION_TESTS)("GraphQL Batch Enrichment Integration", () => {
  const testPRs = [
    {
      owner: "ComposioHQ",
      repo: "agent-orchestrator",
      number: 1,
      url: "https://github.com/ComposioHQ/agent-orchestrator/pull/1",
      title: "Test PR",
      branch: "test-branch",
      baseBranch: "main",
      isDraft: false,
    },
  ];

  it("should enrich a single real PR", async () => {
    const result = await enrichSessionsPRBatch(testPRs);

    expect(result.size).toBeGreaterThan(0);

    const enrichment = result.get("ComposioHQ/agent-orchestrator#1");
    expect(enrichment).toBeDefined();
    expect(enrichment?.state).toMatch(/^(open|merged|closed)$/);
    expect(enrichment?.ciStatus).toMatch(/^(passing|failing|pending|none)$/);
    expect(enrichment?.reviewDecision).toMatch(/^(approved|changes_requested|pending|none)$/);
    expect(typeof enrichment?.mergeable).toBe("boolean");
  }, 30000);

  it("should handle non-existent PR gracefully", async () => {
    const nonExistentPRs = [
      {
        owner: "ComposioHQ",
        repo: "agent-orchestrator",
        number: 99999999,
        url: "https://github.com/ComposioHQ/agent-orchestrator/pull/99999999",
        title: "Non-existent",
        branch: "non-existent",
        baseBranch: "main",
        isDraft: false,
      },
    ];

    const result = await enrichSessionsPRBatch(nonExistentPRs);

    // Should return enrichment data even for non-existent PRs
    expect(result.size).toBe(1);
    const enrichment = result.get("ComposioHQ/agent-orchestrator#99999999");
    expect(enrichment).toBeDefined();
    // Non-existent PRs should be marked as not mergeable
    expect(enrichment?.mergeable).toBe(false);
  }, 30000);

  it("should enrich multiple PRs in a single batch", async () => {
    // Test with multiple PRs from the same repo
    const multiPRs = [
      {
        owner: "ComposioHQ",
        repo: "agent-orchestrator",
        number: 1,
        url: "https://github.com/ComposioHQ/agent-orchestrator/pull/1",
        title: "PR 1",
        branch: "branch1",
        baseBranch: "main",
        isDraft: false,
      },
      {
        owner: "ComposioHQ",
        repo: "agent-orchestrator",
        number: 2,
        url: "https://github.com/ComposioHQ/agent-orchestrator/pull/2",
        title: "PR 2",
        branch: "branch2",
        baseBranch: "main",
        isDraft: false,
      },
    ];

    const result = await enrichSessionsPRBatch(multiPRs);

    expect(result.size).toBe(2);

    const pr1 = result.get("ComposioHQ/agent-orchestrator#1");
    const pr2 = result.get("ComposioHQ/agent-orchestrator#2");

    expect(pr1).toBeDefined();
    expect(pr2).toBeDefined();

    // Both should have valid state data
    expect(pr1?.state).toMatch(/^(open|merged|closed)$/);
    expect(pr2?.state).toMatch(/^(open|merged|closed)$/);
  }, 30000);

  it("should handle empty PR list", async () => {
    const result = await enrichSessionsPRBatch([]);
    expect(result.size).toBe(0);
  }, 10000);

  it("should handle PRs from different repositories", async () => {
    const multiRepoPRs = [
      {
        owner: "ComposioHQ",
        repo: "agent-orchestrator",
        number: 1,
        url: "https://github.com/ComposioHQ/agent-orchestrator/pull/1",
        title: "PR in repo 1",
        branch: "branch1",
        baseBranch: "main",
        isDraft: false,
      },
      {
        owner: "facebook",
        repo: "react",
        number: 1,
        url: "https://github.com/facebook/react/pull/1",
        title: "PR in repo 2",
        branch: "branch2",
        baseBranch: "main",
        isDraft: false,
      },
    ];

    const result = await enrichSessionsPRBatch(multiRepoPRs);

    // Should return results for both PRs (even if one fails)
    expect(result.size).toBeGreaterThanOrEqual(1);
  }, 30000);
});

describe("GraphQL Query Generation", () => {
  it("should generate valid GraphQL query structure", () => {
    const prs = [
      {
        owner: "test",
        repo: "test-repo",
        number: 1,
        url: "https://github.com/test/test-repo/pull/1",
        title: "Test",
        branch: "test",
        baseBranch: "main",
        isDraft: false,
      },
    ];

    const { query, variables } = generateBatchQuery(prs);

    // Verify query structure
    expect(query).toMatch(/^query BatchPRs\(/);
    expect(query).toContain("$pr0Owner: String!");
    expect(query).toContain("$pr0Name: String!");
    expect(query).toContain("$pr0Number: Int!");
    expect(query).toContain("pr0: repository");
    expect(query).toContain("pullRequest");

    // Verify variable structure
    expect(variables.pr0Owner).toBe("test");
    expect(variables.pr0Name).toBe("test-repo");
    expect(variables.pr0Number).toBe(1);
  });

  it("should handle PR with special characters in repo name", () => {
    const prs = [
      {
        owner: "my-org",
        repo: "my.repo_with_special",
        number: 1,
        url: "https://github.com/my-org/my.repo_with_special/pull/1",
        title: "Test",
        branch: "test",
        baseBranch: "main",
        isDraft: false,
      },
    ];

    const { query, variables } = generateBatchQuery(prs);

    // Variables should preserve special characters
    expect(variables.pr0Owner).toBe("my-org");
    expect(variables.pr0Name).toBe("my.repo_with_special");

    // Query should use the variable names, not inline values
    expect(query).toContain("$pr0Owner");
    expect(query).toContain("$pr0Name");
  });

  it("should generate query with all required PR fields", () => {
    const prs = [
      {
        owner: "test",
        repo: "test",
        number: 1,
        url: "https://github.com/test/test/pull/1",
        title: "Test",
        branch: "test",
        baseBranch: "main",
        isDraft: false,
      },
    ];

    const { query } = generateBatchQuery(prs);

    // Check that all fields we need are present
    const requiredFields = [
      "title",
      "state",
      "additions",
      "deletions",
      "isDraft",
      "mergeable",
      "mergeStateStatus",
      "reviewDecision",
      "commits",
      "statusCheckRollup",
    ];

    for (const field of requiredFields) {
      expect(query).toContain(field);
    }
  });
});
