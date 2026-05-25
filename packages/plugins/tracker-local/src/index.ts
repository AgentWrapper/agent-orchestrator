/**
 * tracker-local plugin — Local file-based issue tracker.
 *
 * Stores issues as individual JSON files in `.ao/issues/` within the
 * project directory. No external dependencies — fully local.
 *
 * IDs follow the pattern `LOCAL-1`, `LOCAL-2`, … with a configurable prefix.
 * Each issue is a single file: `.ao/issues/<id>.json`.
 */

import {
  atomicWriteFileSync,
  type CreateIssueInput,
  type Issue,
  type IssueFilters,
  type IssueUpdate,
  type PluginModule,
  type PreflightContext,
  type ProjectConfig,
  type Tracker,
} from "@aoagents/ao-core";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_STORAGE_DIR = ".ao/issues";
const DEFAULT_ISSUE_PREFIX = "LOCAL";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStorageDir(project: ProjectConfig, config?: Record<string, unknown>): string {
  const customPath = config?.["storageDir"] ?? project.tracker?.["storageDir"];
  if (typeof customPath === "string") {
    return join(project.path, customPath);
  }
  return join(project.path, DEFAULT_STORAGE_DIR);
}

function getIssuePrefix(config?: Record<string, unknown>): string {
  const customPrefix = config?.["issuePrefix"];
  return typeof customPrefix === "string" && customPrefix.length > 0
    ? customPrefix
    : DEFAULT_ISSUE_PREFIX;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function issueFilePath(dir: string, identifier: string): string {
  return join(dir, `${identifier}.json`);
}

function readIssueFile(filePath: string): Issue | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Issue;
  } catch {
    return null;
  }
}

function writeIssueFile(filePath: string, issue: Issue): void {
  atomicWriteFileSync(filePath, JSON.stringify(issue, null, 2));
}

function listIssueFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

function parseIdentifier(identifier: string, prefix?: string): string {
  const cleaned = identifier.replace(/^#/, "");
  if (prefix && cleaned.startsWith(`${prefix}-`)) return cleaned;
  return cleaned;
}

function extractNumber(id: string, prefix: string): number {
  const numStr = id.replace(`${prefix}-`, "");
  return parseInt(numStr, 10);
}

function nextId(dir: string, prefix: string): string {
  const files = listIssueFiles(dir);
  let max = 0;
  for (const file of files) {
    const idWithoutExt = basename(file, ".json");
    if (idWithoutExt.startsWith(`${prefix}-`)) {
      const num = extractNumber(idWithoutExt, prefix);
      if (num > max) max = num;
    }
  }
  return `${prefix}-${max + 1}`;
}

// ---------------------------------------------------------------------------
// Issue state helpers
// ---------------------------------------------------------------------------

function mapLabelStateToIssueState(state: string | undefined): Exclude<Issue["state"], undefined> {
  switch (state) {
    case "in_progress":
    case "closed":
    case "cancelled":
      return state;
    default:
      return "open";
  }
}

function matchesState(issue: Issue, filterState?: "open" | "closed" | "all"): boolean {
  if (!filterState || filterState === "all") return true;
  if (filterState === "closed") return issue.state === "closed" || issue.state === "cancelled";
  return issue.state === "open" || issue.state === "in_progress";
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createLocalTracker(config?: Record<string, unknown>): Tracker {
  const prefix = getIssuePrefix(config);
  let storageDir: string | undefined;

  function ensureStorage(project: ProjectConfig): string {
    const dir = getStorageDir(project, config);
    storageDir = dir;
    ensureDir(dir);
    return dir;
  }

  const tracker: Tracker = {
    name: "local",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const dir = ensureStorage(project);
      const id = parseIdentifier(identifier, prefix);
      const filePath = issueFilePath(dir, id);
      const issue = readIssueFile(filePath);
      if (!issue) {
        throw Object.assign(new Error(`Local issue not found: ${id}`), { _isIssueNotFound: true });
      }
      return issue;
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const issue = await tracker.getIssue(identifier, project);
      return issue.state === "closed" || issue.state === "cancelled";
    },

    issueUrl(identifier: string, _project: ProjectConfig): string {
      const id = parseIdentifier(identifier, prefix);
      // Returns an http:// URL so the dashboard enrichment pipeline
      // (isAbsoluteUrl in serialize.ts) accepts it. The host "local"
      // does not resolve — this is purely for the enrichment chain.
      return `http://local/${id}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract identifier from URL: http://local/LOCAL-1 → LOCAL-1
      const parts = url.split("/");
      const last = parts[parts.length - 1];
      if (last) return last;
      // Fallback: if URL is empty or malformed, return the issue ID directly
      // This path should not normally be hit since issueUrl always returns a valid URL.
      const match = url.match(/([A-Z]+-\d+)$/);
      return match ? match[1] : url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      const id = parseIdentifier(identifier, prefix);
      return `feat/${id.toLowerCase()}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await tracker.getIssue(identifier, project);
      const lines: string[] = [
        `You are working on local issue ${issue.id}: ${issue.title}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }

      if (issue.priority !== undefined) {
        lines.push(`Priority: ${issue.priority}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this issue. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const dir = ensureStorage(project);
      const files = listIssueFiles(dir);
      const issues: Issue[] = [];

      for (const file of files) {
        const issue = readIssueFile(join(dir, file));
        if (!issue) continue;
        if (!matchesState(issue, filters.state)) continue;

        if (filters.labels && filters.labels.length > 0) {
          const hasAllLabels = filters.labels.every((l) => issue.labels.includes(l));
          if (!hasAllLabels) continue;
        }

        if (filters.assignee && issue.assignee !== filters.assignee) continue;

        issues.push(issue);

        if (filters.limit && issues.length >= filters.limit) break;
      }

      return issues;
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      const dir = ensureStorage(project);
      const id = parseIdentifier(identifier, prefix);
      const filePath = issueFilePath(dir, id);
      const issue = readIssueFile(filePath);
      if (!issue) {
        throw new Error(`Local issue not found: ${id}`);
      }

      if (update.state) {
        issue.state = mapLabelStateToIssueState(update.state);
      }

      if (update.labels && update.labels.length > 0) {
        const existing = new Set(issue.labels);
        for (const label of update.labels) {
          existing.add(label);
        }
        issue.labels = [...existing];
      }

      if (update.removeLabels && update.removeLabels.length > 0) {
        issue.labels = issue.labels.filter((l) => !update.removeLabels!.includes(l));
      }

      if (update.assignee) {
        issue.assignee = update.assignee;
      }

      if (update.comment) {
        // Append comment to description for local issues
        const commentBlock = `\n\n---\nComment: ${update.comment}`;
        issue.description += commentBlock;
      }

      writeIssueFile(filePath, issue);
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const dir = ensureStorage(project);
      const id = nextId(dir, prefix);
      const now = new Date().toISOString();

      const issue: Issue = {
        id,
        title: input.title,
        description: input.description ?? "",
        url: this.issueUrl(id, project),
        state: "open",
        labels: input.labels ?? [],
        assignee: input.assignee,
        priority: input.priority,
      };

      const filePath = issueFilePath(dir, id);
      writeIssueFile(filePath, issue);

      return issue;
    },

    async preflight(context: PreflightContext): Promise<void> {
      const dir = getStorageDir(context.project, config);
      try {
        ensureDir(dir);
        // Verify the directory is writable by attempting to write a test file
        const testFile = join(dir, ".write-test");
        writeFileSync(testFile, "ok", "utf-8");
        unlinkSync(testFile);
      } catch (err) {
        throw new Error(
          `Local tracker: cannot write to storage directory "${dir}". ` +
            `Ensure the directory is accessible. ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };

  return tracker;
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "local",
  slot: "tracker" as const,
  description: "Tracker plugin: Local file-based issues",
  version: "0.1.0",
};

export function create(config?: Record<string, unknown>): Tracker {
  return createLocalTracker(config);
}

export default { manifest, create } satisfies PluginModule<Tracker>;
