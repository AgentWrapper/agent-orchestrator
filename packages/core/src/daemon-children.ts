import {
  type ChildProcess,
  type SpawnOptions,
  execFile as execFileCb,
  spawn,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { atomicWriteFileSync } from "./atomic-write.js";
import { isWindows, killProcessTree } from "./platform.js";

const execFileAsync = promisify(execFileCb);
const DEFAULT_GRACE_MS = 5_000;
const LOCK_STALE_MS = 10_000;

export interface DaemonChildEntry {
  pid: number;
  role: string;
  parentPid: number;
  startedAt: string;
  command?: string;
}

export interface DaemonChildSweepResult {
  attempted: number;
  terminated: number;
  forceKilled: number;
  failed: number;
}

export interface AoOrphanProcess {
  pid: number;
  ppid: number;
  command: string;
  role: string;
}

export interface DaemonChildSweepOptions {
  ownerPid?: number;
  graceMs?: number;
}

function getRegistryFile(): string {
  return join(homedir(), ".agent-orchestrator", "daemon-children.json");
}

function getLockDir(): string {
  return join(homedir(), ".agent-orchestrator", "daemon-children.lock");
}

function ensureStateDir(): void {
  mkdirSync(join(homedir(), ".agent-orchestrator"), { recursive: true });
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function acquireRegistryLock(): () => void {
  ensureStateDir();
  const lockDir = getLockDir();
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      mkdirSync(lockDir);
      return () => {
        try {
          rmdirSync(lockDir);
        } catch {
          // Best effort.
        }
      };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > LOCK_STALE_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Retry lock acquisition if the lock disappeared between calls.
      }
      if (Date.now() > deadline) {
        throw new Error(`Could not acquire daemon child registry lock (${lockDir})`, {
          cause: err,
        });
      }
      sleepSync(25);
    }
  }
}

function isDaemonChildEntry(value: unknown): value is DaemonChildEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<DaemonChildEntry>;
  return (
    typeof entry.pid === "number" &&
    entry.pid > 0 &&
    typeof entry.role === "string" &&
    typeof entry.parentPid === "number" &&
    typeof entry.startedAt === "string" &&
    (entry.command === undefined || typeof entry.command === "string")
  );
}

function readRawDaemonChildren(): DaemonChildEntry[] {
  const file = getRegistryFile();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isDaemonChildEntry);
  } catch {
    return [];
  }
}

function writeRawDaemonChildren(entries: DaemonChildEntry[]): void {
  const file = getRegistryFile();
  if (entries.length === 0) {
    try {
      unlinkSync(file);
    } catch {
      // File may not exist.
    }
    return;
  }
  ensureStateDir();
  atomicWriteFileSync(file, JSON.stringify(entries, null, 2));
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as { code?: string }).code === "EPERM";
  }
}

async function waitForProcessesExit(pids: number[], timeoutMs: number): Promise<Set<number>> {
  const alive = new Set(pids.filter(isProcessAlive));
  const deadline = Date.now() + timeoutMs;

  while (alive.size > 0 && Date.now() < deadline) {
    for (const pid of alive) {
      if (!isProcessAlive(pid)) alive.delete(pid);
    }
    if (alive.size > 0) {
      await sleep(Math.min(50, Math.max(0, deadline - Date.now())));
    }
  }

  for (const pid of alive) {
    if (!isProcessAlive(pid)) alive.delete(pid);
  }

  return alive;
}

export function registerDaemonChild(entry: Omit<DaemonChildEntry, "startedAt">): void {
  if (entry.pid <= 0) return;
  const release = acquireRegistryLock();
  try {
    const next = readRawDaemonChildren().filter((existing) => existing.pid !== entry.pid);
    next.push({ ...entry, startedAt: new Date().toISOString() });
    writeRawDaemonChildren(next);
  } finally {
    release();
  }
}

export function unregisterDaemonChild(pid: number): void {
  const release = acquireRegistryLock();
  try {
    const before = readRawDaemonChildren();
    const next = before.filter((entry) => entry.pid !== pid);
    if (next.length === before.length) return;
    writeRawDaemonChildren(next);
  } finally {
    release();
  }
}

export function getDaemonChildren(): DaemonChildEntry[] {
  const release = acquireRegistryLock();
  try {
    const all = readRawDaemonChildren();
    const live = all.filter((entry) => isProcessAlive(entry.pid));
    if (live.length !== all.length) writeRawDaemonChildren(live);
    return live;
  } finally {
    release();
  }
}

export function clearDaemonChildrenRegistry(): void {
  const release = acquireRegistryLock();
  try {
    writeRawDaemonChildren([]);
  } finally {
    release();
  }
}

function pruneSweptDaemonChildren(sweptPids: Set<number>): void {
  const release = acquireRegistryLock();
  try {
    const next = readRawDaemonChildren().filter(
      (entry) => !sweptPids.has(entry.pid) || isProcessAlive(entry.pid),
    );
    writeRawDaemonChildren(next);
  } finally {
    release();
  }
}

const reapedChildren = new WeakSet<ChildProcess>();
const managedChildren = new Map<number, ChildProcess>();
let managedSignalHandlersInstalled = false;
let daemonShutdownHandlerInstalled = false;
let fallbackShutdownStarted = false;

/**
 * Tell the managed child reaper that this process owns an application-level
 * SIGINT/SIGTERM shutdown path. The reaper will still forward signals to
 * children, but it will not install its default 50ms fallback exit; the owning
 * shutdown handler is responsible for exiting after its async cleanup finishes.
 */
export function markDaemonShutdownHandlerInstalled(): void {
  daemonShutdownHandlerInstalled = true;
}

function getManagedChildPids(): number[] {
  return [...managedChildren.keys()];
}

function getSignalExitCode(signal: NodeJS.Signals): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function terminateManagedChildren(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
  for (const [pid, child] of managedChildren) {
    void killProcessTree(pid, signal);
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

async function exitAfterManagedChildren(signal: NodeJS.Signals): Promise<void> {
  const exitCode = getSignalExitCode(signal);
  const pids = getManagedChildPids();

  terminateManagedChildren("SIGTERM");

  const stillAlive = await waitForProcessesExit(pids, DEFAULT_GRACE_MS);
  if (stillAlive.size > 0) {
    terminateManagedChildren("SIGKILL");
    await waitForProcessesExit([...stillAlive], 1_000);
  }

  process.exit(exitCode);
}

function installManagedSignalHandlers(): void {
  if (managedSignalHandlersInstalled || isWindows()) return;
  managedSignalHandlersInstalled = true;

  const forward = (signal: NodeJS.Signals): void => {
    terminateManagedChildren();

    // Installing a signal listener disables Node's default "exit on signal"
    // behaviour. If no application-level shutdown handler is present, preserve
    // that default after giving managed children the same graceful
    // SIGTERM→wait→SIGKILL lifecycle used by `ao stop`.
    if (!daemonShutdownHandlerInstalled && !fallbackShutdownStarted) {
      fallbackShutdownStarted = true;
      void exitAfterManagedChildren(signal);
    }
  };

  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  process.on("exit", () => terminateManagedChildren());
}

/**
 * Track a long-running daemon child in the pid registry and forward parent
 * shutdown to it. If the owning process has its own shutdown handler, that
 * handler remains responsible for exiting; otherwise the managed signal
 * handler preserves Node's default signal-exit behaviour after forwarding.
 */
export function registerChildReaper(child: ChildProcess, role: string, command?: string): void {
  if (reapedChildren.has(child)) return;
  reapedChildren.add(child);

  const pid = child.pid;
  if (!pid) return;

  registerDaemonChild({ pid, role, parentPid: process.pid, command });
  managedChildren.set(pid, child);
  installManagedSignalHandlers();

  const cleanup = (): void => {
    managedChildren.delete(pid);
    unregisterDaemonChild(pid);
  };

  child.once("exit", cleanup);
  child.once("error", cleanup);
}

/**
 * The required interface for long-running subprocesses owned by the AO daemon.
 * Callers get normal child_process.spawn behaviour, plus pid registry,
 * signal forwarding, process-group cleanup, and registry unregister on exit.
 */
export function spawnManagedDaemonChild(
  role: string,
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  const child = spawn(command, [...args], options);
  registerChildReaper(child, role, [command, ...args].join(" "));
  return child;
}

export async function sweepDaemonChildren(
  options: DaemonChildSweepOptions = {},
): Promise<DaemonChildSweepResult> {
  const { ownerPid, graceMs = DEFAULT_GRACE_MS } = options;
  const entries = getDaemonChildren().filter(
    (entry) => ownerPid === undefined || entry.parentPid === ownerPid,
  );
  const result: DaemonChildSweepResult = {
    attempted: entries.length,
    terminated: 0,
    forceKilled: 0,
    failed: 0,
  };

  for (const entry of entries) {
    await killProcessTree(entry.pid, "SIGTERM");
  }

  const pids = entries.map((entry) => entry.pid);
  const stillAliveAfterTerm = await waitForProcessesExit(pids, graceMs);
  result.terminated = pids.length - stillAliveAfterTerm.size;

  for (const entry of entries.filter((entry) => stillAliveAfterTerm.has(entry.pid))) {
    await killProcessTree(entry.pid, "SIGKILL");
  }

  const stillAliveAfterKill = await waitForProcessesExit([...stillAliveAfterTerm], 1_000);
  result.forceKilled = stillAliveAfterTerm.size - stillAliveAfterKill.size;
  result.failed = stillAliveAfterKill.size;

  pruneSweptDaemonChildren(new Set(entries.map((entry) => entry.pid)));
  return result;
}

function isAsciiWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\n";
}

function normalizeCommand(command: string): string {
  return command.replaceAll("\\", "/").toLowerCase();
}

function firstCommandWord(command: string): string {
  let start = 0;
  while (start < command.length && isAsciiWhitespace(command[start] ?? "")) start++;

  let end = start;
  while (end < command.length && !isAsciiWhitespace(command[end] ?? "")) end++;

  return command.slice(start, end);
}

function commandLooksLikeNode(command: string): boolean {
  const executable = firstCommandWord(normalizeCommand(command));
  const basename = executable.slice(executable.lastIndexOf("/") + 1);
  return basename === "node" || basename === "node.exe";
}

export function classifyAoOrphanCommand(command: string): string | null {
  if (!commandLooksLikeNode(command)) return null;

  const normalized = normalizeCommand(command);

  if (
    normalized.includes("@aoagents/ao-web") &&
    (normalized.includes("/dist-server/") || normalized.includes(" dist-server/"))
  ) {
    return "ao-web";
  }
  if (
    normalized.includes("/ao lifecycle-worker ") ||
    normalized.includes(" ao lifecycle-worker ")
  ) {
    return "lifecycle-worker";
  }
  if (normalized.includes("next-server")) {
    return "next-server";
  }
  return null;
}

function parseLeadingUnsignedInt(
  value: string,
  start: number,
): { value: number; next: number } | null {
  let index = start;
  while (index < value.length && isAsciiWhitespace(value[index] ?? "")) index++;

  const firstDigit = index;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) break;
    index++;
  }

  if (index === firstDigit) return null;
  return { value: Number(value.slice(firstDigit, index)), next: index };
}

function parsePsLine(line: string): AoOrphanProcess | null {
  const pid = parseLeadingUnsignedInt(line, 0);
  if (!pid) return null;

  const ppid = parseLeadingUnsignedInt(line, pid.next);
  if (!ppid) return null;

  let commandStart = ppid.next;
  while (commandStart < line.length && isAsciiWhitespace(line[commandStart] ?? "")) {
    commandStart++;
  }

  const command = line.slice(commandStart);
  if (!Number.isFinite(pid.value) || !Number.isFinite(ppid.value) || ppid.value !== 1) {
    return null;
  }

  const role = classifyAoOrphanCommand(command);
  if (!role) return null;
  return { pid: pid.value, ppid: ppid.value, command, role };
}

export function detectAoOrphansFromPsOutput(psOutput: string): AoOrphanProcess[] {
  const orphans: AoOrphanProcess[] = [];
  for (const rawLine of psOutput.replaceAll("\r\n", "\n").split("\n")) {
    const line = rawLine.trimStart();
    if (!line) continue;

    const orphan = parsePsLine(line);
    if (orphan) orphans.push(orphan);
  }
  return orphans;
}

export async function scanAoOrphans(): Promise<AoOrphanProcess[]> {
  if (isWindows()) return [];
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid,ppid,command"], {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return detectAoOrphansFromPsOutput(stdout);
  } catch {
    return [];
  }
}

export async function reapAoOrphans(
  orphans: AoOrphanProcess[],
  graceMs: number = DEFAULT_GRACE_MS,
): Promise<DaemonChildSweepResult> {
  const result: DaemonChildSweepResult = {
    attempted: orphans.length,
    terminated: 0,
    forceKilled: 0,
    failed: 0,
  };

  for (const orphan of orphans) {
    await killProcessTree(orphan.pid, "SIGTERM");
  }

  const pids = orphans.map((orphan) => orphan.pid);
  const stillAliveAfterTerm = await waitForProcessesExit(pids, graceMs);
  result.terminated = pids.length - stillAliveAfterTerm.size;

  for (const orphan of orphans.filter((orphan) => stillAliveAfterTerm.has(orphan.pid))) {
    await killProcessTree(orphan.pid, "SIGKILL");
  }

  const stillAliveAfterKill = await waitForProcessesExit([...stillAliveAfterTerm], 1_000);
  result.forceKilled = stillAliveAfterTerm.size - stillAliveAfterKill.size;
  result.failed = stillAliveAfterKill.size;

  return result;
}

export function __getDaemonChildrenRegistryFile(): string {
  return getRegistryFile();
}
