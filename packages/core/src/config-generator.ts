/**
 * Config generator for `ao start <url>` — auto-detects project settings
 * from a repo URL and generates a valid agent-orchestrator.yaml.
 *
 * SCM-agnostic: parses GitHub, GitLab, Bitbucket URLs and infers plugins.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { generateSessionPrefix } from "./paths.js";
import { getDefaultRuntime } from "./platform.js";

// Main is the canonical config-schema contract; schema evolution must remain
// forward-compatible and additive for older CLIs that stamp this URL.
export const CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/ComposioHQ/agent-orchestrator/main/schema/config.schema.json";

export function withConfigSchema<T extends Record<string, unknown>>(
  config: T,
): T & { $schema: string } {
  const { $schema: providedSchema, ...rest } = config as {
    $schema?: unknown;
  };
  const schema =
    typeof providedSchema === "string" && providedSchema.trim().length > 0
      ? providedSchema
      : CONFIG_SCHEMA_URL;

  return {
    $schema: schema,
    ...rest,
  } as T & { $schema: string };
}

// =============================================================================
// URL PARSING
// =============================================================================

/** Parsed repo URL components */
export interface ParsedRepoUrl {
  /** Full owner/repo string, e.g. "ComposioHQ/DevOS" */
  ownerRepo: string;
  /** Owner/org, e.g. "ComposioHQ" */
  owner: string;
  /** Repo name, e.g. "DevOS" */
  repo: string;
  /** SCM host, e.g. "github.com" */
  host: string;
  /** Git clone URL (HTTPS) */
  cloneUrl: string;
}

/** Detect which SCM platform a host belongs to */
export type ScmPlatform = "github" | "gitlab" | "bitbucket" | "unknown";

/**
 * Check if a string looks like a repo URL (HTTP(S) or SSH git URL).
 */
export function isRepoUrl(arg: string): boolean {
  return /^https?:\/\//.test(arg) || /^git@[^:]+:.+\/.+/.test(arg);
}

/**
 * Parse a repo URL into components.
 * Supports:
 *   - https://github.com/owner/repo
 *   - https://github.com/owner/repo.git
 *   - git@github.com:owner/repo.git
 *   - Same patterns for GitLab, Bitbucket, etc.
 */
export function parseRepoUrl(url: string): ParsedRepoUrl {
  // SSH format: git@host:owner/repo.git
  const sshMatch = url.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    const host = sshMatch[1];
    const owner = sshMatch[2];
    const repo = sshMatch[3];
    return {
      ownerRepo: `${owner}/${repo}`,
      owner,
      repo,
      host,
      cloneUrl: `https://${host}/${owner}/${repo}.git`,
    };
  }

  // HTTPS format: https://host/owner/repo[.git]
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (httpsMatch) {
    const host = httpsMatch[1];
    const owner = httpsMatch[2];
    const repo = httpsMatch[3];
    return {
      ownerRepo: `${owner}/${repo}`,
      owner,
      repo,
      host,
      cloneUrl: `https://${host}/${owner}/${repo}.git`,
    };
  }

  throw new Error(
    `Could not parse repo URL: ${url}\n` +
      `Expected format: https://github.com/owner/repo or git@github.com:owner/repo.git`,
  );
}

/**
 * Detect SCM platform from hostname.
 */
export function detectScmPlatform(host: string): ScmPlatform {
  const lower = host.toLowerCase();
  if (lower === "github.com" || lower.endsWith(".github.com")) return "github";
  if (lower === "gitlab.com" || lower.endsWith(".gitlab.com")) return "gitlab";
  if (
    lower === "bitbucket.org" ||
    lower.endsWith(".bitbucket.org") ||
    lower.endsWith(".bitbucket.com")
  )
    return "bitbucket";
  return "unknown";
}

// =============================================================================
// PROJECT DETECTION (minimal — reuses cli/project-detection for full detection)
// =============================================================================

/** Detect the default branch from a local repo directory. */
export function detectDefaultBranchFromDir(repoDir: string): string {
  // Check HEAD file for symref
  const headPath = join(repoDir, ".git", "HEAD");
  if (existsSync(headPath)) {
    const head = readFileSync(headPath, "utf-8").trim();
    const match = head.match(/^ref: refs\/heads\/(.+)$/);
    if (match) {
      // This is the current branch, not necessarily the default.
      // Check for common default branch names in refs.
      const commonDefaults = ["main", "master", "next", "develop"];
      for (const branch of commonDefaults) {
        const refPath = join(repoDir, ".git", "refs", "remotes", "origin", branch);
        const packedRefs = join(repoDir, ".git", "packed-refs");
        if (existsSync(refPath)) return branch;
        // Check packed-refs for the branch
        if (existsSync(packedRefs)) {
          const packed = readFileSync(packedRefs, "utf-8");
          if (packed.includes(`refs/remotes/origin/${branch}`)) return branch;
        }
      }
      // Fallback to current branch if no common default found
      return match[1];
    }
  }
  return "main";
}

/** Minimal project type detection for config generation (language + package manager). */
export interface DetectedProjectInfo {
  language: string | null;
  packageManager: string | null;
}

export function detectProjectInfo(repoDir: string): DetectedProjectInfo {
  const hasFile = (name: string) => existsSync(join(repoDir, name));

  if (hasFile("package.json")) {
    const pm = hasFile("pnpm-lock.yaml")
      ? "pnpm"
      : hasFile("yarn.lock")
        ? "yarn"
        : hasFile("bun.lockb") || hasFile("bun.lock")
          ? "bun"
          : "npm";
    const lang =
      hasFile("tsconfig.json") || hasFile("tsconfig.base.json") ? "typescript" : "javascript";
    return { language: lang, packageManager: pm };
  }
  if (hasFile("Cargo.toml")) return { language: "rust", packageManager: "cargo" };
  if (hasFile("go.mod")) return { language: "go", packageManager: "go" };
  if (hasFile("pyproject.toml") || hasFile("requirements.txt") || hasFile("setup.py")) {
    return { language: "python", packageManager: "pip" };
  }

  return { language: null, packageManager: null };
}

export function readOriginRemoteUrl(projectPath: string): string | null {
  const gitConfigPath = join(resolve(projectPath), ".git", "config");
  if (!existsSync(gitConfigPath)) return null;

  const lines = readFileSync(gitConfigPath, "utf-8").split(/\r?\n/);
  let inOrigin = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inOrigin = trimmed === '[remote "origin"]';
      continue;
    }
    if (!inOrigin) continue;

    const match = line.match(/^\s*url\s*=\s*(.+)\s*$/);
    if (match?.[1]) return match[1].trim();
  }

  return null;
}

// =============================================================================
// CONFIG GENERATION
// =============================================================================

/**
 * Sanitize a repo name for use as a YAML project key.
 * Lowercases, replaces dots/special chars with hyphens, strips leading/trailing hyphens.
 */
export function sanitizeProjectId(repoName: string): string {
  return repoName
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export interface GenerateConfigOptions {
  /** Parsed repo URL */
  parsed: ParsedRepoUrl;
  /** Local path to the cloned repo */
  repoPath: string;
  /** Dashboard port (default: 3000) */
  port?: number;
}

/**
 * Generate a complete agent-orchestrator.yaml config object from a repo URL.
 * Returns the raw object ready for YAML serialization.
 */
export function generateConfigFromUrl(options: GenerateConfigOptions): Record<string, unknown> {
  const { parsed, repoPath, port = 3000 } = options;

  const platform = detectScmPlatform(parsed.host);
  const defaultBranch = detectDefaultBranchFromDir(repoPath);
  const projectInfo = detectProjectInfo(repoPath);
  // Use original case for prefix generation (preserves CamelCase detection),
  // lowercase for the YAML project key.
  const projectId = sanitizeProjectId(parsed.repo);
  // Strip characters invalid in sessionPrefix (Zod: [a-zA-Z0-9_-]+) before
  // passing to generateSessionPrefix, so "my.app" → "my-app" → "ma" (kebab path).
  const prefixInput = parsed.repo.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  const prefix = generateSessionPrefix(prefixInput || parsed.repo);

  // Build project config
  const projectConfig: Record<string, unknown> = {
    name: parsed.repo,
    repo: parsed.ownerRepo,
    path: repoPath,
    defaultBranch,
    sessionPrefix: prefix,
  };

  // SCM plugin — always set explicitly so applyProjectDefaults doesn't override.
  // For known platforms, use the matching plugin. For unknown hosts, default to github
  // (best available option since it's the only fully implemented SCM plugin).
  projectConfig.scm = { plugin: platform !== "unknown" ? platform : "github" };

  // Tracker — same platform as SCM for known hosts, github as fallback
  projectConfig.tracker = {
    plugin: platform === "github" || platform === "gitlab" ? platform : "github",
  };

  // Post-create commands based on detected package manager (JS ecosystem only)
  const JS_PACKAGE_MANAGERS: Record<string, string> = {
    pnpm: "pnpm install",
    yarn: "yarn install",
    bun: "bun install",
    npm: "npm install",
  };
  const installCmd = projectInfo.packageManager
    ? JS_PACKAGE_MANAGERS[projectInfo.packageManager]
    : undefined;
  if (installCmd) {
    projectConfig.postCreate = [installCmd];
  }

  return withConfigSchema({
    port,
    defaults: {
      runtime: getDefaultRuntime(),
      agent: "claude-code",
      workspace: "worktree",
      notifiers: [],
    },
    projects: {
      [projectId]: projectConfig,
    },
  });
}

/**
 * Serialize a config object to YAML string.
 */
export function configToYaml(config: Record<string, unknown>): string {
  return yamlStringify(withConfigSchema(config), { indent: 2 });
}

/**
 * Check if a directory already has the repo cloned by comparing remote URLs.
 * Returns true if the directory is a git repo with a matching origin remote.
 */
export function isRepoAlreadyCloned(dir: string, expectedCloneUrl: string): boolean {
  if (!existsSync(join(dir, ".git"))) return false;

  const configPath = join(dir, ".git", "config");
  if (!existsSync(configPath)) return false;

  const gitConfig = readFileSync(configPath, "utf-8");

  // Normalize URLs for comparison:
  // - Convert SSH to HTTPS (git@host:owner/repo → https://host/owner/repo)
  // - Strip .git suffix and trailing slashes
  // - Lowercase for case-insensitive match
  const normalize = (url: string) => {
    let normalized = url.trim();
    // Convert SSH format to HTTPS
    const sshMatch = normalized.match(/^git@([^:]+):(.+)$/);
    if (sshMatch) {
      normalized = `https://${sshMatch[1]}/${sshMatch[2]}`;
    }
    return normalized
      .replace(/\.git$/, "")
      .replace(/\/$/, "")
      .toLowerCase();
  };

  const expectedNorm = normalize(expectedCloneUrl);

  // Look for url = ... lines in git config
  const urlMatches = gitConfig.match(/url\s*=\s*(.+)/g);
  if (!urlMatches) return false;

  return urlMatches.some((line) => {
    const url = line.replace(/url\s*=\s*/, "").trim();
    return normalize(url) === expectedNorm;
  });
}

/**
 * Determine the target directory for cloning a repo.
 * If CWD matches the repo, return CWD. Otherwise return CWD/repo-name.
 */
export function resolveCloneTarget(parsed: ParsedRepoUrl, cwd: string): string {
  // If CWD is already the repo, reuse it
  if (isRepoAlreadyCloned(cwd, parsed.cloneUrl)) {
    return cwd;
  }

  // If CWD/repo-name exists and matches, reuse it
  const subDir = resolve(cwd, parsed.repo);
  if (isRepoAlreadyCloned(subDir, parsed.cloneUrl)) {
    return subDir;
  }

  // Clone into CWD/repo-name
  return subDir;
}
