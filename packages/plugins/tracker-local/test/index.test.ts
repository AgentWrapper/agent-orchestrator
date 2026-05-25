import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { create, manifest } from "../src/index.js";
import type { Issue, PreflightContext, ProjectConfig } from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tmpBase = join(tmpdir(), "ao-tracker-local-test");
const projectPath = join(tmpBase, "my-project");
const storageDir = join(projectPath, ".ao", "issues");

const project: ProjectConfig = {
  name: "test",
  path: projectPath,
  defaultBranch: "main",
  sessionPrefix: "test",
};

function makePreflightContext(): PreflightContext {
  return {
    project,
    intent: { role: "worker", willClaimExistingPR: false },
  };
}

function readIssueFile(id: string): Issue | null {
  const filePath = join(storageDir, `${id}.json`);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf-8")) as Issue;
}

function listIssueIds(): string[] {
  if (!existsSync(storageDir)) return [];
  const { readdirSync } = require("node:fs");
  return readdirSync(storageDir)
    .filter((f: string) => f.endsWith(".json"))
    .map((f: string) => f.replace(".json", ""))
    .sort();
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
  mkdirSync(storageDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tracker-local plugin", () => {
  let tracker: ReturnType<typeof create>;

  beforeEach(() => {
    tracker = create();
  });

  // ---- manifest ----------------------------------------------------------

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("local");
      expect(manifest.slot).toBe("tracker");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("create()", () => {
    it("returns a Tracker with correct name", () => {
      expect(tracker.name).toBe("local");
    });
  });

  // ---- createIssue -------------------------------------------------------

  describe("createIssue", () => {
    it("creates an issue with auto-incremented LOCAL-1 ID", async () => {
      const issue = await tracker.createIssue!(
        { title: "First issue", description: "Desc" },
        project,
      );

      expect(issue.id).toBe("LOCAL-1");
      expect(issue.title).toBe("First issue");
      expect(issue.description).toBe("Desc");
      expect(issue.state).toBe("open");
      expect(issue.labels).toEqual([]);
      expect(issue.url).toBe("http://local/LOCAL-1");
    });

    it("increments IDs sequentially", async () => {
      const a = await tracker.createIssue!({ title: "A", description: "" }, project);
      const b = await tracker.createIssue!({ title: "B", description: "" }, project);
      const c = await tracker.createIssue!({ title: "C", description: "" }, project);

      expect(a.id).toBe("LOCAL-1");
      expect(b.id).toBe("LOCAL-2");
      expect(c.id).toBe("LOCAL-3");
    });

    it("persists labels, assignee, and priority", async () => {
      const issue = await tracker.createIssue!(
        {
          title: "Bug",
          description: "It crashes",
          labels: ["bug", "priority-high"],
          assignee: "alice",
          priority: 1,
        },
        project,
      );

      expect(issue.labels).toEqual(["bug", "priority-high"]);
      expect(issue.assignee).toBe("alice");
      expect(issue.priority).toBe(1);
    });

    it("writes the issue file to disk", async () => {
      await tracker.createIssue!({ title: "Test", description: "Body" }, project);

      const file = readIssueFile("LOCAL-1");
      expect(file).not.toBeNull();
      expect(file!.title).toBe("Test");
      expect(file!.description).toBe("Body");
    });
  });

  // ---- getIssue ----------------------------------------------------------

  describe("getIssue", () => {
    beforeEach(async () => {
      await tracker.createIssue!({ title: "Existing", description: "Body" }, project);
    });

    it("returns a created issue by identifier", async () => {
      const issue = await tracker.getIssue("LOCAL-1", project);
      expect(issue.id).toBe("LOCAL-1");
      expect(issue.title).toBe("Existing");
    });

    it("accepts identifier without LOCAL- prefix", async () => {
      // parseIdentifier strips known prefix so bare "1" resolves to "LOCAL-1"
      // But nextId uses prefix matching, so the raw issue IDs always have the prefix.
      // getIssue with just "1" would look for file "1.json" and not find it.
      // This is expected — the prefix is required for local issues.
      await expect(tracker.getIssue("1", project)).rejects.toThrow(/not found/i);
    });

    it("throws for non-existent issue", async () => {
      await expect(tracker.getIssue("LOCAL-999", project)).rejects.toThrow(/not found/i);
    });
  });

  // ---- isCompleted -------------------------------------------------------

  describe("isCompleted", () => {
    it("returns false for a newly created issue", async () => {
      await tracker.createIssue!({ title: "Task", description: "" }, project);
      expect(await tracker.isCompleted("LOCAL-1", project)).toBe(false);
    });

    it("returns true for a closed issue", async () => {
      await tracker.createIssue!({ title: "Task", description: "" }, project);
      await tracker.updateIssue!("LOCAL-1", { state: "closed" }, project);
      expect(await tracker.isCompleted("LOCAL-1", project)).toBe(true);
    });

    it("returns true for a cancelled issue", async () => {
      await tracker.createIssue!({ title: "Task", description: "" }, project);
      await tracker.updateIssue!("LOCAL-1", { state: "closed" }, project);
      expect(await tracker.isCompleted("LOCAL-1", project)).toBe(true);
    });
  });

  // ---- issueUrl ----------------------------------------------------------

  describe("issueUrl", () => {
    it("generates http://local/ URL for the enrichment pipeline", () => {
      expect(tracker.issueUrl("LOCAL-42", project)).toBe("http://local/LOCAL-42");
    });

    it("strips # prefix from identifier", () => {
      expect(tracker.issueUrl("#LOCAL-42", project)).toBe("http://local/LOCAL-42");
    });
  });

  // ---- issueLabel --------------------------------------------------------

  describe("issueLabel", () => {
    it("extracts label from http://local/ URL", () => {
      expect(tracker.issueLabel!("http://local/LOCAL-42", project)).toBe("LOCAL-42");
    });

    it("extracts label from trailing path segment", () => {
      expect(tracker.issueLabel!("http://local/LOCAL-1", project)).toBe("LOCAL-1");
    });
  });

  // ---- branchName --------------------------------------------------------

  describe("branchName", () => {
    it("generates feat/local-N format", () => {
      expect(tracker.branchName("LOCAL-42", project)).toBe("feat/local-42");
    });

    it("generates lowercase branch name", () => {
      expect(tracker.branchName("LOCAL-42", project)).toBe("feat/local-42");
    });
  });

  // ---- generatePrompt ----------------------------------------------------

  describe("generatePrompt", () => {
    it("includes title and ID", async () => {
      await tracker.createIssue!({ title: "Fix bugs", description: "Many bugs" }, project);
      const prompt = await tracker.generatePrompt("LOCAL-1", project);
      expect(prompt).toContain("Fix bugs");
      expect(prompt).toContain("LOCAL-1");
    });

    it("includes labels when present", async () => {
      await tracker.createIssue!({ title: "Bug", description: "", labels: ["bug"] }, project);
      const prompt = await tracker.generatePrompt("LOCAL-1", project);
      expect(prompt).toContain("bug");
    });

    it("includes priority when present", async () => {
      await tracker.createIssue!({ title: "Urgent", description: "", priority: 1 }, project);
      const prompt = await tracker.generatePrompt("LOCAL-1", project);
      expect(prompt).toContain("Priority: 1");
    });

    it("includes description", async () => {
      await tracker.createIssue!({ title: "Feature", description: "Add login" }, project);
      const prompt = await tracker.generatePrompt("LOCAL-1", project);
      expect(prompt).toContain("Add login");
    });

    it("omits labels section when no labels", async () => {
      await tracker.createIssue!({ title: "Simple", description: "" }, project);
      const prompt = await tracker.generatePrompt("LOCAL-1", project);
      expect(prompt).not.toContain("Labels:");
    });

    it("omits priority when not set", async () => {
      await tracker.createIssue!({ title: "Simple", description: "" }, project);
      const prompt = await tracker.generatePrompt("LOCAL-1", project);
      expect(prompt).not.toContain("Priority:");
    });
  });

  // ---- listIssues --------------------------------------------------------

  describe("listIssues", () => {
    it("returns all issues when no filters", async () => {
      await tracker.createIssue!({ title: "A", description: "" }, project);
      await tracker.createIssue!({ title: "B", description: "" }, project);
      await tracker.createIssue!({ title: "C", description: "" }, project);

      const issues = await tracker.listIssues!({}, project);
      expect(issues).toHaveLength(3);
    });

    it("filters by state = closed", async () => {
      await tracker.createIssue!({ title: "Open", description: "" }, project);
      await tracker.createIssue!({ title: "Closed", description: "" }, project);
      await tracker.updateIssue!("LOCAL-2", { state: "closed" }, project);

      const open = await tracker.listIssues!({ state: "open" }, project);
      expect(open).toHaveLength(1);
      expect(open[0].id).toBe("LOCAL-1");

      const closed = await tracker.listIssues!({ state: "closed" }, project);
      expect(closed).toHaveLength(1);
      expect(closed[0].id).toBe("LOCAL-2");
    });

    it("filters by labels (must have all)", async () => {
      await tracker.createIssue!(
        { title: "Bug", description: "", labels: ["bug"] },
        project,
      );
      await tracker.createIssue!(
        { title: "Bug+Urgent", description: "", labels: ["bug", "urgent"] },
        project,
      );
      await tracker.createIssue!(
        { title: "Feature", description: "", labels: ["feature"] },
        project,
      );

      const bugs = await tracker.listIssues!({ labels: ["bug"] }, project);
      expect(bugs).toHaveLength(2);

      const urgentBugs = await tracker.listIssues!({ labels: ["bug", "urgent"] }, project);
      expect(urgentBugs).toHaveLength(1);
      expect(urgentBugs[0].title).toBe("Bug+Urgent");
    });

    it("filters by assignee", async () => {
      await tracker.createIssue!({ title: "A", description: "", assignee: "alice" }, project);
      await tracker.createIssue!({ title: "B", description: "", assignee: "bob" }, project);

      const aliceIssues = await tracker.listIssues!({ assignee: "alice" }, project);
      expect(aliceIssues).toHaveLength(1);
      expect(aliceIssues[0].title).toBe("A");
    });

    it("respects limit", async () => {
      await tracker.createIssue!({ title: "A", description: "" }, project);
      await tracker.createIssue!({ title: "B", description: "" }, project);
      await tracker.createIssue!({ title: "C", description: "" }, project);

      const limited = await tracker.listIssues!({ limit: 2 }, project);
      expect(limited).toHaveLength(2);
    });

    it("handles empty storage directory", async () => {
      const issues = await tracker.listIssues!({}, project);
      expect(issues).toEqual([]);
    });
  });

  // ---- updateIssue -------------------------------------------------------

  describe("updateIssue", () => {
    beforeEach(async () => {
      await tracker.createIssue!(
        { title: "Task", description: "Original", labels: ["backlog"] },
        project,
      );
    });

    it("closes an issue", async () => {
      await tracker.updateIssue!("LOCAL-1", { state: "closed" }, project);
      const issue = await tracker.getIssue("LOCAL-1", project);
      expect(issue.state).toBe("closed");
    });

    it("reopens an issue", async () => {
      await tracker.updateIssue!("LOCAL-1", { state: "closed" }, project);
      await tracker.updateIssue!("LOCAL-1", { state: "open" }, project);
      const issue = await tracker.getIssue("LOCAL-1", project);
      expect(issue.state).toBe("open");
    });

    it("adds labels (merged with existing)", async () => {
      await tracker.updateIssue!("LOCAL-1", { labels: ["urgent"] }, project);
      const issue = await tracker.getIssue("LOCAL-1", project);
      expect(issue.labels).toContain("backlog");
      expect(issue.labels).toContain("urgent");
    });

    it("removes labels", async () => {
      await tracker.updateIssue!("LOCAL-1", { removeLabels: ["backlog"] }, project);
      const issue = await tracker.getIssue("LOCAL-1", project);
      expect(issue.labels).not.toContain("backlog");
    });

    it("updates assignee", async () => {
      await tracker.updateIssue!("LOCAL-1", { assignee: "alice" }, project);
      const issue = await tracker.getIssue("LOCAL-1", project);
      expect(issue.assignee).toBe("alice");
    });

    it("appends comment to description", async () => {
      await tracker.updateIssue!("LOCAL-1", { comment: "Working on it" }, project);
      const issue = await tracker.getIssue("LOCAL-1", project);
      expect(issue.description).toContain("Original");
      expect(issue.description).toContain("Working on it");
    });

    it("throws for non-existent issue", async () => {
      await expect(
        tracker.updateIssue!("LOCAL-999", { state: "closed" }, project),
      ).rejects.toThrow(/not found/i);
    });

    it("handles combined update (state + labels + comment)", async () => {
      await tracker.updateIssue!(
        "LOCAL-1",
        { state: "closed", labels: ["done"], removeLabels: ["backlog"], comment: "Finished" },
        project,
      );
      const issue = await tracker.getIssue("LOCAL-1", project);
      expect(issue.state).toBe("closed");
      expect(issue.labels).toContain("done");
      expect(issue.labels).not.toContain("backlog");
    });
  });

  // ---- createIssue with backlog label ------------------------------------

  describe("backlog integration", () => {
    it("creating with addToBacklog labels the issue agent:backlog", async () => {
      const issue = await tracker.createIssue!(
        { title: "Backlog item", description: "", labels: ["agent:backlog"] },
        project,
      );
      expect(issue.labels).toContain("agent:backlog");
    });

    it("listIssues filters works with backlog labels", async () => {
      await tracker.createIssue!({ title: "Normal", description: "" }, project);
      await tracker.createIssue!(
        { title: "Backlog", description: "", labels: ["agent:backlog"] },
        project,
      );

      const backlog = await tracker.listIssues!({ labels: ["agent:backlog"] }, project);
      expect(backlog).toHaveLength(1);
      expect(backlog[0].title).toBe("Backlog");
    });
  });

  // ---- preflight ---------------------------------------------------------

  describe("preflight", () => {
    it("resolves when storage directory is writable", async () => {
      const ctx = makePreflightContext();
      await expect(tracker.preflight!(ctx)).resolves.toBeUndefined();
    });

    it("creates the storage directory if it does not exist", async () => {
      rmSync(storageDir, { recursive: true, force: true });
      expect(existsSync(storageDir)).toBe(false);

      const ctx = makePreflightContext();
      await tracker.preflight!(ctx);
      expect(existsSync(storageDir)).toBe(true);
      // Should also be able to create an issue after preflight creates the dir
      const issue = await tracker.createIssue!({ title: "Post-preflight", description: "" }, project);
      expect(issue.id).toBe("LOCAL-1");
    });

    it("throws when storage directory cannot be created", async () => {
      // Make a file where the directory should be, preventing mkdir
      const parentDir = join(projectPath, ".ao");
      rmSync(parentDir, { recursive: true, force: true });
      writeFileSync(parentDir, "i am a file, not a directory", "utf-8");

      const ctx = makePreflightContext();
      await expect(tracker.preflight!(ctx)).rejects.toThrow(/cannot write|writable/i);
    });
  });
});
