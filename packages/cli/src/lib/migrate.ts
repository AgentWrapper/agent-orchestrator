import {
  getGlobalConfigPath,
  loadConfig,
  type LoadedConfig,
  type ProjectConfig,
} from "@aoagents/ao-core";

/**
 * `ao migrate` — port the legacy flat-file project registry + per-project
 * settings into the rewrite (Go/Electron) daemon's SQLite store.
 *
 * Scope (deliberately narrow for this first cut): PROJECTS and their SETTINGS
 * only. Sessions, PRs, notifiers, and global config are NOT migrated here.
 *
 * Write path: the rewrite daemon is the SOLE writer of `~/.ao/data/ao.db`
 * (the CLI/doctor are forbidden from opening it). So we never touch the DB —
 * we mirror the rewrite's own `ao project add` flow over its loopback REST API:
 *
 *   POST /api/v1/projects                  { path, projectId?, name? }
 *   PUT  /api/v1/projects/{id}/config      { config }
 *
 * Cross-repo contract verified against aoagents/ReverbCode:
 *   - controllers/projects.go (routes, DisallowUnknownFields on the body)
 *   - service/project/{dto,service}.go (AddInput, server-set repo_origin_url /
 *     registered_at / kind, 409 on duplicate id/path, 400 on non-git path)
 *   - domain/{projectconfig,agentconfig,harness}.go (config JSON shape + enums)
 *
 * Mapping is spec'd by aoagents/ReverbCode#247 §1 + §3.
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

/** Default bind of the rewrite daemon: loopback-only, port 3001 (config.go). */
export const DEFAULT_DAEMON_URL = "http://127.0.0.1:3001";

/**
 * Resolve the rewrite daemon base URL. Precedence: explicit flag → AO_DAEMON_URL
 * → AO_PORT (loopback) → the rewrite's hardcoded default.
 */
export function resolveDaemonUrl(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return stripTrailingSlash(explicit.trim());
  const url = process.env.AO_DAEMON_URL;
  if (url && url.trim().length > 0) return stripTrailingSlash(url.trim());
  const port = process.env.AO_PORT;
  if (port && /^\d+$/.test(port.trim())) return `http://127.0.0.1:${port.trim()}`;
  return DEFAULT_DAEMON_URL;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

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

/** Rewrite `POST /api/v1/projects` body (`service.AddInput`). */
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
// HTTP execution
// ---------------------------------------------------------------------------

export class DaemonUnreachableError extends Error {
  constructor(
    readonly daemonUrl: string,
    cause?: unknown,
  ) {
    super(`Could not reach the AO daemon at ${daemonUrl}`, { cause });
    this.name = "DaemonUnreachableError";
  }
}

type FetchLike = typeof fetch;

export type ProjectOutcome =
  | "created"
  | "skipped-conflict"
  | "skipped-degraded"
  | "skipped-invalid-id"
  | "error"
  | "planned";

export interface MigrateProjectResult {
  id: string;
  path: string;
  outcome: ProjectOutcome;
  configApplied: boolean;
  notes: string[];
  error?: string;
}

export interface MigrateSummary {
  daemonUrl: string;
  dryRun: boolean;
  results: MigrateProjectResult[];
}

export interface MigrateOptions {
  daemonUrl: string;
  dryRun: boolean;
  /** Override the config source (tests). Defaults to the global config. */
  config?: LoadedConfig;
  /** Override fetch (tests). */
  fetchImpl?: FetchLike;
}

interface ApiResult {
  status: number;
  body: string;
}

async function apiRequest(
  fetchImpl: FetchLike,
  daemonUrl: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<ApiResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${daemonUrl}${path}`, {
      method,
      // No `Origin` header — the daemon's CORS gate lets origin-less (CLI)
      // requests through; a browser origin would be rejected.
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new DaemonUnreachableError(daemonUrl, err);
  }
  return { status: res.status, body: await res.text() };
}

/** Pull a stable error code out of the rewrite's JSON error envelope, best-effort. */
function describeApiError(result: ApiResult): string {
  try {
    const parsed = JSON.parse(result.body) as { error?: { code?: string; message?: string } };
    const code = parsed.error?.code;
    const message = parsed.error?.message;
    if (code || message) return [code, message].filter(Boolean).join(": ");
  } catch {
    // not JSON — fall through
  }
  return result.body.trim().slice(0, 200) || `HTTP ${result.status}`;
}

/**
 * Run the projects+settings migration. Reads the legacy global config, then
 * for each registered project POSTs the create and PUTs the config blob.
 *
 * Idempotent: a project whose id/path is already registered comes back 409 and
 * is reported as skipped (re-running is safe).
 */
export async function runMigrate(opts: MigrateOptions): Promise<MigrateSummary> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const config = opts.config ?? loadConfig(getGlobalConfigPath());
  const results: MigrateProjectResult[] = [];

  // Projects whose local config failed to resolve — cannot map faithfully.
  for (const [id, entry] of Object.entries(config.degradedProjects)) {
    results.push({
      id,
      path: entry.path,
      outcome: "skipped-degraded",
      configApplied: false,
      notes: [`local config could not be resolved: ${entry.resolveError}`],
    });
  }

  const ids = Object.keys(config.projects);

  // Fail fast if the daemon is down (skip the probe on dry runs — they never hit it).
  if (!opts.dryRun && ids.length > 0) {
    await apiRequest(fetchImpl, opts.daemonUrl, "GET", "/api/v1/projects");
  }

  for (const id of ids) {
    const pc = config.projects[id]!;
    const plan = buildProjectPlan(id, pc);

    if (!isValidRewriteProjectId(id)) {
      results.push({
        id,
        path: pc.path,
        outcome: "skipped-invalid-id",
        configApplied: false,
        notes: [...plan.notes, "project id fails rewrite validation — rename before migrating"],
      });
      continue;
    }

    if (opts.dryRun) {
      results.push({
        id,
        path: pc.path,
        outcome: "planned",
        configApplied: plan.config !== null,
        notes: plan.notes,
      });
      continue;
    }

    const result = await migrateOneProject(fetchImpl, opts.daemonUrl, plan, pc.path);
    results.push(result);
  }

  return { daemonUrl: opts.daemonUrl, dryRun: opts.dryRun, results };
}

async function migrateOneProject(
  fetchImpl: FetchLike,
  daemonUrl: string,
  plan: ProjectPlan,
  path: string,
): Promise<MigrateProjectResult> {
  const notes = [...plan.notes];

  const addRes = await apiRequest(fetchImpl, daemonUrl, "POST", "/api/v1/projects", plan.add);
  if (addRes.status === 409) {
    return {
      id: plan.id,
      path,
      outcome: "skipped-conflict",
      configApplied: false,
      notes: [...notes, "already registered in the new system — skipped"],
    };
  }
  if (addRes.status !== 201) {
    return {
      id: plan.id,
      path,
      outcome: "error",
      configApplied: false,
      notes,
      error: describeApiError(addRes),
    };
  }

  let configApplied = false;
  if (plan.config) {
    const cfgRes = await apiRequest(
      fetchImpl,
      daemonUrl,
      "PUT",
      `/api/v1/projects/${encodeURIComponent(plan.id)}/config`,
      { config: plan.config },
    );
    if (cfgRes.status >= 200 && cfgRes.status < 300) {
      configApplied = true;
    } else {
      // The project was created; only the config write failed. Keep the
      // project, surface the config error.
      notes.push(`project created but config write failed: ${describeApiError(cfgRes)}`);
    }
  }

  return { id: plan.id, path, outcome: "created", configApplied, notes };
}
