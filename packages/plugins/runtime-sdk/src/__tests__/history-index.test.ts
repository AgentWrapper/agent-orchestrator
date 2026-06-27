import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEventLogSink,
  readTailLines,
  readAllLines,
  readLinesFrom,
  readEpochIndex,
  readTurnIndex,
  rebuildIndex,
  indexPaths,
  CHECKPOINT_INTERVAL,
} from "../host/history-log.js";

/** Encode an event line exactly like the host (JSON + "\n"). */
function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + "\n";
}

/** A single-epoch event with monotonic seq and a turn that bumps every 4 events. */
function ev(seq: number): Record<string, unknown> {
  return { type: "text-delta", v: 1, seq, turn: Math.floor(seq / 4) + 1, text: `t${seq}` };
}

describe("history-log indexed reader (#4)", () => {
  let dir: string;
  let log: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hist-idx-"));
    log = join(dir, "events.ndjson");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes sidecar indexes and tail matches a full scan", () => {
    const sink = createEventLogSink(log);
    for (let i = 0; i < 200; i++) sink(line(ev(i)));

    const paths = indexPaths(log);
    expect(existsSync(paths.events)).toBe(true);
    expect(existsSync(paths.turns)).toBe(true);
    expect(existsSync(paths.epochs)).toBe(true);

    const all = readAllLines(log);
    expect(all).toHaveLength(200);

    for (const n of [1, 10, 64, 100, 199, 200, 300]) {
      const tail = readTailLines(log, n);
      const expected = all.slice(Math.max(0, all.length - n));
      expect(tail).toEqual(expected);
    }
  });

  it("checkpoints are sparse (≈ count / interval)", () => {
    const sink = createEventLogSink(log);
    for (let i = 0; i < 200; i++) sink(line(ev(i)));
    const checkpoints = readAllLines(indexPaths(log).events);
    // 200 events / 64 → checkpoints at 0,64,128,192 = 4.
    expect(checkpoints.length).toBe(Math.floor(199 / CHECKPOINT_INTERVAL) + 1);
  });

  it("offsets in events.idx point at real line starts", () => {
    const sink = createEventLogSink(log);
    for (let i = 0; i < 130; i++) sink(line(ev(i)));
    const records = readAllLines(indexPaths(log).events).map((l) => JSON.parse(l));
    for (const r of records) {
      const fromOffset = readLinesFrom(log, r.o, 1);
      expect(fromOffset).toHaveLength(1);
      const parsed = JSON.parse(fromOffset[0]);
      expect(parsed.seq).toBe(r.s);
    }
  });

  it("falls back to a full scan when the index is MISSING", () => {
    // Write the log WITHOUT a sink (no index produced).
    let raw = "";
    for (let i = 0; i < 150; i++) raw += line(ev(i));
    writeFileSync(log, raw);
    expect(existsSync(indexPaths(log).events)).toBe(false);

    const all = readAllLines(log);
    expect(readTailLines(log, 20)).toEqual(all.slice(-20));
    expect(readTailLines(log, 200)).toEqual(all); // n > total
  });

  it("falls back to a full scan when the index is CORRUPT/stale", () => {
    const sink = createEventLogSink(log);
    for (let i = 0; i < 150; i++) sink(line(ev(i)));
    const all = readAllLines(log);

    // Corrupt: garbage + a checkpoint pointing way past EOF (stale/rotated).
    writeFileSync(indexPaths(log).events, "not json\n" + line({ o: 99_999_999, s: 0, t: 0, e: 0 }));
    expect(readTailLines(log, 25)).toEqual(all.slice(-25));
  });

  it("never throws on a missing log", () => {
    const missing = join(dir, "nope.ndjson");
    expect(readTailLines(missing, 10)).toEqual([]);
    expect(readAllLines(missing)).toEqual([]);
    expect(readLinesFrom(missing, 0, 5)).toEqual([]);
    expect(readEpochIndex(missing)).toEqual([]);
    expect(readTurnIndex(missing)).toEqual([]);
  });

  it("indexes epoch boundaries on a seq reset (resume)", () => {
    const sink = createEventLogSink(log);
    // Epoch 0: seq 0..9
    for (let i = 0; i < 10; i++) sink(line(ev(i)));
    // Epoch 1: seq restarts at 0 (a resumed host)
    for (let i = 0; i < 10; i++) sink(line(ev(i)));
    // Epoch 2: seq restarts again
    for (let i = 0; i < 5; i++) sink(line(ev(i)));

    const epochs = readEpochIndex(log);
    expect(epochs.map((r) => r.e)).toEqual([0, 1, 2]);
    // Each recorded offset is the first line of that epoch (seq 0).
    for (const r of epochs) {
      const first = readLinesFrom(log, r.o, 1);
      expect(JSON.parse(first[0]).seq).toBe(0);
    }
    // The on-disk epochs.idx matches what a full-scan derivation produces.
    rmSync(indexPaths(log).epochs);
    expect(readEpochIndex(log).map((r) => r.e)).toEqual([0, 1, 2]);
  });

  it("indexes turn boundaries (first event of each turn)", () => {
    const sink = createEventLogSink(log);
    for (let i = 0; i < 20; i++) sink(line(ev(i))); // turn bumps every 4 → turns 1..5
    const turns = readTurnIndex(log);
    expect(turns.map((r) => r.t)).toEqual([1, 2, 3, 4, 5]);
    // Index-derived and scan-derived turn boundaries agree.
    rmSync(indexPaths(log).turns);
    expect(readTurnIndex(log).map((r) => r.t)).toEqual([1, 2, 3, 4, 5]);
  });

  it("rebuilds the index from a pre-existing log on the next host start (resume)", () => {
    // First host instance.
    const sink1 = createEventLogSink(log);
    for (let i = 0; i < 100; i++) sink1(line(ev(i)));

    // Second host instance: createEventLogSink rebuilds from the existing file,
    // then keeps appending — the tail must stay correct across the boundary.
    const sink2 = createEventLogSink(log);
    for (let i = 100; i < 220; i++) sink2(line({ ...ev(i), seq: i })); // continue seq
    const all = readAllLines(log);
    expect(all).toHaveLength(220);
    expect(readTailLines(log, 50)).toEqual(all.slice(-50));

    // Offsets still valid after the rebuild+append.
    const records = readAllLines(indexPaths(log).events).map((l) => JSON.parse(l));
    for (const r of records) {
      expect(JSON.parse(readLinesFrom(log, r.o, 1)[0]).seq).toBe(r.s);
    }
  });

  it("rebuildIndex reproduces the same checkpoints as incremental writing", () => {
    const sink = createEventLogSink(log);
    for (let i = 0; i < 175; i++) sink(line(ev(i)));
    const incremental = readFileSync(indexPaths(log).events, "utf-8");
    rebuildIndex(log);
    const rebuilt = readFileSync(indexPaths(log).events, "utf-8");
    expect(rebuilt).toEqual(incremental);
  });
});
