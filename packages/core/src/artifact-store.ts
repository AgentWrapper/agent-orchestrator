import { mkdir, readdir, readFile, rename, lstat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  ArtifactSchema,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MAX_PER_SESSION,
  type Artifact,
} from "./artifact-schema.js";
import { getSessionArtifactsDir } from "./paths.js";

/**
 * Write an artifact to the canonical location atomically. Used by the ingest
 * pipeline (after stamping metadata from staged files).
 *
 * Atomicity: write to a tempfile in the same dir, then rename. POSIX rename
 * is atomic, so readers never see a half-written file. Random suffix on the
 * tempfile prevents collisions with concurrent writes to the same id.
 */
export async function writeCanonicalArtifact(
  projectId: string,
  sessionId: string,
  artifact: Artifact,
): Promise<void> {
  const dir = getSessionArtifactsDir(projectId, sessionId);
  const filePath = join(dir, `${artifact.id}.json`);

  const serialized = JSON.stringify(artifact);
  const byteSize = Buffer.byteLength(serialized, "utf-8");
  if (byteSize > ARTIFACT_MAX_BYTES) {
    throw new Error(`Artifact exceeds size cap: ${byteSize} > ${ARTIFACT_MAX_BYTES} bytes`);
  }

  await mkdir(dir, { recursive: true });

  const tmpPath = join(dir, `.${artifact.id}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmpPath, serialized, "utf-8");
    await rename(tmpPath, filePath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

/**
 * Read all artifacts for a session, sorted by updatedAt desc, capped at
 * ARTIFACT_MAX_PER_SESSION. Silently drops:
 *   - Files in .staging/ (and other dotfiles/dirs)
 *   - Non-regular files (symlinks, FIFOs) — caught by lstat
 *   - Files exceeding ARTIFACT_MAX_BYTES
 *   - Files with corrupt JSON
 *   - Files failing schema validation
 *
 * Logs warnings for unexpected drops; never throws on a single bad file.
 */
export async function readArtifacts(
  projectId: string,
  sessionId: string,
): Promise<Artifact[]> {
  const dir = getSessionArtifactsDir(projectId, sessionId);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const artifacts: Artifact[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    if (entry.startsWith(".")) continue; // skip dotfiles (including tempfiles)

    const filePath = join(dir, entry);
    const artifact = await tryReadArtifact(filePath);
    if (artifact) artifacts.push(artifact);
  }

  artifacts.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return artifacts.slice(0, ARTIFACT_MAX_PER_SESSION);
}

/** Read a specific artifact by id, returns null on any failure. */
export async function readCanonicalArtifactIfExists(
  projectId: string,
  sessionId: string,
  artifactId: string,
): Promise<Artifact | null> {
  const dir = getSessionArtifactsDir(projectId, sessionId);
  const filePath = join(dir, `${artifactId}.json`);
  return tryReadArtifact(filePath);
}

/**
 * Delete an artifact file. Used by:
 *   - Eviction (oldest by updatedAt when count > ARTIFACT_MAX_PER_SESSION)
 *   - Tests
 *
 * Returns true if a file was removed, false if it didn't exist.
 */
export async function deleteCanonicalArtifact(
  projectId: string,
  sessionId: string,
  artifactId: string,
): Promise<boolean> {
  const filePath = join(getSessionArtifactsDir(projectId, sessionId), `${artifactId}.json`);
  try {
    await unlink(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function tryReadArtifact(filePath: string): Promise<Artifact | null> {
  let st;
  try {
    st = await lstat(filePath); // lstat — never follow symlinks
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  if (st.size > ARTIFACT_MAX_BYTES) return null;

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = ArtifactSchema.safeParse(parsed);
  if (!result.success) return null;

  return result.data;
}

// Re-export for convenience.
export { ARTIFACT_MAX_PER_SESSION, ARTIFACT_MAX_BYTES };
