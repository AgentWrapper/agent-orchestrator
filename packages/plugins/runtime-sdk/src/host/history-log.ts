/**
 * host/history-log.ts — durable NDJSON history persistence + sidecar indexes.
 *
 * The append-only `events.ndjson` is the source of truth for replay, restart
 * recovery, and reading older history. The host writes to it through the sink
 * created here; SessionHost stays transport- and storage-agnostic (it only knows
 * a `persist(line)` callback).
 *
 * #4 (indexed history) — pure, protocol-neutral optimization. A long-lived
 * orchestrator log grows to ~50k events / ~19 MB; a linear scan to read a tail or
 * page back is expensive. So alongside `events.ndjson` we maintain three small
 * sidecar indexes of BYTE OFFSETS, written incrementally as events are appended:
 *
 *   events.ndjson   append-only event log (unchanged source of truth)
 *   events.idx      sparse checkpoints: 1 record per CHECKPOINT_INTERVAL events
 *   turns.idx       1 record per turn boundary (first event of each (epoch,turn))
 *   epochs.idx      1 record per epoch boundary (a seq reset = a resumed host)
 *
 * A reader seeks straight to the relevant offset instead of scanning the whole
 * file. EVERY reader degrades safely: if an index is missing, stale, or corrupt
 * it transparently falls back to a full scan and NEVER throws on a read. The
 * indexes are a cache, not a second source of truth — `events.ndjson` alone is
 * always sufficient.
 *
 * This file changes NO wire message: the live socket and its snapshot are
 * untouched. The indexes only accelerate file reads (the app's "load older"
 * pagination over `events.ndjson`, and any future host-side history seek).
 */

import {
  appendFileSync,
  writeFileSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** One checkpoint / boundary record. Compact JSON, one per line in the .idx files. */
export interface IndexRecord {
  /** Byte offset in events.ndjson where this event's line STARTS. */
  o: number;
  /** Event seq (per-epoch, resets on resume). */
  s: number;
  /** 1-based user turn (0 for pre-first-turn events). */
  t: number;
  /** Host-epoch index (0 for the first host; +1 per resume / seq reset). */
  e: number;
}

/** Sparse-checkpoint stride: one `events.idx` record per this many events. */
export const CHECKPOINT_INTERVAL = 64;

/** Resolve the three sidecar index paths next to an `events.ndjson`. */
export function indexPaths(eventLogPath: string): {
  events: string;
  turns: string;
  epochs: string;
} {
  const dir = dirname(eventLogPath);
  return {
    events: join(dir, "events.idx"),
    turns: join(dir, "turns.idx"),
    epochs: join(dir, "epochs.idx"),
  };
}

// ===========================================================================
// Low-level file helpers (seek-friendly, never throw on a clean miss)
// ===========================================================================

/** File size in bytes, or 0 if the file does not exist / is unreadable. */
function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Read a byte range [start, start+length) from `path` via a positioned read, so a
 * tail read touches only the tail — not the whole multi-MB file. Returns the bytes
 * actually read (possibly fewer at EOF).
 */
function readRange(path: string, start: number, length: number): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** Split a buffer/string into non-empty NDJSON lines (newline-delimited). */
function splitLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length > 0) out.push(raw);
  }
  return out;
}

/** Parse the records of an `.idx` file, or [] if missing/empty/corrupt. */
function readIndexRecords(idxPath: string): IndexRecord[] {
  let text: string;
  try {
    text = readFileSync(idxPath, "utf-8");
  } catch {
    return [];
  }
  const out: IndexRecord[] = [];
  for (const line of splitLines(text)) {
    try {
      const r = JSON.parse(line) as IndexRecord;
      if (typeof r.o === "number") out.push(r);
    } catch {
      /* skip a corrupt record — the reader can still seek to the others */
    }
  }
  return out;
}

// ===========================================================================
// Full-scan fallback (always correct, used when an index can't be trusted)
// ===========================================================================

/** Every non-empty line of the log, in order. [] if the log is missing. */
export function readAllLines(eventLogPath: string): string[] {
  let text: string;
  try {
    text = readFileSync(eventLogPath, "utf-8");
  } catch {
    return [];
  }
  return splitLines(text);
}

// ===========================================================================
// Readers (seek via index; transparent full-scan fallback)
// ===========================================================================

/**
 * The last `n` event lines of the log. Seeks to a checkpoint within `n` events of
 * EOF via `events.idx` and reads only from there; falls back to a full scan if the
 * index is missing/stale/corrupt or the seek yields too few lines. Never throws.
 */
export function readTailLines(eventLogPath: string, n: number): string[] {
  if (n <= 0) return [];
  try {
    const size = fileSize(eventLogPath);
    if (size === 0) return [];
    const checkpoints = readIndexRecords(indexPaths(eventLogPath).events);
    if (checkpoints.length === 0) return fullScanTail(eventLogPath, n);

    // Pick a checkpoint at least ~n events before EOF: each checkpoint is
    // CHECKPOINT_INTERVAL events apart, so step back ceil(n / interval) + 1
    // checkpoints to be sure the slice holds ≥ n events.
    const back = Math.ceil(n / CHECKPOINT_INTERVAL) + 1;
    const startIdx = Math.max(0, checkpoints.length - back);
    const startOffset = checkpoints[startIdx].o;
    // Stale guard: a checkpoint past EOF means the log was truncated/rotated under
    // a stale index → don't trust it, scan.
    if (startOffset < 0 || startOffset >= size) return fullScanTail(eventLogPath, n);

    const slice = readRange(eventLogPath, startOffset, size - startOffset).toString("utf-8");
    const lines = splitLines(slice);
    if (lines.length < n && startIdx > 0) {
      // The chosen checkpoint didn't cover enough (e.g. variable record sizes) —
      // a full scan is the safe answer rather than returning a short tail.
      return fullScanTail(eventLogPath, n);
    }
    return lines.slice(Math.max(0, lines.length - n));
  } catch {
    return fullScanTail(eventLogPath, n);
  }
}

/** Full-scan tail — the fallback. Always correct, O(file). */
function fullScanTail(eventLogPath: string, n: number): string[] {
  const all = readAllLines(eventLogPath);
  return all.slice(Math.max(0, all.length - n));
}

/**
 * Read up to `limit` lines starting at byte `offset` (a line boundary, e.g. one
 * from an index record). `limit <= 0` reads to EOF. Never throws; returns [] on a
 * bad offset.
 */
export function readLinesFrom(eventLogPath: string, offset: number, limit = 0): string[] {
  try {
    const size = fileSize(eventLogPath);
    if (size === 0 || offset < 0 || offset >= size) return [];
    const slice = readRange(eventLogPath, offset, size - offset).toString("utf-8");
    const lines = splitLines(slice);
    return limit > 0 ? lines.slice(0, limit) : lines;
  } catch {
    return [];
  }
}

/**
 * Epoch boundary offsets (one per host instance in the log). Reads `epochs.idx`;
 * falls back to deriving them from a full scan (a seq that did not increase marks
 * a new epoch — the same rule the app's replay uses). Never throws.
 */
export function readEpochIndex(eventLogPath: string): IndexRecord[] {
  const fromIdx = readIndexRecords(indexPaths(eventLogPath).epochs);
  if (fromIdx.length > 0) return fromIdx;
  return deriveBoundaries(eventLogPath).epochs;
}

/**
 * Turn boundary offsets (first event of each (epoch, turn)). Reads `turns.idx`;
 * falls back to deriving them from a full scan. Never throws.
 */
export function readTurnIndex(eventLogPath: string): IndexRecord[] {
  const fromIdx = readIndexRecords(indexPaths(eventLogPath).turns);
  if (fromIdx.length > 0) return fromIdx;
  return deriveBoundaries(eventLogPath).turns;
}

// ===========================================================================
// Boundary derivation (the single rule shared by rebuild + fallback)
// ===========================================================================

interface DerivedBoundaries {
  epochs: IndexRecord[];
  turns: IndexRecord[];
  checkpoints: IndexRecord[];
  /** Final writer state after the scan, to resume incremental indexing. */
  state: IndexState;
}

interface IndexState {
  /** Byte offset where the NEXT appended line will start (== current file size). */
  offset: number;
  /** Total events seen so far (drives the checkpoint cadence). */
  count: number;
  /** Current epoch index. */
  epoch: number;
  /** Last event's seq (to detect a reset → new epoch). */
  prevSeq: number | null;
  /** `${epoch}:${turn}` of the last event (to detect a turn boundary). */
  prevTurnKey: string | null;
}

/**
 * Scan the whole log once and compute every boundary + the final writer state.
 * Shared by `rebuildIndex` (on host start) and the reader fallbacks, so the index
 * the writer produces and the index a reader derives are bit-for-bit the same.
 */
function deriveBoundaries(eventLogPath: string): DerivedBoundaries {
  const epochs: IndexRecord[] = [];
  const turns: IndexRecord[] = [];
  const checkpoints: IndexRecord[] = [];
  const state: IndexState = {
    offset: 0,
    count: 0,
    epoch: 0,
    prevSeq: null,
    prevTurnKey: null,
  };

  let text: string;
  try {
    text = readFileSync(eventLogPath, "utf-8");
  } catch {
    return { epochs, turns, checkpoints, state };
  }

  let cursor = 0;
  let byteOffset = 0; // running byte offset of `cursor` (UTF-8), advanced per line
  // Walk raw so each line's byte offset is exact (multi-byte chars included).
  while (cursor < text.length) {
    const nl = text.indexOf("\n", cursor);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(cursor, end);
    if (line.length > 0) {
      applyLine(state, line, byteOffset, { epochs, turns, checkpoints });
    }
    // Advance the byte offset past this line + its newline (if any).
    byteOffset += Buffer.byteLength(line) + (nl === -1 ? 0 : 1);
    if (nl === -1) break;
    cursor = nl + 1;
  }
  state.offset = byteOffset;
  return { epochs, turns, checkpoints, state };
}

/**
 * Fold one already-appended line into the running index state, recording any
 * boundary/checkpoint it crosses into the given sinks. Pure w.r.t. the file: it
 * only reads the line and mutates `state` + appends to the in-memory record
 * arrays. Used by both the full-scan rebuild and (with single-element sinks) the
 * incremental writer.
 */
function applyLine(
  state: IndexState,
  line: string,
  lineOffset: number,
  out: { epochs: IndexRecord[]; turns: IndexRecord[]; checkpoints: IndexRecord[] },
): void {
  let seq: number | null = null;
  let turn = 0;
  try {
    const ev = JSON.parse(line) as { seq?: unknown; turn?: unknown };
    if (typeof ev.seq === "number") seq = ev.seq;
    if (typeof ev.turn === "number") turn = ev.turn;
  } catch {
    // A corrupt line still advances count so the checkpoint cadence stays aligned;
    // it just can't contribute a boundary. Offset is owned by the caller.
    void lineOffset;
    state.count += 1;
    return;
  }

  const rec: IndexRecord = { o: lineOffset, s: seq ?? 0, t: turn, e: state.epoch };

  // Epoch boundary: the first event ever, or a seq that did not advance (resume).
  if (state.count === 0) {
    out.epochs.push({ ...rec });
  } else if (seq !== null && state.prevSeq !== null && seq <= state.prevSeq) {
    state.epoch += 1;
    rec.e = state.epoch;
    out.epochs.push({ ...rec });
  }

  // Turn boundary: first event of each (epoch, turn).
  const turnKey = `${state.epoch}:${turn}`;
  if (turnKey !== state.prevTurnKey) {
    out.turns.push({ ...rec });
  }

  // Sparse checkpoint cadence (includes the very first event at count 0).
  if (state.count % CHECKPOINT_INTERVAL === 0) {
    out.checkpoints.push({ ...rec });
  }

  if (seq !== null) state.prevSeq = seq;
  state.prevTurnKey = turnKey;
  state.count += 1;
}

// ===========================================================================
// Writer (rebuild on start, then incremental append)
// ===========================================================================

/** Serialize a record as one NDJSON line. */
function encodeRecord(r: IndexRecord): string {
  return JSON.stringify(r) + "\n";
}

/**
 * (Re)build the three sidecar indexes from the current `events.ndjson` and return
 * the writer state to continue from. Called once per host start so the index
 * always matches the file (the log is appended-to across resumes). Best-effort: a
 * write failure is swallowed and reported via the return (state still valid for
 * in-memory tracking; on-disk index just stays absent and readers fall back).
 */
export function rebuildIndex(eventLogPath: string): IndexState {
  const { epochs, turns, checkpoints, state } = deriveBoundaries(eventLogPath);
  const paths = indexPaths(eventLogPath);
  try {
    writeFileSync(paths.events, checkpoints.map(encodeRecord).join(""));
    writeFileSync(paths.turns, turns.map(encodeRecord).join(""));
    writeFileSync(paths.epochs, epochs.map(encodeRecord).join(""));
  } catch {
    /* index is a cache — a rebuild write failure just leaves readers on full scan */
  }
  return state;
}

/**
 * Create the durable event-log sink: appends one already-encoded NDJSON line per
 * call to `events.ndjson` AND maintains the sidecar indexes incrementally.
 *
 * The durable append keeps its original contract: synchronous, ordering matches
 * emission exactly, and it MAY throw (SessionHost wraps the persist call in a
 * try/catch so a disk hiccup never kills the turn or the live stream). The index
 * maintenance is strictly best-effort and isolated — it never throws out of the
 * sink and never affects whether/what gets appended to `events.ndjson`.
 */
export function createEventLogSink(eventLogPath: string): (line: string) => void {
  // Rebuild the index from any pre-existing log (resume appends to it), so the
  // on-disk index and the running offset start consistent with the file. If even
  // this fails, disable indexing entirely and behave exactly like the original
  // append-only sink.
  let state: IndexState | null;
  try {
    state = rebuildIndex(eventLogPath);
  } catch {
    state = null;
  }
  const paths = indexPaths(eventLogPath);

  return (line: string) => {
    if (!state) {
      appendFileSync(eventLogPath, line); // indexing off → original behavior
      return;
    }
    const lineOffset = state.offset;
    // PRIMARY durability first. If this throws (disk full), we return before
    // advancing offset — nothing was written, so state stays consistent and the
    // error propagates to SessionHost's persist try/catch as before.
    appendFileSync(eventLogPath, line);
    state.offset += Buffer.byteLength(line);
    try {
      // Reuse the exact boundary rule, collecting any crossed records, then append
      // them to their files. applyLine advances count/seq/turn/epoch in `state`
      // (offset is owned by the sink, already advanced above).
      const out = { epochs: [] as IndexRecord[], turns: [] as IndexRecord[], checkpoints: [] as IndexRecord[] };
      applyLine(state, line, lineOffset, out);
      for (const r of out.epochs) appendFileSync(paths.epochs, encodeRecord(r));
      for (const r of out.turns) appendFileSync(paths.turns, encodeRecord(r));
      for (const r of out.checkpoints) appendFileSync(paths.events, encodeRecord(r));
    } catch {
      /* index maintenance is best-effort; the log itself is already durable */
    }
  };
}
