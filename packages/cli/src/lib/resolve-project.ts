/**
 * Unified project resolution for `ao start`.
 *
 * Replaces the per-arg-shape dispatch that lived inline in start.ts (URL →
 * handleUrlStart, path → addProjectToConfig, none → loadConfig/autoCreate +
 * registerFlatConfig recovery, project-id → resolveProject). Each shape
 * still has its own helper here, but they all return the same shape so
 * the caller can treat them uniformly.
 *
 * The same resolver runs whether or not a daemon is already up. When a
 * daemon is running, callers pass `targetGlobalRegistry: true` so URL/path
 * args register the project in the global config (the daemon's source of
 * truth) rather than into the cwd-local config a non-running fresh start
 * would generate.
 */

import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cwd } from "node:process";
import {
  ConfigNotFoundError,
  detectScmPlatform,
  findConfigFile,
  generateConfigFromUrl,
  configToYaml,
  isRepoUrl,
  loadConfig,
  parseRepoUrl,
  registerProjectInGlobalConfig,
  resolveCloneTarget,
  isRepoAlreadyCloned,
  getGlobalConfigPath,
  sanitizeProjectId,
  writeLocalProjectConfig,
  type OrchestratorConfig,
  type ParsedRepoUrl,
  type ProjectConfig,
} from "@aoagents/ao-core";
import chalk from "chalk";
import ora from "ora";
import { findFreePort } from "./web-dir.js";
import { DEFAULT_PORT } from "./constants.js";
import { ensureGit } from "./startup-preflight.js";
import { git } from "./shell.js";

export type ProjectSource = "url" | "path" | "cwd" | "existing-id";

export interface Resolved {
  config: OrchestratorConfig;
  projectId: string;
  project: ProjectConfig;
  source: ProjectSource;
  /** True when this resolve call wrote new state to disk (cloned a repo,
   *  generated a config, or registered a project). False when the project
   *  was already known. Useful for dashboard cache invalidation hints. */
  justCreated: boolean;
  /** Populated only when source === "url". */
  parsed?: ParsedRepoUrl;
}

/**
 * Dependencies the resolver needs to delegate to existing start.ts helpers.
 * Passed in rather than imported to keep this module decoupled from
 * start.ts's other concerns (interactive prompts, agent detection, etc.).
 */
export interface ResolveDeps {
  /**
   * Add an unregistered local path as a new project. The signature matches
   * start.ts's `addProjectToConfig`. Returns the registered project id.
   */
  addProjectToConfig: (config: OrchestratorConfig, path: string) => Promise<string>;
  /**
   * Auto-create a config when none exists at `workingDir`. Matches
   * start.ts's `autoCreateConfig`. Returns the loaded config.
   */
  autoCreateConfig: (workingDir: string) => Promise<OrchestratorConfig>;
  /**
   * Resolve an existing project from a loaded config (handles single-
   * project, explicit arg, multi-project prompt). Matches start.ts's
   * `resolveProject`.
   */
  resolveProject: (
    config: OrchestratorConfig,
    projectArg?: string,
  ) => Promise<{ projectId: string; project: ProjectConfig; config: OrchestratorConfig }>;
  /**
   * Resolve a project from a loaded config by matching the URL's
   * `ownerRepo`. Matches start.ts's `resolveProjectByRepo`.
   */
  resolveProjectByRepo: (
    config: OrchestratorConfig,
    parsed: ParsedRepoUrl,
  ) => Promise<{ projectId: string; project: ProjectConfig; config: OrchestratorConfig }>;
  /**
   * Recover a flat local config that exists but isn't registered globally.
   * Matches start.ts's `registerFlatConfig`. Returns the registered id, or
   * null if recovery is not possible.
   */
  registerFlatConfig: (configPath: string) => Promise<string | null>;
  /**
   * Clone a repo into the target dir. Matches start.ts's `cloneRepo`.
   */
  cloneRepo: (parsed: ParsedRepoUrl, targetDir: string, cwd: string) => Promise<void>;
}

/**
 * Options that change how the resolver writes new state to disk.
 *
 * `targetGlobalRegistry`:
 *   When `true`, URL and path arguments resolve and register against the
 *   global config (`~/.agent-orchestrator/config.yaml`) rather than a cwd-
 *   local one. Used when an `ao` daemon is already running — the daemon's
 *   project supervisor reads from the global registry, so anything we
 *   freshly clone or add must land there to be visible.
 *
 *   When `false` (default), the resolver behaves as if this were the very
 *   first `ao start`: URL clones generate a wrapped (`projects:`) yaml in
 *   the cloned repo, paths register against whatever config the cwd walks
 *   up to find.
 */
export interface ResolveOptions {
  targetGlobalRegistry?: boolean;
}

/**
 * Decide whether `arg` looks like a path (rather than a project id).
 * Matches start.ts's `isLocalPath`.
 */
function isLocalPath(arg: string): boolean {
  return arg.startsWith("/") || arg.startsWith("~") || arg.startsWith("./") || arg.startsWith("..");
}

/**
 * Resolve symlink chains for canonical path comparison. Falls back to the
 * input on any filesystem error so the caller can compare unreadable paths
 * literally rather than crash. Mirrors the canonical-compare pattern used
 * elsewhere in the CLI for global-registry dedup.
 */
function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Detect the actual default branch of a freshly cloned repo. Prefers
 * `origin/HEAD` (the remote's default), falls back to the current local
 * branch. Returns null for empty repos (no commits).
 */
async function detectClonedRepoDefaultBranch(repoPath: string): Promise<string | null> {
  const symref = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], repoPath);
  if (symref) {
    const match = symref.trim().match(/^refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1];
  }
  const head = await git(["symbolic-ref", "--short", "HEAD"], repoPath);
  if (head) {
    const trimmed = head.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/**
 * Clone (or reuse) a URL and register the project in the global config.
 * The repo gets a flat local config (behavior only — scm/tracker plugin
 * choices); identity (path, repo, defaultBranch, sessionPrefix) lives in
 * the global registry so the daemon's project supervisor can see it.
 *
 * Mirrors the inline clone+register block that previously lived in start.ts
 * for the "AO already running + URL arg" case.
 */
async function fromUrlIntoGlobal(arg: string, deps: ResolveDeps): Promise<Resolved> {
  const parsed = parseRepoUrl(arg);
  const globalConfigPath = getGlobalConfigPath();
  const globalConfig = existsSync(globalConfigPath) ? loadConfig(globalConfigPath) : loadConfig();

  // Existing project with the same repo? Skip the clone entirely.
  for (const [id, p] of Object.entries(globalConfig.projects)) {
    if (p.repo === parsed.ownerRepo) {
      return {
        config: globalConfig,
        projectId: id,
        project: p,
        source: "url",
        justCreated: false,
        parsed,
      };
    }
  }

  console.log(chalk.bold.cyan(`\n  Cloning ${parsed.ownerRepo} (${parsed.host})\n`));
  await ensureGit("repository cloning");

  const cwdDir = process.cwd();
  const targetDir = resolveCloneTarget(parsed, cwdDir);
  if (isRepoAlreadyCloned(targetDir, parsed.cloneUrl)) {
    console.log(chalk.green(`  Reusing existing clone at ${targetDir}`));
  } else {
    try {
      await deps.cloneRepo(parsed, targetDir, cwdDir);
      console.log(chalk.green(`  Cloned to ${targetDir}`));
    } catch (err) {
      throw new Error(
        `Failed to clone ${parsed.ownerRepo}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  // Empty repos can't host an orchestrator worktree — fail early with a
  // clear message instead of a confusing "Unable to resolve base ref" later.
  const detectedBranch = await detectClonedRepoDefaultBranch(targetDir);
  if (!detectedBranch) {
    throw new Error(
      `Repository "${parsed.ownerRepo}" appears to be empty (no commits or refs).\n` +
        `  AO needs at least one commit on the default branch to spawn an orchestrator.\n` +
        `  Push an initial commit, then re-run \`ao start ${arg}\`.`,
    );
  }

  const platform = detectScmPlatform(parsed.host);
  const requestedProjectId = sanitizeProjectId(parsed.repo);
  const registeredId = registerProjectInGlobalConfig(
    requestedProjectId,
    parsed.repo,
    targetDir,
    {
      repo: parsed.ownerRepo,
      defaultBranch: detectedBranch,
    },
    globalConfigPath,
  );

  // Write a flat local config (behavior only, no `projects:` wrapper, no
  // identity fields). Identity lives in the global registry; this file
  // holds plugin choices for the project. Skip if the upstream commits its
  // own agent-orchestrator.yaml — leave it for the user to reconcile.
  const hasCommittedConfig =
    existsSync(resolve(targetDir, "agent-orchestrator.yaml")) ||
    existsSync(resolve(targetDir, "agent-orchestrator.yml"));
  if (!hasCommittedConfig) {
    writeLocalProjectConfig(targetDir, {
      scm: { plugin: platform !== "unknown" ? platform : "github" },
      tracker: {
        plugin: platform === "gitlab" ? "gitlab" : "github",
      },
    });
  }

  const refreshedConfig = loadConfig(globalConfigPath);
  const project = refreshedConfig.projects[registeredId];
  if (!project) {
    throw new Error(
      `Failed to register "${registeredId}" in the global config — aborting.`,
    );
  }
  return {
    config: refreshedConfig,
    projectId: registeredId,
    project,
    source: "url",
    justCreated: true,
    parsed,
  };
}

async function fromUrl(arg: string, deps: ResolveDeps, opts: ResolveOptions): Promise<Resolved> {
  if (opts.targetGlobalRegistry) {
    return fromUrlIntoGlobal(arg, deps);
  }

  console.log(chalk.bold.cyan("\n  Agent Orchestrator — Quick Start\n"));
  const spinner = ora();

  spinner.start("Parsing repository URL");
  const parsed = parseRepoUrl(arg);
  spinner.succeed(`Repository: ${chalk.cyan(parsed.ownerRepo)} (${parsed.host})`);

  await ensureGit("repository cloning");

  const cwdDir = process.cwd();
  const targetDir = resolveCloneTarget(parsed, cwdDir);
  const alreadyCloned = isRepoAlreadyCloned(targetDir, parsed.cloneUrl);

  if (alreadyCloned) {
    console.log(chalk.green(`  Reusing existing clone at ${targetDir}`));
  } else {
    spinner.start(`Cloning ${parsed.ownerRepo}`);
    try {
      spinner.stop();
      await deps.cloneRepo(parsed, targetDir, cwdDir);
      spinner.succeed(`Cloned to ${targetDir}`);
    } catch (err) {
      spinner.fail("Clone failed");
      throw new Error(
        `Failed to clone ${parsed.ownerRepo}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  const configPath = resolve(targetDir, "agent-orchestrator.yaml");
  const configPathAlt = resolve(targetDir, "agent-orchestrator.yml");

  let config: OrchestratorConfig;
  let justCreated: boolean;
  if (existsSync(configPath)) {
    console.log(chalk.green(`  Using existing config: ${configPath}`));
    config = loadConfig(configPath);
    justCreated = false;
  } else if (existsSync(configPathAlt)) {
    console.log(chalk.green(`  Using existing config: ${configPathAlt}`));
    config = loadConfig(configPathAlt);
    justCreated = false;
  } else {
    spinner.start("Generating config");
    const freePort = await findFreePort(DEFAULT_PORT);
    const rawConfig = generateConfigFromUrl({
      parsed,
      repoPath: targetDir,
      port: freePort ?? DEFAULT_PORT,
    });
    const yamlContent = configToYaml(rawConfig);
    writeFileSync(configPath, yamlContent);
    spinner.succeed(`Config generated: ${configPath}`);
    config = loadConfig(configPath);
    justCreated = true;
  }

  const resolved = await deps.resolveProjectByRepo(config, parsed);
  return {
    config: resolved.config,
    projectId: resolved.projectId,
    project: resolved.project,
    source: "url",
    justCreated,
    parsed,
  };
}

async function fromPath(arg: string, deps: ResolveDeps, opts: ResolveOptions): Promise<Resolved> {
  const resolvedPath = resolve(arg.replace(/^~/, process.env["HOME"] || ""));

  // When a daemon is already running, register against the global config
  // (the daemon's source of truth) instead of whatever cwd-local config
  // findConfigFile() walks up to. addProjectToConfig is canonical-global-
  // aware, so handing it a config loaded from the global path routes the
  // write through registerProjectInGlobalConfig.
  if (opts.targetGlobalRegistry) {
    const globalPath = getGlobalConfigPath();
    const globalConfig = existsSync(globalPath) ? loadConfig(globalPath) : loadConfig();
    // Canonicalize via realpathSync so symlinked paths (e.g. macOS
    // /tmp -> /private/tmp) match an entry stored under the resolved
    // target. Without this, `ao start /tmp/foo` against a daemon whose
    // global config has /private/tmp/foo would fail to dedupe and
    // double-register the project.
    const canonicalTarget = canonicalize(resolvedPath);
    const existingEntry = Object.entries(globalConfig.projects).find(([, p]) => {
      const expanded = resolve(p.path.replace(/^~/, process.env["HOME"] || ""));
      return canonicalize(expanded) === canonicalTarget;
    });
    if (existingEntry) {
      return {
        config: globalConfig,
        projectId: existingEntry[0],
        project: existingEntry[1],
        source: "path",
        justCreated: false,
      };
    }
    const addedId = await deps.addProjectToConfig(globalConfig, resolvedPath);
    const reloaded = loadConfig(globalConfig.configPath);
    const project = reloaded.projects[addedId];
    if (!project) {
      throw new Error(
        `Failed to register "${addedId}" in the global config — aborting.`,
      );
    }
    return {
      config: reloaded,
      projectId: addedId,
      project,
      source: "path",
      justCreated: true,
    };
  }

  let configPath: string | undefined;
  try {
    configPath = findConfigFile() ?? undefined;
  } catch {
    // No config — fall through to autoCreate.
  }

  if (!configPath) {
    // No config anywhere — auto-create at the target path (or cwd if they match).
    const targetDir = resolve(cwd()) === resolvedPath ? cwd() : resolvedPath;
    const config = await deps.autoCreateConfig(targetDir);
    const resolved = await deps.resolveProject(config);
    return {
      config: resolved.config,
      projectId: resolved.projectId,
      project: resolved.project,
      source: "path",
      justCreated: true,
    };
  }

  // Config exists — check if the path is already registered.
  const config = loadConfig(configPath);
  const existingEntry = Object.entries(config.projects).find(
    ([, p]) => resolve(p.path.replace(/^~/, process.env["HOME"] || "")) === resolvedPath,
  );

  if (existingEntry) {
    return {
      config,
      projectId: existingEntry[0],
      project: existingEntry[1],
      source: "path",
      justCreated: false,
    };
  }

  // Path is new — register it.
  const addedId = await deps.addProjectToConfig(config, resolvedPath);
  const reloaded = loadConfig(config.configPath);
  return {
    config: reloaded,
    projectId: addedId,
    project: reloaded.projects[addedId],
    source: "path",
    justCreated: true,
  };
}

async function fromCwdOrId(
  arg: string | undefined,
  deps: ResolveDeps,
  opts: ResolveOptions,
): Promise<Resolved> {
  // Daemon-running + project id: the global registry is the source of
  // truth for project identity, so look there directly. Skipping the cwd-
  // local loadConfig() also avoids first-run autoCreate prompts when the
  // user just wants to attach to a known project.
  if (opts.targetGlobalRegistry && arg) {
    const globalPath = getGlobalConfigPath();
    const config = existsSync(globalPath) ? loadConfig(globalPath) : loadConfig();
    const project = config.projects[arg];
    if (!project) {
      throw new Error(
        `Project "${arg}" is not registered in the global config (${config.configPath}).\n` +
          `  Run \`ao project add\` or \`ao start <path|url>\` first.`,
      );
    }
    return {
      config,
      projectId: arg,
      project,
      source: "existing-id",
      justCreated: false,
    };
  }

  let config: OrchestratorConfig;
  let recovered = false;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      // First run — auto-create config in cwd.
      config = await deps.autoCreateConfig(cwd());
      recovered = true;
    } else {
      // A config file exists but failed to load — likely a flat local
      // config whose project isn't in the global registry yet. Recover
      // by registering it, then retry the load.
      const foundConfig = findConfigFile() ?? undefined;
      if (!foundConfig) throw err;
      const addedId = await deps.registerFlatConfig(foundConfig);
      if (!addedId) throw err;
      config = loadConfig(foundConfig);
      recovered = true;
    }
  }

  // If the user named a project that isn't in the local config, fall back
  // to the global registry (which has all registered projects).
  if (arg && !config.projects[arg]) {
    const globalPath = getGlobalConfigPath();
    if (existsSync(globalPath)) {
      config = loadConfig(globalPath);
    }
  }

  const resolved = await deps.resolveProject(config, arg);
  return {
    config: resolved.config,
    projectId: resolved.projectId,
    project: resolved.project,
    source: arg ? "existing-id" : "cwd",
    justCreated: recovered,
  };
}

/**
 * Resolve (and create if necessary) the project a given `ao start [arg]`
 * invocation refers to.
 *
 * Dispatches by arg shape:
 * - `arg` is a URL → clone (or reuse), load/generate config, match by repo
 * - `arg` is a local path → load existing or addProject or autoCreate
 * - `arg` is a project id → load config, fall back to global if needed
 * - `arg` is undefined → load cwd config, autoCreate on first run, register
 *   flat configs that exist but aren't globally known
 *
 * The same `Resolved` shape comes back regardless of source; callers use
 * `source` and `justCreated` for hints (e.g. dashboard cache invalidation).
 *
 * Pass `opts.targetGlobalRegistry: true` when an `ao` daemon is already
 * running so URL/path args register the project in the global config the
 * daemon supervises rather than into a fresh cwd-local one.
 */
export async function resolveOrCreateProject(
  arg: string | undefined,
  deps: ResolveDeps,
  opts: ResolveOptions = {},
): Promise<Resolved> {
  if (arg && isRepoUrl(arg)) return fromUrl(arg, deps, opts);
  if (arg && isLocalPath(arg)) return fromPath(arg, deps, opts);
  return fromCwdOrId(arg, deps, opts);
}
