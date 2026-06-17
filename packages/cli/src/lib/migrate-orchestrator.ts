/**
 * `ao migrate` — orchestrator session mapping (#2129, §8).
 *
 * Reads a project's single non-terminated orchestrator metadata record and maps
 * it to one rewrite `sessions` row. Workers are NOT migrated (they respawn fresh
 * in the rewrite). The row id is the verbatim `{prefix}-orchestrator` with
 * `num = 0` — the rewrite finds its orchestrator by `kind`, never by recomputing
 * the id, and `NextSessionNum` (MAX(num)+1) leaves the first rewrite-spawned
 * worker at num=1 with no UNIQUE(project_id,num) collision (§8.2).
 *
 * The pure mapper (`mapOrchestratorRow`) is fully unit-tested; the reader
 * (`readOrchestratorMapping`) globs the legacy sessions dir and feeds the mapper.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProjectConfig } from "@aoagents/ao-core";
import { getOrchestratorPath, getProjectSessionsDir } from "@aoagents/ao-core";
import type { SessionRow } from "./migrate-db.js";

/** Harnesses whose orchestrator we migrate. aider (and anything else) is skipped. */
const MIGRATABLE_HARNESSES = new Set(["claude-code", "codex", "opencode"]);

/** Legacy canonical states that mean "do not migrate" (§8.1 step 5). */
const TERMINAL_STATES = new Set(["done", "terminated"]);

/** Inputs needed to relocate a claude-code transcript (§9). */
export interface TranscriptRelocation {
  /** Legacy worktree path on disk (realpath-resolved by the relocator). */
  worktree: string;
  /** Claude session UUID = the transcript filename stem. */
  uuid: string;
}

export type OrchestratorMappingStatus = "mapped" | "skipped" | "absent";

export interface OrchestratorMapping {
  projectId: string;
  prefix: string;
  status: OrchestratorMappingStatus;
  /** Present when status === "mapped". */
  row?: SessionRow;
  /** Present only for a mapped claude-code orchestrator that carries a transcript uuid. */
  transcript?: TranscriptRelocation;
  /** Skip reason or a lossy note, surfaced in the summary. */
  note?: string;
}

/** Coerce a value that may be an object OR a JSON-encoded string into an object. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface LegacyLifecycle {
  session?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
}

/**
 * Extract the lifecycle, double-decoding stringified nested fields. Prefers the
 * V2 `lifecycle` key, falling back to `statePayload` when `stateVersion === "2"`
 * (mirrors parseLifecycleField in packages/core/src/metadata.ts).
 */
function extractLifecycle(raw: Record<string, unknown>): LegacyLifecycle | undefined {
  let lifecycle = asObject(raw["lifecycle"]);
  if (!lifecycle && raw["stateVersion"] === "2") {
    lifecycle = asObject(raw["statePayload"]);
  }
  if (!lifecycle) return undefined;
  return {
    session: asObject(lifecycle["session"]),
    runtime: asObject(lifecycle["runtime"]),
  };
}

/** Legacy 8-state enum → rewrite 5-state activity_state (§8.2). */
function mapActivityState(state: string | undefined): SessionRow["activity_state"] {
  switch (state) {
    case "working":
      return "active";
    case "needs_input":
      return "waiting_input";
    // not_started / idle / detecting / stuck (and any unknown) -> idle
    default:
      return "idle";
  }
}

/** Pick the rewrite `agent_session_id` for resume, by harness (§8.2). */
function resumeId(harness: string, raw: Record<string, unknown>): string {
  switch (harness) {
    case "claude-code":
      return asString(raw["claudeSessionUuid"]) ?? "";
    case "codex":
      return asString(raw["codexThreadId"]) ?? "";
    case "opencode":
      return asString(raw["opencodeSessionId"]) ?? "";
    default:
      return "";
  }
}

/**
 * Map a parsed legacy orchestrator record to a rewrite session row. Pure.
 *
 * `fileMtime` is the last-resort ISO timestamp for `created_at` when the record
 * carries neither `createdAt` nor `lifecycle.session.startedAt`.
 */
export function mapOrchestratorRow(
  raw: Record<string, unknown>,
  projectId: string,
  prefix: string,
  fileMtime: string,
): OrchestratorMapping {
  const base: Pick<OrchestratorMapping, "projectId" | "prefix"> = { projectId, prefix };

  const lifecycle = extractLifecycle(raw);
  const session = lifecycle?.session;
  const state = asString(session?.["state"]);
  const terminatedAt = session?.["terminatedAt"];

  // §8.1 step 5: migrate ONLY non-terminal, non-terminated orchestrators.
  if ((state && TERMINAL_STATES.has(state)) || (terminatedAt !== null && terminatedAt !== undefined)) {
    return { ...base, status: "skipped", note: `orchestrator is terminal (state=${state ?? "?"})` };
  }

  // §8.1 step 6: harness filter.
  const agent = asString(raw["agent"]);
  if (!agent || !MIGRATABLE_HARNESSES.has(agent)) {
    return {
      ...base,
      status: "skipped",
      note: `harness "${agent ?? "?"}" is not migratable (only claude-code, codex, opencode)`,
    };
  }

  const startedAt = asString(session?.["startedAt"]);
  const lastTransitionAt = asString(session?.["lastTransitionAt"]);
  const lastObservedAt = asString(lifecycle?.runtime?.["lastObservedAt"]);

  const createdAt = asString(raw["createdAt"]) ?? startedAt ?? fileMtime;
  const activityLastAt = lastTransitionAt ?? lastObservedAt ?? createdAt;
  const updatedAt = lastTransitionAt ?? createdAt;

  const id = `${prefix}-orchestrator`;
  const worktree = asString(raw["worktree"]) ?? "";
  const agentSessionId = resumeId(agent, raw);

  const row: SessionRow = {
    id,
    project_id: projectId,
    num: 0,
    kind: "orchestrator",
    harness: agent,
    activity_state: mapActivityState(state),
    activity_last_at: activityLastAt,
    is_terminated: 0,
    branch: asString(raw["branch"]) ?? "",
    workspace_path: worktree,
    runtime_handle_id: "",
    agent_session_id: agentSessionId,
    prompt: asString(raw["userPrompt"]) ?? "",
    display_name: asString(raw["displayName"]) ?? "",
    first_signal_at: activityLastAt,
    created_at: createdAt,
    updated_at: updatedAt,
  };

  // §9: claude-code orchestrators carry a transcript to relocate (needs both a
  // uuid and a worktree to compute source + destination slugs).
  let transcript: TranscriptRelocation | undefined;
  if (agent === "claude-code") {
    const uuid = asString(raw["claudeSessionUuid"]);
    if (uuid && worktree) transcript = { worktree, uuid };
  }

  return { ...base, status: "mapped", row, transcript };
}

/** Resolve the migration prefix: configured sessionPrefix, else first 12 chars of id (§8.1 step 1). */
export function resolveOrchestratorPrefix(projectId: string, pc: ProjectConfig): string {
  const configured = typeof pc.sessionPrefix === "string" ? pc.sessionPrefix.trim() : "";
  return configured.length > 0 ? configured : projectId.slice(0, 12);
}

/** Parse JSON; returns null on invalid content. */
function parseJsonRecord(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* corrupt */
  }
  return null;
}

/**
 * Locate the orchestrator metadata file for a project: the sessions-dir record
 * whose raw `role === "orchestrator"`, else the one named `{prefix}-orchestrator`,
 * else the legacy `projects/{id}/orchestrator.json`. Skips 0-byte and
 * `*.corrupt-*` files (§8.1 steps 2-3).
 */
function findOrchestratorFile(projectId: string, prefix: string): string | null {
  const sessionsDir = getProjectSessionsDir(projectId);
  let candidates: string[] = [];
  try {
    candidates = readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".json") && !f.includes(".corrupt-"))
      .map((f) => join(sessionsDir, f));
  } catch {
    /* sessions dir absent */
  }

  let byName: string | null = null;
  for (const file of candidates) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8").trim();
    } catch {
      continue;
    }
    if (!content) continue; // 0-byte / reserved id
    const raw = parseJsonRecord(content);
    if (!raw) continue;
    if (raw["role"] === "orchestrator") return file;
    if (basename(file, ".json") === `${prefix}-orchestrator`) byName = file;
  }
  if (byName) return byName;

  // Defensive: the pre-V2 standalone orchestrator file.
  const legacy = getOrchestratorPath(projectId);
  if (existsSync(legacy)) {
    try {
      if (readFileSync(legacy, "utf-8").trim()) return legacy;
    } catch {
      /* unreadable */
    }
  }
  return null;
}

/**
 * Read + map a project's orchestrator. Returns `absent` when there is no
 * orchestrator file to migrate, `skipped` for terminal/non-migratable ones, and
 * `mapped` with the row (and transcript for claude-code) otherwise.
 */
export function readOrchestratorMapping(projectId: string, pc: ProjectConfig): OrchestratorMapping {
  const prefix = resolveOrchestratorPrefix(projectId, pc);
  const file = findOrchestratorFile(projectId, prefix);
  if (!file) return { projectId, prefix, status: "absent" };

  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    return { projectId, prefix, status: "absent" };
  }
  const raw = parseJsonRecord(content.trim());
  if (!raw) return { projectId, prefix, status: "absent" };

  let mtime: string;
  try {
    mtime = statSync(file).mtime.toISOString();
  } catch {
    mtime = new Date(0).toISOString();
  }

  return mapOrchestratorRow(raw, projectId, prefix, mtime);
}
