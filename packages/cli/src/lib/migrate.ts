import type { ProjectConfig } from "@aoagents/ao-core";
import type { ProjectRow } from "./migrate-db.js";

/**
 * `ao migrate` — pure project mappers (#2129).
 *
 * Maps the legacy flat-file project registry + per-project settings into the
 * rewrite (Go/Electron) daemon's SQLite `projects` table. Unlike the closed
 * draft #2127 (which POSTed to a loopback REST API), migrate now writes the DB
 * directly while the daemon is stopped (see migrate-db.ts), so this module is
 * the pure field-mapping half only — no network, no I/O.
 *
 * Cross-repo contract verified against aoagents/ReverbCode @ 43ae7eb:
 *   - domain/{projectconfig,agentconfig,harness}.go (config JSON shape + enums)
 *   - service/project/service.go (validateProjectID)
 * Mapping spec: aoagents/ReverbCode#247 §1 + §3.
 */

// ---------------------------------------------------------------------------
// Rewrite vocabulary (domain enums, mirrored as literals so core stays free of
// any rewrite dependency)
// ---------------------------------------------------------------------------

/** `domain.PermissionMode` (agentconfig.go). `""` (unset) is also valid. */
export type RewritePermissionMode = "default" | "accept-edits" | "auto" | "bypass-permissions";

/** `domain.AgentHarness` (harness.go) — the set the rewrite `RoleOverride.agent` accepts. */
const KNOWN_REWRITE_HARNESSES = new Set<string>([
  "claude-code",
  "codex",
  "aider",
  "opencode",
  "grok",
  "droid",
  "amp",
  "agy",
  "crush",
  "cursor",
  "qwen",
  "copilot",
  "goose",
  "auggie",
  "continue",
  "devin",
  "cline",
  "kimi",
  "kiro",
  "kilocode",
  "vibe",
  "pi",
  "autohand",
]);

// ---------------------------------------------------------------------------
// Field mapping (pure — fully unit tested)
// ---------------------------------------------------------------------------

/** Rewrite project-id gate (`validateProjectID`, service.go). */
const REWRITE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidRewriteProjectId(id: string): boolean {
  return (
    id.length > 0 &&
    id !== "." &&
    !id.includes("..") &&
    !/[/\\]/.test(id) &&
    REWRITE_PROJECT_ID.test(id)
  );
}

/**
 * Legacy `AgentPermissionMode` → rewrite `PermissionMode` (#247 §3 table).
 * `lossy` flags a remap that drops a distinction the rewrite cannot represent.
 *
 * Note: legacy `skip` is already collapsed to `permissionless` by the config
 * schema, but a hand-edited config could still carry the raw value, so we map
 * it explicitly.
 */
export function mapPermission(legacy: string | undefined): {
  mode: RewritePermissionMode;
  lossy: boolean;
} | null {
  switch (legacy) {
    case undefined:
    case "":
      return null;
    case "permissionless":
    case "skip":
      return { mode: "bypass-permissions", lossy: false };
    case "auto-edit":
      return { mode: "accept-edits", lossy: false };
    case "default":
      return { mode: "default", lossy: false };
    case "suggest":
      // The rewrite has no suggest/plan mode (#247 G8).
      return { mode: "default", lossy: true };
    default:
      return { mode: "default", lossy: true };
  }
}

/** Legacy agent plugin id → rewrite harness, or null if the rewrite has no such harness. */
export function mapHarness(agent: string | undefined): string | null {
  if (!agent) return null;
  return KNOWN_REWRITE_HARNESSES.has(agent) ? agent : null;
}

/** Rewrite `domain.AgentConfig` JSON shape. */
interface RewriteAgentConfig {
  model?: string;
  permissions?: RewritePermissionMode;
}

/** Rewrite `domain.RoleOverride` JSON shape (note: harness key is `agent`). */
interface RewriteRoleOverride {
  agent?: string;
  agentConfig?: RewriteAgentConfig;
}

/** Rewrite `domain.ProjectConfig` JSON shape (the `config` column). */
export interface RewriteProjectConfig {
  defaultBranch?: string;
  sessionPrefix?: string;
  env?: Record<string, string>;
  symlinks?: string[];
  postCreate?: string[];
  agentConfig?: RewriteAgentConfig;
  worker?: RewriteRoleOverride;
  orchestrator?: RewriteRoleOverride;
}

function buildAgentConfig(
  source: { model?: string; permissions?: string } | undefined,
  notes: string[],
  label: string,
): RewriteAgentConfig | undefined {
  if (!source) return undefined;
  const out: RewriteAgentConfig = {};
  if (typeof source.model === "string" && source.model.length > 0) out.model = source.model;
  const perm = mapPermission(source.permissions);
  if (perm) {
    out.permissions = perm.mode;
    if (perm.lossy) {
      notes.push(`${label} permission "${source.permissions}" mapped lossily to "${perm.mode}"`);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildRoleOverride(
  role: { agent?: string; agentConfig?: { model?: string; permissions?: string } } | undefined,
  notes: string[],
  label: string,
): RewriteRoleOverride | undefined {
  if (!role) return undefined;
  const out: RewriteRoleOverride = {};
  if (role.agent) {
    const harness = mapHarness(role.agent);
    if (harness) {
      out.agent = harness;
    } else {
      notes.push(`${label} agent "${role.agent}" has no rewrite harness — dropped`);
    }
  }
  const agentConfig = buildAgentConfig(role.agentConfig, notes, `${label} agent`);
  if (agentConfig) out.agentConfig = agentConfig;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Build the rewrite `config` blob from a legacy effective ProjectConfig (#247 §3).
 * Returns null when nothing worth persisting remains (the rewrite stores NULL
 * for a zero config). `notes` accumulates lossy/dropped-field warnings.
 */
export function buildRewriteConfig(pc: ProjectConfig, notes: string[]): RewriteProjectConfig | null {
  const config: RewriteProjectConfig = {};

  // defaultBranch: omit "main" so the common case keeps config NULL (#247 §3).
  if (typeof pc.defaultBranch === "string" && pc.defaultBranch && pc.defaultBranch !== "main") {
    config.defaultBranch = pc.defaultBranch;
  }
  if (typeof pc.sessionPrefix === "string" && pc.sessionPrefix.length > 0) {
    config.sessionPrefix = pc.sessionPrefix;
  }
  if (pc.env && Object.keys(pc.env).length > 0) {
    config.env = { ...pc.env };
  }
  if (Array.isArray(pc.symlinks) && pc.symlinks.length > 0) {
    config.symlinks = [...pc.symlinks];
  }
  if (Array.isArray(pc.postCreate) && pc.postCreate.length > 0) {
    config.postCreate = [...pc.postCreate];
  }

  const agentConfig = buildAgentConfig(pc.agentConfig, notes, "agentConfig");
  if (agentConfig) config.agentConfig = agentConfig;

  const worker = buildRoleOverride(pc.worker, notes, "worker");
  if (worker) config.worker = worker;

  const orchestrator = buildRoleOverride(pc.orchestrator, notes, "orchestrator");
  if (orchestrator) config.orchestrator = orchestrator;

  // Surface project-level fields the rewrite has no home for (#247 §4).
  const dropped: string[] = [];
  if (pc.tracker) dropped.push("tracker");
  if (pc.scm) dropped.push("scm");
  if (pc.agentRules || pc.agentRulesFile || pc.orchestratorRules) dropped.push("rules");
  if (pc.runtime) dropped.push("runtime");
  if (pc.workspace) dropped.push("workspace");
  if (pc.reactions && Object.keys(pc.reactions).length > 0) dropped.push("reactions");
  if (dropped.length > 0) {
    notes.push(`project-level fields with no rewrite home dropped: ${dropped.join(", ")}`);
  }

  return Object.keys(config).length > 0 ? config : null;
}

// ---------------------------------------------------------------------------
// Per-project plan
// ---------------------------------------------------------------------------

/** The legacy identity we carry into the `projects` row. */
export interface ProjectAddInput {
  path: string;
  projectId?: string;
  name?: string;
}

export interface ProjectPlan {
  id: string;
  add: ProjectAddInput;
  config: RewriteProjectConfig | null;
  notes: string[];
}

/** Build the full create+config plan for one legacy project. Pure. */
export function buildProjectPlan(id: string, pc: ProjectConfig): ProjectPlan {
  const notes: string[] = [];
  const add: ProjectAddInput = { path: pc.path, projectId: id };
  // displayName falls back to id on the rewrite read side; only send a real name.
  if (typeof pc.name === "string" && pc.name.length > 0 && pc.name !== id) {
    add.name = pc.name;
  }
  const config = buildRewriteConfig(pc, notes);
  return { id, add, config, notes };
}

// ---------------------------------------------------------------------------
// Project DB row (server-side fields migrate now computes itself — §7)
// ---------------------------------------------------------------------------

/**
 * Environment-dependent inputs for a project row, injected so the row builder
 * stays pure (no child_process / fs of its own).
 */
export interface ProjectRowDeps {
  /** `git -C <path> remote get-url origin` trimmed, `''` on any failure. */
  repoOriginUrl: (path: string) => string;
  /** registered.json `addedAt` (ISO) for this project, or null if unregistered. */
  registeredAt: (id: string, path: string) => string | null;
  /** Project config file mtime (ISO), or null if it cannot be stat'd. */
  configFileMtime: (path: string) => string | null;
  /** Fallback "now" ISO timestamp (last resort for registered_at). */
  now: string;
}

/**
 * Build the rewrite `projects` row for one legacy project (§7). The rewrite no
 * longer fills the server-side fields (we write SQL directly), so migrate
 * computes them: repo_origin_url, registered_at, kind, display_name, config.
 */
export function buildProjectRow(
  id: string,
  pc: ProjectConfig,
  deps: ProjectRowDeps,
): { row: ProjectRow; notes: string[] } {
  const notes: string[] = [];
  const config = buildRewriteConfig(pc, notes);

  // display_name: the rewrite falls back to id on read, so only persist a real name.
  const displayName =
    typeof pc.name === "string" && pc.name.length > 0 && pc.name !== id ? pc.name : "";

  const registeredAt =
    deps.registeredAt(id, pc.path) ?? deps.configFileMtime(pc.path) ?? deps.now;

  const row: ProjectRow = {
    id,
    path: pc.path,
    repo_origin_url: deps.repoOriginUrl(pc.path),
    display_name: displayName,
    registered_at: registeredAt,
    kind: "single_repo",
    config: config ? JSON.stringify(config) : null,
  };
  return { row, notes };
}
