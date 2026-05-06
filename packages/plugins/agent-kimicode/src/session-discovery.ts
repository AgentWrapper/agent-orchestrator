import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session } from "@aoagents/ao-core";

// =============================================================================
// Kimi session-discovery layer
// =============================================================================
//
// Decision table (highest priority first) — used by findKimiSessionMatchUncached
// to resolve a Session → kimi UUID:
//
//   priority │ source                                    │ when
//   ─────────┼───────────────────────────────────────────┼──────────────────────
//   1        │ Pin file (.ao/kimi-session-id.json)       │ written once after a
//            │                                           │ successful match;
//            │                                           │ then dominant.
//   2        │ kimi.json soft-pin (`last_session_id`)    │ kimi-cli's own
//            │                                           │ bookkeeping; fallback
//            │                                           │ when AO pin not yet
//            │                                           │ written.
//   3        │ Recency heuristic (live-file mtime)       │ filtered by:
//            │                                           │   - baseline (pre-
//            │                                           │     existing UUIDs)
//            │                                           │   - createdAt - 60s
//            │                                           │   - sandbox check
//            │                                           │ winner is persisted
//            │                                           │ to the pin file (1).
//
// Files written into the workspace's .ao/ dir:
//   - kimi-baseline.json   — UUIDs that existed BEFORE launch
//   - kimi-session-id.json — pinned UUID for this AO session
//
// Both are write-once and survive restore.
// =============================================================================

// =============================================================================
// Paths and constants
// =============================================================================

/** Kimi stores sessions under ~/.kimi/ (override via KIMI_SHARE_DIR). */
export function kimiShareDir(): string {
  const override = process.env["KIMI_SHARE_DIR"];
  if (override && override.trim().length > 0) return override;
  return join(homedir(), ".kimi");
}

const KIMI_BASELINE_FILE = ".ao/kimi-baseline.json";
const KIMI_PIN_FILE = ".ao/kimi-session-id.json";

/** Positive-result TTL: a found session is unlikely to change identity within
 *  a single refresh cycle. Mirrors agent-codex's SESSION_FILE_CACHE_TTL_MS. */
const SESSION_MATCH_CACHE_TTL_MS = 30_000;
/** Negative-result TTL: kept short so a session that appears mid-poll is picked
 *  up on the next cycle instead of staying null for the full positive TTL. */
const SESSION_MATCH_NEGATIVE_TTL_MS = 2_000;
/** Soft cap on the cache map size — prunes expired entries when exceeded so
 *  long-running daemons with many worktrees don't grow unbounded. */
const SESSION_MATCH_CACHE_MAX_ENTRIES = 256;

// =============================================================================
// kimi.json — workspace-to-session mapping
// =============================================================================

interface KimiWorkDir {
  path: string;
  kaos?: string;
  last_session_id?: string | null;
}

interface KimiJson {
  work_dirs?: KimiWorkDir[];
}

/**
 * Read ~/.kimi/kimi.json — the authoritative workspace-to-session mapping
 * maintained by kimi-cli. Returns null on any I/O or parse error so callers
 * can fall back to the hash-based scan.
 */
async function readKimiJson(): Promise<KimiJson | null> {
  try {
    const raw = await readFile(join(kimiShareDir(), "kimi.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as KimiJson;
  } catch {
    return null;
  }
}

/**
 * Find the kimi.json work_dirs entry for a workspace. Matches against the
 * resolved (realpath) workspace path so symlinked worktrees are handled.
 * Returns the entry (including last_session_id when populated) or null.
 */
async function findKimiWorkDirEntry(workspacePath: string): Promise<KimiWorkDir | null> {
  const kimiJson = await readKimiJson();
  if (!kimiJson?.work_dirs || !Array.isArray(kimiJson.work_dirs)) return null;

  const resolved = await resolveWorkspacePath(workspacePath);

  for (const entry of kimiJson.work_dirs) {
    if (!entry || typeof entry.path !== "string") continue;
    const entryResolved = await resolveWorkspacePath(entry.path);
    if (entryResolved === resolved) return entry;
  }
  return null;
}

// =============================================================================
// Path utilities
// =============================================================================

export interface KimiSessionMatch {
  /** Absolute path to the session directory, e.g.
   *  ~/.kimi/sessions/<md5(cwd)>/<session-uuid>/ */
  dir: string;
  /** Session UUID (directory basename) — accepted by `kimi --resume <id>`. */
  sessionId: string;
  /** mtime of the newest live-signal file (context.jsonl / wire.jsonl).
   *  Captured during the scan so callers don't re-stat. */
  mtime: Date;
}

/** MD5 hex digest of an absolute workspace path — kimi uses this as the
 *  per-workspace bucket under ~/.kimi/sessions/. */
function kimiWorkspaceHash(workspacePath: string): string {
  return createHash("md5").update(workspacePath).digest("hex");
}

/**
 * Resolve the workspace path kimi would see as its cwd. kimi's process reads
 * cwd via `os.getcwd()`, which on Linux returns the realpath (symlinks are
 * resolved by the kernel via /proc/self/cwd). If AO hands us a symlinked
 * workspacePath, our MD5 of the symlink won't match kimi's MD5 of the
 * resolved path — session discovery would silently miss every session.
 *
 * realpath() is best-effort: if the path doesn't exist or isn't readable,
 * fall back to the raw string so we don't regress workflows where the
 * workspace is created later or the caller has stricter sandboxing.
 */
async function resolveWorkspacePath(workspacePath: string): Promise<string> {
  try {
    return await realpath(workspacePath);
  } catch {
    return workspacePath;
  }
}

/**
 * Sandbox check — fail closed if a candidate path escapes ~/.kimi/sessions/.
 * Bucket entries in a real kimi install are regular directories, but a
 * symlink placed there (maliciously or accidentally) would let stat() /
 * createReadStream() follow it to arbitrary filesystem locations, potentially
 * hanging on FIFOs/sockets or leaking reads from unrelated files.
 */
async function isInsideKimiSessions(candidate: string): Promise<boolean> {
  const sessionsRoot = join(kimiShareDir(), "sessions");
  let rootReal: string;
  let candReal: string;
  try {
    rootReal = await realpath(sessionsRoot);
  } catch {
    return false;
  }
  try {
    candReal = await realpath(candidate);
  } catch {
    return false;
  }
  const rootWithSep = rootReal.endsWith("/") ? rootReal : rootReal + "/";
  return candReal === rootReal || candReal.startsWith(rootWithSep);
}

/**
 * Sandbox check for individual files inside a kimi session dir. The dir was
 * already isInsideKimiSessions-verified, but its CHILDREN aren't — a symlink
 * placed at, say, ~/.kimi/sessions/<hash>/<uuid>/wire.jsonl pointing at
 * /etc/passwd or /dev/zero would let stat()/createReadStream() follow it
 * and read or hang on arbitrary files. Reject anything that isn't a regular
 * file (rules out symlinks, sockets, FIFOs, block devices). lstat is used
 * deliberately — stat would follow the symlink before we got the chance.
 */
export async function isKimiSessionFile(filePath: string): Promise<boolean> {
  try {
    const s = await lstat(filePath);
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Get the mtime of the freshest live signal inside a Kimi session directory.
 * context.jsonl / wire.jsonl update on every agent turn. Returns null when
 * neither file exists or both are non-regular (symlink/socket/etc) — callers
 * must treat this dir as "not a real session". Probed in parallel to avoid
 * serial filesystem roundtrips.
 */
async function getKimiLiveSignalMtime(sessionDir: string): Promise<Date | null> {
  const stats = await Promise.all(
    ["context.jsonl", "wire.jsonl"].map(async (name) => {
      try {
        const s = await lstat(join(sessionDir, name));
        return s.isFile() ? s : null;
      } catch {
        return null;
      }
    }),
  );
  let newest: Date | null = null;
  for (const s of stats) {
    if (s && (!newest || s.mtimeMs > newest.getTime())) newest = s.mtime;
  }
  return newest;
}

// =============================================================================
// Baseline — pre-existing UUIDs partition
// =============================================================================

interface KimiBaseline {
  /** Pre-existing UUIDs in ~/.kimi/sessions/<md5(workspace)>/ at AO launch. */
  preExistingUuids: string[];
  /** ISO timestamp the baseline was captured. */
  capturedAt: string;
}

async function readKimiBaseline(workspacePath: string): Promise<Set<string> | null> {
  try {
    const raw = await readFile(join(workspacePath, KIMI_BASELINE_FILE), "utf-8");
    const parsed = JSON.parse(raw) as KimiBaseline;
    if (!Array.isArray(parsed.preExistingUuids)) return null;
    return new Set(parsed.preExistingUuids);
  } catch {
    return null;
  }
}

/**
 * Snapshot existing UUIDs in this workspace's Kimi bucket. Called once by
 * preLaunchSetup; if the baseline file already exists (e.g. on session
 * restore) we leave it alone so the original "what was here before AO
 * started" partition is preserved.
 */
export async function captureKimiBaseline(workspacePath: string): Promise<void> {
  const baselineFile = join(workspacePath, KIMI_BASELINE_FILE);
  try {
    await stat(baselineFile);
    return; // Already captured — don't overwrite on restore.
  } catch {
    // ENOENT — fall through and capture.
  }

  const resolved = await resolveWorkspacePath(workspacePath);
  const bucket = join(kimiShareDir(), "sessions", kimiWorkspaceHash(resolved));
  let entries: string[] = [];
  try {
    entries = await readdir(bucket);
  } catch {
    // Bucket doesn't exist yet — first kimi launch in this workspace.
    // Empty baseline is correct.
  }

  const baseline: KimiBaseline = {
    preExistingUuids: entries,
    capturedAt: new Date().toISOString(),
  };
  try {
    await mkdir(join(workspacePath, ".ao"), { recursive: true });
    await writeFile(baselineFile, JSON.stringify(baseline), "utf-8");
  } catch {
    // Workspace not writable — best-effort. Discovery falls back to the
    // createdAt floor + pinned UUID checks, which already narrow the field.
  }
}

// =============================================================================
// Pin — workspace-local UUID lock
// =============================================================================

interface KimiSessionPin {
  /** Session UUID — accepted by `kimi --resume <id>`. */
  sessionId: string;
  /** ISO timestamp the pin was captured. */
  pinnedAt: string;
}

async function readKimiSessionPin(workspacePath: string): Promise<string | null> {
  try {
    const raw = await readFile(join(workspacePath, KIMI_PIN_FILE), "utf-8");
    const parsed = JSON.parse(raw) as KimiSessionPin;
    if (typeof parsed.sessionId !== "string" || parsed.sessionId.length === 0) return null;
    return parsed.sessionId;
  } catch {
    return null;
  }
}

async function writeKimiSessionPin(workspacePath: string, sessionId: string): Promise<void> {
  const pin: KimiSessionPin = {
    sessionId,
    pinnedAt: new Date().toISOString(),
  };
  try {
    await mkdir(join(workspacePath, ".ao"), { recursive: true });
    await writeFile(join(workspacePath, KIMI_PIN_FILE), JSON.stringify(pin), "utf-8");
  } catch {
    // Workspace not writable — best-effort. Discovery falls back to the
    // recency heuristic on every call until the pin can be persisted.
  }
}

// =============================================================================
// Discovery — main entry point
// =============================================================================

/**
 * Find the Kimi session directory for this workspace. See the decision table
 * at the top of this file for precedence rules.
 *
 * Layout (kimi-cli 1.38):
 *   ~/.kimi/sessions/<md5(cwd)>/<session-uuid>/
 *     context.jsonl   — conversation history
 *     wire.jsonl      — turn events
 */
async function findKimiSessionMatchUncached(
  session: Session,
): Promise<KimiSessionMatch | null> {
  if (!session.workspacePath) return null;
  const resolved = await resolveWorkspacePath(session.workspacePath);
  const bucket = join(kimiShareDir(), "sessions", kimiWorkspaceHash(resolved));

  if (!(await isInsideKimiSessions(bucket))) return null;

  let entries: string[];
  try {
    entries = await readdir(bucket);
  } catch {
    return null;
  }

  // Pin file takes highest priority. Once we've identified a UUID for this
  // AO session (this function writes the pin on first successful match),
  // we always return it — never re-evaluate the recency heuristic.
  const pinnedId = await readKimiSessionPin(session.workspacePath);

  // kimi.json soft-pin: kimi-cli stores `work_dirs[].last_session_id` for
  // each workspace. When populated it's more authoritative than directory
  // mtime — kimi itself wrote it. Used as a tiebreaker when no AO pin yet
  // exists.
  let kimiJsonSessionId: string | null = null;
  if (!pinnedId) {
    const workDirEntry = await findKimiWorkDirEntry(session.workspacePath);
    if (
      workDirEntry &&
      typeof workDirEntry.last_session_id === "string" &&
      workDirEntry.last_session_id.length > 0
    ) {
      kimiJsonSessionId = workDirEntry.last_session_id;
    }
  }

  // UUIDs that existed BEFORE this AO session started are partitioned out —
  // they belong to a manual `kimi` run, a sibling AO session, or some other
  // context. Without this, the "freshest in bucket" heuristic would attach
  // to whichever one happened to scroll recently.
  const baseline = await readKimiBaseline(session.workspacePath);

  // Any UUID older than (session.createdAt - grace) is from a prior life.
  const minAgeMs = session.createdAt.getTime() - 60_000;

  let best: { dir: string; sessionId: string; mtime: Date; mtimeMs: number } | null = null;
  let kimiJsonMatch: KimiSessionMatch | null = null;

  for (const entry of entries) {
    const dir = join(bucket, entry);
    if (!(await isInsideKimiSessions(dir))) continue;

    const liveMtime = await getKimiLiveSignalMtime(dir);
    if (!liveMtime) continue;

    if (pinnedId) {
      if (entry !== pinnedId) continue;
      return { dir, sessionId: entry, mtime: liveMtime };
    }

    // Baseline filter — UUIDs present at launch never count as "ours".
    // Applied BEFORE the kimi.json soft-pin check: kimi.json's
    // last_session_id can lag the live bucket (e.g. a manual `kimi`
    // run earlier left a stale pointer, or AO polls before kimi has
    // updated kimi.json). Without this guard, the soft-pin would
    // capture a baseline UUID and persist it to the AO pin file
    // permanently, with no self-healing path.
    if (baseline?.has(entry)) continue;

    if (liveMtime.getTime() < minAgeMs) continue;

    // kimi.json soft-pin candidate — record it but keep scanning so we
    // can still return a recency winner if the soft-pin UUID has no live
    // files (rare but possible if kimi.json points at a stale entry).
    // Reaches here only after passing the baseline + createdAt filters,
    // so a stale last_session_id pointing at a pre-AO UUID is rejected.
    if (kimiJsonSessionId && entry === kimiJsonSessionId) {
      kimiJsonMatch = { dir, sessionId: entry, mtime: liveMtime };
      continue;
    }

    const mtimeMs = liveMtime.getTime();
    if (!best || mtimeMs > best.mtimeMs) {
      best = { dir, sessionId: entry, mtime: liveMtime, mtimeMs };
    }
  }

  if (pinnedId) {
    // Pin existed but didn't match anything in the bucket — don't silently
    // fall back to a recency guess; that reintroduces the wrong-session bug.
    return null;
  }

  if (kimiJsonMatch) {
    await writeKimiSessionPin(session.workspacePath, kimiJsonMatch.sessionId);
    return kimiJsonMatch;
  }

  if (best) {
    // Persist the recency-heuristic winner. Subsequent calls will read the
    // pin file and bypass the heuristic — even if the bucket gains another
    // recently-active UUID later (manual kimi run, sibling AO session).
    await writeKimiSessionPin(session.workspacePath, best.sessionId);
    return { dir: best.dir, sessionId: best.sessionId, mtime: best.mtime };
  }
  return null;
}

// =============================================================================
// Cache
// =============================================================================

/** Per-workspace cache of the resolved session directory. */
const sessionMatchCache = new Map<string, { match: KimiSessionMatch | null; expiry: number }>();

/** Prune expired entries; if still over the cap, drop the oldest. */
function pruneSessionMatchCache(now: number): void {
  for (const [key, entry] of sessionMatchCache) {
    if (entry.expiry <= now) sessionMatchCache.delete(key);
  }
  if (sessionMatchCache.size <= SESSION_MATCH_CACHE_MAX_ENTRIES) return;
  const sorted = [...sessionMatchCache.entries()].sort((a, b) => a[1].expiry - b[1].expiry);
  const toDrop = sessionMatchCache.size - SESSION_MATCH_CACHE_MAX_ENTRIES;
  for (let i = 0; i < toDrop; i++) {
    const entry = sorted[i];
    if (entry) sessionMatchCache.delete(entry[0]);
  }
}

/** Cached wrapper around findKimiSessionMatchUncached. */
export async function findKimiSessionMatch(session: Session): Promise<KimiSessionMatch | null> {
  const workspacePath = session.workspacePath;
  if (!workspacePath) return null;

  // Key on workspace path. The pin is now file-based and persistent, so
  // it cannot drift between calls — workspace path uniquely identifies
  // the session for caching purposes.
  const key = workspacePath;

  const now = Date.now();
  const cached = sessionMatchCache.get(key);
  if (cached && cached.expiry > now) return cached.match;
  if (cached) sessionMatchCache.delete(key);

  const match = await findKimiSessionMatchUncached(session);
  const ttl = match ? SESSION_MATCH_CACHE_TTL_MS : SESSION_MATCH_NEGATIVE_TTL_MS;
  sessionMatchCache.set(key, { match, expiry: now + ttl });
  if (sessionMatchCache.size > SESSION_MATCH_CACHE_MAX_ENTRIES) {
    pruneSessionMatchCache(now);
  }
  return match;
}

/** @internal Clear the session match cache. Exported for testing only. */
export function _resetSessionMatchCache(): void {
  sessionMatchCache.clear();
}
