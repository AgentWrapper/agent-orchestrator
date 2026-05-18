import chokidar from "chokidar";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ingestStagingFile } from "./artifact-ingest.js";
import { readCanonicalArtifactIfExists } from "./artifact-store.js";
import type { Artifact } from "./artifact-schema.js";

/**
 * Events emitted by the artifact watcher. Consumers (web dashboard) translate
 * these into Mux WebSocket events.
 */
export type ArtifactEvent =
  | { type: "artifact-update"; sessionId: string; artifact: Artifact }
  | {
      type: "artifact-error";
      sessionId: string;
      artifactId: string;
      errors: { path: string[]; message: string }[];
    }
  | { type: "artifact-delete"; sessionId: string; artifactId: string };

export interface ArtifactWatcherOptions {
  /** Callback for each artifact event. */
  onEvent: (event: ArtifactEvent) => void;
  /** Override the AO base directory (for tests). Defaults to ~/.agent-orchestrator. */
  baseDir?: string;
}

export interface ArtifactWatcher {
  stop(): Promise<void>;
}

/**
 * Start watching all session staging directories for artifact JSON files.
 *
 * Watches `~/.agent-orchestrator/projects/` recursively. Events are filtered
 * by `parseStagingPath` / `parseCanonicalPath` to identify artifacts.
 *
 *   - staging path: `projects/{projectId}/artifacts/{sessionId}/.staging/{id}.json`
 *   - canonical path: `projects/{projectId}/artifacts/{sessionId}/{id}.json`
 *
 * On add/change of a staging file: extract projectId and sessionId from the
 * path, call `ingestStagingFile`, emit the result as a `artifact-update` or
 * `artifact-error` event.
 *
 * On unlink of a canonical file: emit `artifact-delete` (used by eviction
 * signals).
 *
 * Watching a stable root directory (rather than glob patterns) is more
 * reliable than chokidar globs on macOS FSEvents when deeply-nested path
 * segments don't exist at startup.
 */
export async function startArtifactWatcher(
  options: ArtifactWatcherOptions,
): Promise<ArtifactWatcher> {
  const baseDir = options.baseDir ?? join(homedir(), ".agent-orchestrator");
  const projectsDir = join(baseDir, "projects");

  // Ensure the watch root exists. chokidar handles missing dirs in some
  // backends but glob-based watching on macOS FSEvents is unreliable when
  // deeply-nested path segments don't exist at startup — watching a stable
  // root directory and filtering events with the path parsers is more robust
  // across platforms.
  await mkdir(projectsDir, { recursive: true });

  const watcher = chokidar.watch(projectsDir, {
    // Ignore tempfiles + any dotfile/dir except the ".staging" directory
    // itself (which we explicitly want to traverse).
    ignored: (path: string) => {
      const base = path.split(/[\\/]/).pop() ?? "";
      if (base === ".staging") return false;
      return base.startsWith(".");
    },
    persistent: true,
    ignoreInitial: false, // pick up pre-existing files
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 30 },
  });

  watcher.on("add", async (path) => {
    if (parseStagingPath(path)) {
      await handleStaging(path, options.onEvent);
    } else {
      await handleCanonicalAddOrChange(path, options.onEvent);
    }
  });
  watcher.on("change", async (path) => {
    if (parseStagingPath(path)) {
      await handleStaging(path, options.onEvent);
    } else {
      await handleCanonicalAddOrChange(path, options.onEvent);
    }
  });
  watcher.on("unlink", (path) => {
    if (parseStagingPath(path)) return; // ignore staging deletes
    const parsed = parseCanonicalPath(path);
    if (!parsed) return;
    options.onEvent({
      type: "artifact-delete",
      sessionId: parsed.sessionId,
      artifactId: parsed.artifactId,
    });
  });

  // Wait for the initial scan to settle.
  await new Promise<void>((resolve) => watcher.on("ready", () => resolve()));

  return {
    async stop() {
      await watcher.close();
    },
  };
}

async function handleStaging(
  path: string,
  onEvent: (e: ArtifactEvent) => void,
): Promise<void> {
  const parsed = parseStagingPath(path);
  if (!parsed) return;

  const result = await ingestStagingFile(path, parsed.projectId, parsed.sessionId);
  if (result.kind === "ingested") {
    onEvent({
      type: "artifact-update",
      sessionId: parsed.sessionId,
      artifact: result.artifact,
    });
  } else {
    onEvent({
      type: "artifact-error",
      sessionId: parsed.sessionId,
      artifactId: result.artifactId,
      errors: result.issues,
    });
  }
}

/**
 * Handle adds/changes on a canonical (non-staging) path.
 *
 * The normal ingest flow writes canonical files itself (via the atomic rename
 * out of staging), which would generate chokidar add events here too. We only
 * want to BROADCAST when the canonical file did NOT come from a staging ingest
 * — i.e. when core-side code wrote it directly (e.g. `writeAgentStatusArtifact`
 * writing `core-agent-status.json`).
 *
 * The `core-` id prefix is reserved for synthesized artifacts that bypass
 * staging, so we use that prefix as the discriminator: emit `artifact-update`
 * only for `core-*` canonical adds. Non-core canonical adds are silently
 * ignored — they came from our own ingest pipeline and the staging-side
 * handler already emitted the event.
 */
async function handleCanonicalAddOrChange(
  path: string,
  onEvent: (e: ArtifactEvent) => void,
): Promise<void> {
  const parsed = parseCanonicalPath(path);
  if (!parsed) return;
  if (!parsed.artifactId.startsWith("core-")) return;

  const artifact = await readCanonicalArtifactIfExists(
    parsed.projectId,
    parsed.sessionId,
    parsed.artifactId,
  );
  if (!artifact) return;

  onEvent({
    type: "artifact-update",
    sessionId: parsed.sessionId,
    artifact,
  });
}

/**
 * Parse `~/.agent-orchestrator/projects/{projectId}/artifacts/{sessionId}/.staging/{id}.json`
 * into `{ projectId, sessionId, artifactId }`. Returns null if the path doesn't
 * match.
 *
 * Exported so unit tests (e.g. artifact-ingest.windows.test.ts) can verify that
 * the parser tolerates Windows-style backslash separators.
 */
export function parseStagingPath(
  path: string,
): { projectId: string; sessionId: string; artifactId: string } | null {
  // Normalize separators (handles `/` and `\`).
  const segments = path.split(/[\\/]/);
  const stagingIdx = segments.lastIndexOf(".staging");
  if (stagingIdx < 3) return null;
  const sessionId = segments[stagingIdx - 1];
  const artifactsIdx = stagingIdx - 2;
  if (segments[artifactsIdx] !== "artifacts") return null;
  const projectId = segments[artifactsIdx - 1];
  const artifactFile = segments[segments.length - 1];
  if (!sessionId || !projectId || !artifactFile) return null;
  if (!artifactFile.endsWith(".json")) return null;
  return {
    projectId,
    sessionId,
    artifactId: artifactFile.replace(/\.json$/, ""),
  };
}

/**
 * Parse `~/.agent-orchestrator/projects/{projectId}/artifacts/{sessionId}/{id}.json`
 * (canonical, not staging) into `{ projectId, sessionId, artifactId }`. Returns
 * null if the path doesn't match.
 */
export function parseCanonicalPath(
  path: string,
): { projectId: string; sessionId: string; artifactId: string } | null {
  const segments = path.split(/[\\/]/);
  const file = segments[segments.length - 1];
  if (!file || !file.endsWith(".json")) return null;
  if (file.startsWith(".")) return null; // tempfile
  const sessionId = segments[segments.length - 2];
  const artifactsIdx = segments.length - 3;
  if (segments[artifactsIdx] !== "artifacts") return null;
  const projectId = segments[artifactsIdx - 1];
  if (!sessionId || !projectId) return null;
  return {
    projectId,
    sessionId,
    artifactId: file.replace(/\.json$/, ""),
  };
}
