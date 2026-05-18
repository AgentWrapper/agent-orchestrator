import { readFile, unlink, writeFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  ArtifactSchema,
  ARTIFACT_RESERVED_PREFIX,
  ARTIFACT_MAX_PER_SESSION,
  type Artifact,
} from "./artifact-schema.js";
import {
  writeCanonicalArtifact,
  readCanonicalArtifactIfExists,
  deleteCanonicalArtifact,
} from "./artifact-store.js";
import { getSessionArtifactsDir } from "./paths.js";

/**
 * Result of ingesting one staging file. The watcher acts on this — e.g. emit
 * a Mux artifact-update event on "ingested", artifact-error on "error".
 */
export type IngestResult =
  | { kind: "ingested"; artifact: Artifact; previous?: Artifact | null }
  | {
      kind: "error";
      artifactId: string;
      issues: { path: string[]; message: string }[];
    };

/**
 * Ingest a single staging file. Called by the chokidar watcher on 'add' /
 * 'change' events.
 *
 * Pipeline:
 *   1. Read JSON, derive id from filename (must match payload.id)
 *   2. Validate against the schema (ignoring agent-supplied version /
 *      createdAt / updatedAt / source — those are stamped by us)
 *   3. Reject core-* ids (reserved for synthesized artifacts)
 *   4. Stamp server-side metadata: version=1, createdAt (new) or preserve
 *      (update), updatedAt=now, source="agent"
 *   5. Atomic move (write canonical, then unlink staging)
 *   6. Evict oldest canonical if count > ARTIFACT_MAX_PER_SESSION
 *
 * On validation failure: write `.error` sidecar next to the staging file.
 * Returns the result so the watcher can emit appropriate Mux events.
 */
export async function ingestStagingFile(
  stagingPath: string,
  projectId: string,
  sessionId: string,
): Promise<IngestResult> {
  const fileName = basename(stagingPath);
  const idFromFile = fileName.replace(/\.json$/, "");

  let raw: string;
  try {
    raw = await readFile(stagingPath, "utf-8");
  } catch {
    return {
      kind: "error",
      artifactId: idFromFile,
      issues: [{ path: [], message: "read_failed" }],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await writeErrorSidecar(stagingPath, [{ path: [], message: "invalid_json" }]);
    return {
      kind: "error",
      artifactId: idFromFile,
      issues: [{ path: [], message: "invalid_json" }],
    };
  }

  // Reject core-* prefix at ingest (schema doesn't enforce this)
  const agentSuppliedId = (parsed as { id?: unknown }).id;
  if (
    typeof agentSuppliedId === "string" &&
    agentSuppliedId.startsWith(ARTIFACT_RESERVED_PREFIX)
  ) {
    const issue = {
      path: ["id"],
      message: `id prefix "${ARTIFACT_RESERVED_PREFIX}" is reserved for artifacts synthesized by core`,
    };
    await writeErrorSidecar(stagingPath, [issue]);
    return { kind: "error", artifactId: idFromFile, issues: [issue] };
  }

  // Build a candidate Artifact, stamping server-controlled fields.
  // Read existing canonical to preserve createdAt across updates.
  const previous =
    (await readCanonicalArtifactIfExists(projectId, sessionId, idFromFile)) ?? null;
  const now = new Date().toISOString();

  const candidate = {
    ...(parsed as Record<string, unknown>),
    version: 1,
    id: typeof agentSuppliedId === "string" ? agentSuppliedId : idFromFile,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    source: "agent",
  };

  const result = ArtifactSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.map(String),
      message: i.message,
    }));
    await writeErrorSidecar(stagingPath, issues);
    return { kind: "error", artifactId: idFromFile, issues };
  }

  // Persist
  try {
    await writeCanonicalArtifact(projectId, sessionId, result.data);
  } catch (err) {
    const issues = [
      { path: [], message: `write_failed: ${(err as Error).message}` },
    ];
    await writeErrorSidecar(stagingPath, issues);
    return { kind: "error", artifactId: idFromFile, issues };
  }

  // Remove staging file + any prior .error sidecar
  try {
    await unlink(stagingPath);
  } catch {
    /* ignore */
  }
  const errorSidecar = stagingPath.replace(/\.json$/, ".error");
  try {
    await unlink(errorSidecar);
  } catch {
    /* ignore: no prior error */
  }

  // Evict oldest canonical beyond cap (excluding core-*)
  await evictOldestIfOverCap(projectId, sessionId);

  return { kind: "ingested", artifact: result.data, previous };
}

async function writeErrorSidecar(
  stagingPath: string,
  issues: { path: string[]; message: string }[],
): Promise<void> {
  const errorPath = stagingPath.replace(/\.json$/, ".error");
  const body = JSON.stringify({ issues, at: new Date().toISOString() }, null, 2);
  try {
    await writeFile(errorPath, body, "utf-8");
  } catch {
    /* sidecar write best-effort */
  }
}

async function evictOldestIfOverCap(
  projectId: string,
  sessionId: string,
): Promise<void> {
  const dir = getSessionArtifactsDir(projectId, sessionId);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  // Build (id, updatedAt) tuples for non-core canonical files only.
  const candidates: { id: string; updatedAt: string }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    if (entry.startsWith(".")) continue;
    const id = entry.replace(/\.json$/, "");
    if (id.startsWith(ARTIFACT_RESERVED_PREFIX)) continue; // never evict synthesized
    const raw = await safeRead(join(dir, entry));
    if (!raw) continue;
    let parsed: { updatedAt?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed.updatedAt === "string") {
      candidates.push({ id, updatedAt: parsed.updatedAt });
    }
  }

  if (candidates.length <= ARTIFACT_MAX_PER_SESSION) return;

  candidates.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1)); // oldest first
  const toEvict = candidates.length - ARTIFACT_MAX_PER_SESSION;
  for (let i = 0; i < toEvict; i++) {
    await deleteCanonicalArtifact(projectId, sessionId, candidates[i]!.id);
  }
}

async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}
