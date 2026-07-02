import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  type CodeReviewFinding,
  type CodeReviewSeverity,
  createCodeReviewStore,
  type CodeReviewRun,
  type CodeReviewRunStatus,
  type CodeReviewRunSummary,
  type CodeReviewStore,
} from "./code-review-store.js";
import { getProjectCodeReviewsDir } from "./paths.js";
import {
  isOrchestratorSession,
  SessionNotFoundError,
  type OrchestratorConfig,
  type PluginRegistry,
  type PRInfo,
  type ProjectConfig,
  type SCM,
  type Session,
  type SessionManager,
} from "./types.js";
import { getShell, isWindows, killProcessTree } from "./platform.js";

const REVIEW_COMMAND_TIMEOUT_MS = 10 * 60_000;
const REVIEW_COMMAND_MAX_BUFFER = 8 * 1024 * 1024;
const REVIEW_RUN_CREATION_LOCK_FILE = ".create-run.lock";
const REVIEW_RUN_EXECUTION_LOCK_PREFIX = ".execute-run-";
const REVIEW_RUN_CREATION_LOCK_WAIT_MS = 5_000;
const REVIEW_RUN_CREATION_LOCK_STALE_MS = 30_000;
const REVIEW_LOCK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

async function execFileAsync(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
    shell?: boolean | string;
    windowsHide?: boolean;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = await import("node:child_process");
  return promisify(execFile)(file, args, { windowsHide: true, ...options });
}

async function execFileWithClosedStdin(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
    shell?: boolean | string;
    windowsHide?: boolean;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const { spawn } = await import("node:child_process");

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
      windowsHide: options.windowsHide ?? true,
      detached: !isWindows(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const maxBuffer = options.maxBuffer ?? REVIEW_COMMAND_MAX_BUFFER;
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };

    const terminateChild = () => {
      if (child.pid !== undefined) {
        return killProcessTree(child.pid).catch(() => undefined);
      }
      child.kill("SIGTERM");
      return Promise.resolve();
    };

    const fail = (message: string, code?: number | null, signal?: NodeJS.Signals | null) => {
      const error = new Error(message) as Error & {
        code?: number | null;
        signal?: NodeJS.Signals | null;
        stdout?: string;
        stderr?: string;
      };
      error.code = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    };

    const timer =
      options.timeout && options.timeout > 0
        ? setTimeout(() => {
            void terminateChild().finally(() => {
              finish(() => fail(`Command timed out after ${options.timeout}ms`, null, "SIGTERM"));
            });
          }, options.timeout)
        : null;

    const append = (kind: "stdout" | "stderr", chunk: Buffer) => {
      const next = chunk.toString();
      if (kind === "stdout") stdout += next;
      else stderr += next;

      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) <= maxBuffer) return;
      void terminateChild();
      finish(() => fail(`Command output exceeded maxBuffer ${maxBuffer}`));
    };

    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        fail(`Command failed with code ${code ?? signal ?? "unknown"}`, code, signal);
      });
    });
  });
}

export type CodeReviewRequestSource = "cli" | "web" | "system";

export interface TriggerCodeReviewInput {
  sessionId: string;
  requestedBy?: CodeReviewRequestSource;
  status?: CodeReviewRunStatus;
  summary?: string;
}

export interface TriggerCodeReviewOptions {
  config: OrchestratorConfig;
  sessionManager: SessionManager;
  storeFactory?: (projectId: string) => CodeReviewStore;
  resolveTargetSha?: (session: Session) => Promise<string | undefined>;
  now?: Date;
}

export interface CodeReviewRunnerFinding {
  severity?: CodeReviewSeverity;
  title?: string;
  body?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  category?: string;
  confidence?: number;
  fingerprint?: string;
}

export interface CodeReviewRunnerResult {
  findings?: CodeReviewRunnerFinding[];
  summary?: string;
  rawOutput?: string;
}

export interface CodeReviewRunnerContext {
  config: OrchestratorConfig;
  project: ProjectConfig;
  session: Session;
  run: CodeReviewRun;
  workspacePath: string;
  baseRef: string;
}

export type CodeReviewRunner = (
  context: CodeReviewRunnerContext,
) => Promise<CodeReviewRunnerResult>;

export type PrepareCodeReviewWorkspace = (context: {
  projectId: string;
  project: ProjectConfig;
  session: Session;
  run: CodeReviewRun;
}) => Promise<string>;

export interface ExecuteCodeReviewRunOptions {
  config: OrchestratorConfig;
  sessionManager: SessionManager;
  storeFactory?: (projectId: string) => CodeReviewStore;
  prepareWorkspace?: PrepareCodeReviewWorkspace;
  runReviewer?: CodeReviewRunner;
  now?: () => Date;
  force?: boolean;
  /** Needed to resolve the project's SCM plugin when review.autoPostVerdict is on. */
  registry?: PluginRegistry;
}

export interface ExecuteCodeReviewRunInput {
  projectId: string;
  runId: string;
}

export interface SendCodeReviewFindingsOptions {
  config: OrchestratorConfig;
  sessionManager: SessionManager;
  storeFactory?: (projectId: string) => CodeReviewStore;
  now?: () => Date;
}

export interface SendCodeReviewFindingsInput {
  projectId: string;
  runId: string;
}

export interface SendCodeReviewFindingsResult {
  run: CodeReviewRunSummary;
  sentFindingCount: number;
  message: string;
}

export interface MarkOutdatedCodeReviewRunsInput {
  store: CodeReviewStore;
  session: Session;
  resolveTargetSha?: (session: Session) => Promise<string | undefined>;
  now?: Date;
}

export class CodeReviewRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Code review run not found: ${runId}`);
    this.name = "CodeReviewRunNotFoundError";
  }
}

export class CodeReviewRunNotExecutableError extends Error {
  readonly runId: string;
  readonly reviewerSessionId: string;
  readonly status: CodeReviewRunStatus;

  constructor(run: CodeReviewRun) {
    super(`Code review run ${run.reviewerSessionId} is ${run.status}, not queued`);
    this.name = "CodeReviewRunNotExecutableError";
    this.runId = run.id;
    this.reviewerSessionId = run.reviewerSessionId;
    this.status = run.status;
  }
}

export class CodeReviewInvalidSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeReviewInvalidSessionError";
  }
}

export class CodeReviewNoOpenFindingsError extends Error {
  readonly runId: string;
  readonly reviewerSessionId: string;

  constructor(run: CodeReviewRun) {
    super(`No open review findings to send for ${run.reviewerSessionId}.`);
    this.name = "CodeReviewNoOpenFindingsError";
    this.runId = run.id;
    this.reviewerSessionId = run.reviewerSessionId;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePrNumber(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const match = url.match(/\/pull\/(\d+)(?:\D*$|$)/);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function formatFindingLocation(finding: CodeReviewFinding): string | null {
  if (!finding.filePath) return null;
  if (finding.startLine === undefined) return finding.filePath;
  if (finding.endLine !== undefined && finding.endLine !== finding.startLine) {
    return `${finding.filePath}:${finding.startLine}-${finding.endLine}`;
  }
  return `${finding.filePath}:${finding.startLine}`;
}

function formatFindingForAgent(finding: CodeReviewFinding, index: number): string {
  const lines = [`${index}. [${finding.severity}] ${finding.title}`];
  const location = formatFindingLocation(finding);
  if (location) lines.push(`   Location: ${location}`);
  if (finding.confidence !== undefined) lines.push(`   Confidence: ${finding.confidence}`);
  lines.push("   Details:");
  lines.push(
    ...finding.body
      .split(/\r?\n/)
      .map((line) => `   ${line}`)
      .filter((line, lineIndex, allLines) => line.trim() || lineIndex < allLines.length - 1),
  );
  return lines.join("\n");
}

function parseFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseSeverity(value: unknown): CodeReviewSeverity {
  switch (value) {
    case "error":
    case "warning":
    case "info":
      return value;
    default:
      return "warning";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stripMarkdownJsonFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function tryParseJsonCandidate(value: string): unknown | null {
  const candidates = [stripMarkdownJsonFence(value)];
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  for (const line of value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reverse()) {
    if (line.startsWith("{") || line.startsWith("[")) {
      candidates.push(line);
    }
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Keep trying looser candidates.
    }
  }

  return null;
}

function normalizeFinding(value: unknown, fallbackIndex: number): CodeReviewRunnerFinding | null {
  const record = asRecord(value);
  if (!record) return null;

  const body =
    typeof record["body"] === "string"
      ? record["body"].trim()
      : typeof record["message"] === "string"
        ? record["message"].trim()
        : "";
  if (!body) return null;

  const title =
    typeof record["title"] === "string" && record["title"].trim()
      ? record["title"].trim()
      : `Review finding ${fallbackIndex}`;

  const filePath =
    typeof record["filePath"] === "string"
      ? record["filePath"]
      : typeof record["path"] === "string"
        ? record["path"]
        : undefined;

  return {
    severity: parseSeverity(record["severity"]),
    title: truncate(title, 160),
    body: truncate(body, 12_000),
    filePath,
    startLine: parseFiniteNumber(record["startLine"] ?? record["line"]),
    endLine: parseFiniteNumber(record["endLine"]),
    category: typeof record["category"] === "string" ? record["category"] : undefined,
    confidence: parseFiniteNumber(record["confidence"]),
    fingerprint: typeof record["fingerprint"] === "string" ? record["fingerprint"] : undefined,
  };
}

export function parseReviewerOutput(output: string): CodeReviewRunnerFinding[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  const parsed = tryParseJsonCandidate(trimmed);
  const parsedRecord = asRecord(parsed);
  const rawFindings = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsedRecord?.["findings"])
      ? parsedRecord["findings"]
      : null;

  if (rawFindings) {
    return rawFindings
      .map((finding, index) => normalizeFinding(finding, index + 1))
      .filter((finding): finding is CodeReviewRunnerFinding => finding !== null);
  }

  if (/^no findings?\.?$/i.test(trimmed)) return [];

  return [
    {
      severity: "warning",
      title: "Reviewer output",
      body: truncate(trimmed, 12_000),
    },
  ];
}

function allocateReviewerSessionId(existingRuns: CodeReviewRun[], sessionPrefix: string): string {
  let max = 0;
  const pattern = new RegExp(`^${escapeRegex(sessionPrefix)}-rev-(\\d+)$`);

  for (const run of existingRuns) {
    const match = run.reviewerSessionId.match(pattern);
    if (!match) continue;
    const parsed = Number.parseInt(match[1], 10);
    if (!Number.isNaN(parsed) && parsed > max) {
      max = parsed;
    }
  }

  return `${sessionPrefix}-rev-${max + 1}`;
}

function isFsErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function assertSafeReviewLockId(id: string, label: string): void {
  if (!id || id === "." || id === ".." || !REVIEW_LOCK_ID_PATTERN.test(id)) {
    throw new Error(`Unsafe ${label}: "${id}"`);
  }
}

async function acquireCodeReviewStoreLock({
  store,
  lockFileName,
  label,
}: {
  store: CodeReviewStore;
  lockFileName: string;
  label: string;
}): Promise<() => void> {
  mkdirSync(store.storeDir, { recursive: true });
  const lockPath = join(store.storeDir, lockFileName);
  const startedAt = Date.now();

  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          closeSync(fd);
        } catch {
          // The descriptor may already be closed if process cleanup raced with release.
        }
        try {
          unlinkSync(lockPath);
        } catch {
          // Another process may already have cleaned up a stale lock.
        }
      };
    } catch (error) {
      if (!isFsErrorWithCode(error, "EEXIST")) {
        throw error;
      }

      try {
        const lockAgeMs = Date.now() - statSync(lockPath).mtimeMs;
        if (lockAgeMs > REVIEW_RUN_CREATION_LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (staleError) {
        if (isFsErrorWithCode(staleError, "ENOENT")) {
          continue;
        }
      }

      if (Date.now() - startedAt > REVIEW_RUN_CREATION_LOCK_WAIT_MS) {
        throw new Error(`Timed out waiting for ${label} lock`, { cause: error });
      }
      await delay(25);
    }
  }
}

async function withReviewRunCreationLock<T>(
  store: CodeReviewStore,
  callback: () => T | Promise<T>,
): Promise<T> {
  const release = await acquireCodeReviewStoreLock({
    store,
    lockFileName: REVIEW_RUN_CREATION_LOCK_FILE,
    label: "code review run creation",
  });
  try {
    return await callback();
  } finally {
    release();
  }
}

async function withReviewRunExecutionLock<T>(
  store: CodeReviewStore,
  runId: string,
  callback: () => T | Promise<T>,
): Promise<T> {
  assertSafeReviewLockId(runId, "review run id");
  const release = await acquireCodeReviewStoreLock({
    store,
    lockFileName: `${REVIEW_RUN_EXECUTION_LOCK_PREFIX}${runId}.lock`,
    label: `code review run ${runId} execution`,
  });
  try {
    return await callback();
  } finally {
    release();
  }
}

const SUPERSEDABLE_RUN_STATUSES: ReadonlySet<CodeReviewRunStatus> = new Set([
  "queued",
  "needs_triage",
  "sent_to_agent",
  "waiting_update",
  "clean",
]);

/**
 * Runs in these statuses represent an in-progress or not-yet-started reviewer
 * pass. A concurrent trigger for the same session must not spawn a second
 * one — it returns this run instead (see triggerCodeReviewForSession).
 */
const ACTIVE_REVIEW_RUN_STATUSES: ReadonlySet<CodeReviewRunStatus> = new Set([
  "queued",
  "preparing",
  "running",
]);

function markSupersededReviewRuns({
  store,
  existingRuns,
  linkedSessionId,
  targetSha,
  now,
}: {
  store: CodeReviewStore;
  existingRuns: CodeReviewRun[];
  linkedSessionId: string;
  targetSha: string | undefined;
  now: Date;
}): number {
  if (!targetSha) return 0;

  let updatedCount = 0;

  for (const run of existingRuns) {
    if (run.linkedSessionId !== linkedSessionId) continue;
    if (!run.targetSha || run.targetSha === targetSha) continue;
    if (!SUPERSEDABLE_RUN_STATUSES.has(run.status)) continue;
    store.updateRun(run.id, { status: "outdated" }, now);
    updatedCount++;
  }

  return updatedCount;
}

async function resolveGitHeadSha(session: Session): Promise<string | undefined> {
  const cwd = session.workspacePath;
  if (!cwd) return undefined;

  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd,
      timeout: 5_000,
    });
    const sha = stdout.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

async function git(cwd: string, args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout });
  return stdout.trim();
}

async function resolveWorkspaceHead(
  workspacePath: string | null | undefined,
): Promise<string | undefined> {
  if (!workspacePath) return undefined;
  try {
    return await git(workspacePath, ["rev-parse", "HEAD"], 5_000);
  } catch {
    return undefined;
  }
}

async function removeReviewerWorktree(repoPath: string, workspacePath: string): Promise<void> {
  if (!existsSync(workspacePath)) {
    try {
      await git(repoPath, ["worktree", "prune"]);
    } catch {
      // Best-effort cleanup of stale git metadata before adding the worktree again.
    }
    return;
  }

  try {
    await git(repoPath, ["worktree", "remove", "--force", workspacePath]);
    return;
  } catch {
    try {
      await git(repoPath, ["worktree", "prune"]);
    } catch {
      // Best-effort before falling back to directory removal.
    }
    rmSync(workspacePath, { recursive: true, force: true });
  }
}

export async function markOutdatedCodeReviewRunsForSession({
  store,
  session,
  resolveTargetSha = resolveGitHeadSha,
  now = new Date(),
}: MarkOutdatedCodeReviewRunsInput): Promise<number> {
  const targetSha = await resolveTargetSha(session);
  return markSupersededReviewRuns({
    store,
    existingRuns: store.listRuns({ linkedSessionId: session.id }),
    linkedSessionId: session.id,
    targetSha,
    now,
  });
}

export async function prepareGitReviewerWorkspace({
  projectId,
  project,
  session,
  run,
}: {
  projectId: string;
  project: ProjectConfig;
  session: Session;
  run: CodeReviewRun;
}): Promise<string> {
  const workspaceRoot = join(getProjectCodeReviewsDir(projectId), "workspaces");
  const workspacePath = join(workspaceRoot, run.reviewerSessionId);
  mkdirSync(workspaceRoot, { recursive: true });
  await removeReviewerWorktree(project.path, workspacePath);

  const ref = run.targetSha ?? (await resolveWorkspaceHead(session.workspacePath)) ?? "HEAD";
  await git(project.path, ["worktree", "add", "--detach", workspacePath, ref], 60_000);
  return workspacePath;
}

function buildDefaultReviewPrompt(context: CodeReviewRunnerContext): string {
  return [
    "You are an AO reviewer agent. Review this repository snapshot for concrete bugs only.",
    "Do not modify files. Do not publish comments anywhere.",
    `Review the changes against base ref "${context.baseRef}". Start with: git diff --merge-base ${context.baseRef} HEAD -- .`,
    "If that diff command fails, inspect git status/log and compare this detached reviewer workspace to the base ref using read-only commands.",
    `Linked coding worker: ${context.session.id}`,
    `Reviewer run: ${context.run.reviewerSessionId}`,
    `Base ref: ${context.baseRef}`,
    "Return only JSON using this schema:",
    '{"findings":[{"severity":"warning|error|info","title":"short title","body":"specific issue and fix","filePath":"optional/path","startLine":1,"endLine":1,"confidence":0.8}]}',
    'If there are no concrete bugs, return {"findings":[]}.',
  ].join("\n");
}

async function readOutputFile(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

export function createShellCodeReviewRunner(command: string): CodeReviewRunner {
  return async (context) => {
    const shell = getShell();
    const { stdout, stderr } = await execFileAsync(shell.cmd, shell.args(command), {
      cwd: context.workspacePath,
      timeout: REVIEW_COMMAND_TIMEOUT_MS,
      maxBuffer: REVIEW_COMMAND_MAX_BUFFER,
      env: process.env,
    });
    return { rawOutput: stdout.trim() || stderr.trim() };
  };
}

export function buildCodexCodeReviewArgs(
  outputFile: string,
  prompt: string,
  model?: string,
): string[] {
  const args = ["exec"];
  if (model) args.push("--model", model);
  args.push("--sandbox", "read-only", "--output-last-message", outputFile, prompt);
  return args;
}

export async function runCodexCodeReview(
  context: CodeReviewRunnerContext,
): Promise<CodeReviewRunnerResult> {
  const outputFile = join(context.workspacePath, ".ao-code-review-output.json");
  const prompt = buildDefaultReviewPrompt(context);
  const args = buildCodexCodeReviewArgs(outputFile, prompt, context.project.review?.model);

  try {
    const { stdout, stderr } = await execFileWithClosedStdin("codex", args, {
      cwd: context.workspacePath,
      timeout: REVIEW_COMMAND_TIMEOUT_MS,
      maxBuffer: REVIEW_COMMAND_MAX_BUFFER,
      env: process.env,
      shell: isWindows(),
    });
    const outputFileContents = await readOutputFile(outputFile);
    const rawOutput = outputFileContents ?? (stdout.trim() || stderr.trim());
    return { rawOutput };
  } catch (error) {
    const details =
      error instanceof Error && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`Codex review failed: ${details}`, { cause: error });
  }
}

// Claude reviewer is read-only and non-interactive: headless print mode with a
// whitelist of read-only tools so unlisted (write-capable) tools are denied
// without an interactive prompt — the equivalent of codex's `--sandbox
// read-only`. Output is the JSON described by buildDefaultReviewPrompt and is
// parsed by the same parseReviewerOutput as codex (identical findings schema).
const CLAUDE_REVIEW_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git status:*)",
  "Bash(git rev-parse:*)",
].join(",");

export function buildClaudeCodeReviewArgs(prompt: string, model?: string): string[] {
  const args = ["-p", prompt, "--output-format", "text", "--allowedTools", CLAUDE_REVIEW_ALLOWED_TOOLS];
  if (model) args.push("--model", model);
  return args;
}

export async function runClaudeCodeReview(
  context: CodeReviewRunnerContext,
): Promise<CodeReviewRunnerResult> {
  const prompt = buildDefaultReviewPrompt(context);
  const args = buildClaudeCodeReviewArgs(prompt, context.project.review?.model);

  try {
    const { stdout, stderr } = await execFileWithClosedStdin("claude", args, {
      cwd: context.workspacePath,
      timeout: REVIEW_COMMAND_TIMEOUT_MS,
      maxBuffer: REVIEW_COMMAND_MAX_BUFFER,
      env: process.env,
      shell: isWindows(),
    });
    return { rawOutput: stdout.trim() || stderr.trim() };
  } catch (error) {
    const details =
      error instanceof Error && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`Claude review failed: ${details}`, { cause: error });
  }
}

/**
 * Codex failure signatures that mean "the provider is unavailable" (account
 * usage/rate limits, HTTP 429, dropped transport, auth failures) rather than a
 * genuine review failure (timeout, parse bug, non-zero normal exit). Only these
 * trigger the claude fallback — see createCodexWithClaudeFallbackRunner.
 */
const CODEX_PROVIDER_UNAVAILABLE_PATTERNS: readonly RegExp[] = [
  /usage limit/i,
  /rate limit/i,
  /\b429\b/,
  /transport channel closed/i,
  /\b401\b/,
  /\b403\b/,
  /unauthorized/i,
  /not (?:logged|signed)[ -]?in/i,
  /authentication (?:failed|error|required|expired)/i,
  /invalid api key/i,
  /login (?:required|expired)/i,
];

function collectErrorText(error: unknown, depth = 0): string {
  if (depth > 5 || error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const stderr =
      "stderr" in error && typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr
        : "";
    const cause =
      "cause" in error ? collectErrorText((error as { cause?: unknown }).cause, depth + 1) : "";
    return `${error.message}\n${stderr}\n${cause}`;
  }
  return String(error);
}

export function isCodexProviderUnavailableError(error: unknown): boolean {
  const text = collectErrorText(error);
  return CODEX_PROVIDER_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(text));
}

export const CODEX_CLAUDE_FALLBACK_SUMMARY = "codex unavailable → claude fallback";

/**
 * Wrap the codex reviewer so that a provider-availability failure transparently
 * retries via the claude reviewer, tagging the run summary so the fallback is
 * visible. Non-provider failures (timeout, parse bug, etc.) propagate unchanged.
 */
export function createCodexWithClaudeFallbackRunner(
  primary: CodeReviewRunner = runCodexCodeReview,
  fallback: CodeReviewRunner = runClaudeCodeReview,
): CodeReviewRunner {
  return async (context) => {
    try {
      return await primary(context);
    } catch (error) {
      if (!isCodexProviderUnavailableError(error)) throw error;
      const result = await fallback(context);
      return { ...result, summary: result.summary ?? CODEX_CLAUDE_FALLBACK_SUMMARY };
    }
  };
}

/**
 * Pick the reviewer runner for a project. Default (no `review` block) is codex,
 * wrapped with a claude fallback for provider outages. Explicit `claude` runs
 * claude directly (no fallback — it is already the resilient choice).
 */
export function resolveCodeReviewRunner(project: ProjectConfig): CodeReviewRunner {
  if (project.review?.agent === "claude") {
    return runClaudeCodeReview;
  }
  return createCodexWithClaudeFallbackRunner();
}

function defaultReviewSummary(session: Session, source: CodeReviewRequestSource): string {
  const sourceLabel = source === "cli" ? "CLI" : source === "web" ? "dashboard" : "automation";
  return `Review requested from ${sourceLabel} for ${session.id}.`;
}

export function formatCodeReviewFindingsForAgent({
  run,
  findings,
  session,
}: {
  run: CodeReviewRun;
  findings: CodeReviewFinding[];
  session: Session;
}): string {
  const prLabel = run.prNumber
    ? `PR #${run.prNumber}${run.prUrl ? ` (${run.prUrl})` : ""}`
    : run.prUrl
      ? `PR ${run.prUrl}`
      : "the current PR";
  const targetLabel = run.targetSha ? `\nTarget SHA reviewed: ${run.targetSha}` : "";

  return [
    `AO reviewer ${run.reviewerSessionId} found ${findings.length} open issue${
      findings.length === 1 ? "" : "s"
    } for ${prLabel}.`,
    `Linked coding worker: ${session.id}`,
    `Review run: ${run.id}${targetLabel}`,
    "",
    "Please address each finding below. Verify each issue against the current source before editing, then update the PR branch and push your fixes.",
    "When you start working on these, report `ao report addressing-reviews`. When the fixes are ready for another review, report `ao report ready-for-review`.",
    "",
    "Findings:",
    findings.map((finding, index) => formatFindingForAgent(finding, index + 1)).join("\n\n"),
  ].join("\n");
}

function formatCodeReviewVerdictForPr({
  run,
  findings,
}: {
  run: CodeReviewRun;
  findings: CodeReviewFinding[];
}): string {
  const header = `AO reviewer ${run.reviewerSessionId} found ${findings.length} issue${
    findings.length === 1 ? "" : "s"
  }.`;

  return [
    header,
    "",
    ...findings.map((finding, index) => {
      const location = formatFindingLocation(finding);
      const locationLabel = location ? ` (${location})` : "";
      return `${index + 1}. [${finding.severity}] ${finding.title}${locationLabel}`;
    }),
  ].join("\n");
}

/**
 * Post the reviewer's verdict to the session's PR when review.autoPostVerdict
 * is enabled. Best-effort: missing PR, missing registry, or an SCM plugin
 * without commentOnPR all result in a warn-logged no-op rather than a thrown
 * error, since the review run itself already succeeded.
 */
async function maybePostVerdictToPr({
  project,
  registry,
  session,
  store,
  run,
  findings,
  now,
}: {
  project: ProjectConfig;
  registry: PluginRegistry | undefined;
  session: Session;
  store: CodeReviewStore;
  run: CodeReviewRun;
  findings: CodeReviewFinding[];
  now: Date;
}): Promise<void> {
  if (!project.review?.autoPostVerdict) return;
  if (run.verdictPostedAt) return;
  if (findings.length === 0) return;

  const pr: PRInfo | null = session.pr ?? null;
  if (!pr) {
    console.warn(
      `[code-review] autoPostVerdict enabled but session ${session.id} has no PR; skipping.`,
    );
    return;
  }

  if (!registry) {
    console.warn(
      `[code-review] autoPostVerdict enabled but no plugin registry was provided; skipping post for run ${run.id}.`,
    );
    return;
  }

  const scmPluginName = project.scm?.plugin;
  const scm = scmPluginName ? registry.get<SCM>("scm", scmPluginName) : null;
  if (!scm?.commentOnPR) {
    console.warn(
      `[code-review] autoPostVerdict enabled but SCM plugin "${scmPluginName ?? "unknown"}" does not support commentOnPR; skipping post for run ${run.id}.`,
    );
    return;
  }

  await scm.commentOnPR(pr, formatCodeReviewVerdictForPr({ run, findings }));
  store.updateRun(run.id, { verdictPostedAt: now.toISOString() }, now);
}

export async function triggerCodeReviewForSession(
  {
    config,
    sessionManager,
    storeFactory = createCodeReviewStore,
    resolveTargetSha = resolveGitHeadSha,
    now = new Date(),
  }: TriggerCodeReviewOptions,
  input: TriggerCodeReviewInput,
): Promise<CodeReviewRunSummary> {
  const session = await sessionManager.get(input.sessionId);
  if (!session) {
    throw new SessionNotFoundError(input.sessionId);
  }

  const project = config.projects[session.projectId];
  if (!project) {
    throw new CodeReviewInvalidSessionError(
      `Unknown project for session ${session.id}: ${session.projectId}`,
    );
  }

  const sessionPrefix = project.sessionPrefix ?? session.projectId;
  const allSessionPrefixes = Object.entries(config.projects).map(
    ([projectId, projectConfig]) => projectConfig.sessionPrefix ?? projectId,
  );
  if (isOrchestratorSession(session, sessionPrefix, allSessionPrefixes)) {
    throw new CodeReviewInvalidSessionError(
      `Cannot request code review for orchestrator session: ${session.id}`,
    );
  }

  const store = storeFactory(session.projectId);
  const prUrl = session.pr?.url ?? session.metadata["pr"];
  const prNumber = session.pr?.number ?? parsePrNumber(prUrl);
  const targetSha = await resolveTargetSha(session);
  const requestedBy = input.requestedBy ?? "system";

  return withReviewRunCreationLock(store, () => {
    const existingRuns = store.listRuns();

    // Serialize concurrent triggers for the same session: if a reviewer run is
    // already in flight (queued/preparing/running), return it instead of
    // spawning a second one. The file lock above makes this check atomic
    // across concurrent callers, including truly simultaneous triggers.
    const activeRun = existingRuns.find(
      (run) => run.linkedSessionId === session.id && ACTIVE_REVIEW_RUN_STATUSES.has(run.status),
    );
    if (activeRun) {
      return summarizeRun(store, activeRun.id);
    }

    const reviewerSessionId = allocateReviewerSessionId(existingRuns, sessionPrefix);

    markSupersededReviewRuns({
      store,
      existingRuns,
      linkedSessionId: session.id,
      targetSha,
      now,
    });

    const run = store.createRun(
      {
        linkedSessionId: session.id,
        reviewerSessionId,
        status: input.status ?? "queued",
        targetSha,
        prNumber,
        prUrl,
        summary: input.summary ?? defaultReviewSummary(session, requestedBy),
      },
      now,
    );

    return {
      ...run,
      findingCount: 0,
      openFindingCount: 0,
      dismissedFindingCount: 0,
      sentFindingCount: 0,
      resolvedFindingCount: 0,
    };
  });
}

function summarizeRun(store: CodeReviewStore, runId: string): CodeReviewRunSummary {
  const run = store.listRunSummaries().find((entry) => entry.id === runId);
  if (!run) {
    throw new CodeReviewRunNotFoundError(runId);
  }
  return run;
}

function getExecutableRun(store: CodeReviewStore, runId: string, force: boolean): CodeReviewRun {
  const run = store.getRun(runId);
  if (!run) {
    throw new CodeReviewRunNotFoundError(runId);
  }

  if (run.status === "preparing" || run.status === "running") {
    throw new CodeReviewRunNotExecutableError(run);
  }

  if (!force && !["queued", "failed"].includes(run.status)) {
    throw new CodeReviewRunNotExecutableError(run);
  }

  return run;
}

export async function executeCodeReviewRun(
  {
    config,
    sessionManager,
    storeFactory = createCodeReviewStore,
    prepareWorkspace = prepareGitReviewerWorkspace,
    runReviewer,
    now = () => new Date(),
    force = false,
    registry,
  }: ExecuteCodeReviewRunOptions,
  { projectId, runId }: ExecuteCodeReviewRunInput,
): Promise<CodeReviewRunSummary> {
  const project = config.projects[projectId];
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`);
  }

  const store = storeFactory(projectId);
  const claimed = await withReviewRunExecutionLock(store, runId, async () => {
    const executableRun = getExecutableRun(store, runId, force);
    const session = await sessionManager.get(executableRun.linkedSessionId);
    if (!session) {
      throw new SessionNotFoundError(executableRun.linkedSessionId);
    }

    const startedAt = now();
    const run = store.updateRun(
      executableRun.id,
      {
        status: "preparing",
        startedAt: executableRun.startedAt ?? startedAt.toISOString(),
        completedAt: undefined,
        terminationReason: undefined,
      },
      startedAt,
    );

    return { run, session };
  });
  let run = claimed.run;
  const session = claimed.session;

  try {
    const workspacePath = await prepareWorkspace({ projectId, project, session, run });
    run = store.updateRun(
      run.id,
      { status: "running", reviewerWorkspacePath: workspacePath },
      now(),
    );
    const baseRef = session.pr?.baseBranch?.trim() || project.defaultBranch;
    const reviewer = runReviewer ?? resolveCodeReviewRunner(project);
    const result = await reviewer({ config, project, session, run, workspacePath, baseRef });
    const findings = result.findings ?? parseReviewerOutput(result.rawOutput ?? "");

    for (const finding of findings) {
      store.createFinding(
        {
          runId: run.id,
          linkedSessionId: run.linkedSessionId,
          severity: finding.severity ?? "warning",
          title: finding.title?.trim() || "Review finding",
          body: finding.body?.trim() || "Reviewer reported an issue without details.",
          filePath: finding.filePath,
          startLine: finding.startLine,
          endLine: finding.endLine,
          category: finding.category,
          confidence: finding.confidence,
          fingerprint: finding.fingerprint,
        },
        now(),
      );
    }

    const completedAt = now();
    run = store.updateRun(
      run.id,
      {
        status: findings.length > 0 ? "needs_triage" : "clean",
        completedAt: completedAt.toISOString(),
        summary: result.summary ?? run.summary,
        terminationReason: undefined,
      },
      completedAt,
    );

    await maybePostVerdictToPr({
      project,
      registry,
      session,
      store,
      run,
      findings: store.listFindings({ runId: run.id }),
      now: now(),
    });
  } catch (error) {
    const completedAt = now();
    store.updateRun(
      run.id,
      {
        status: "failed",
        completedAt: completedAt.toISOString(),
        terminationReason: error instanceof Error ? error.message : String(error),
      },
      completedAt,
    );
  }

  return summarizeRun(store, run.id);
}

export async function sendCodeReviewFindingsToAgent(
  {
    config,
    sessionManager,
    storeFactory = createCodeReviewStore,
    now = () => new Date(),
  }: SendCodeReviewFindingsOptions,
  { projectId, runId }: SendCodeReviewFindingsInput,
): Promise<SendCodeReviewFindingsResult> {
  const project = config.projects[projectId];
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`);
  }

  const store = storeFactory(projectId);
  const run = store.getRun(runId);
  if (!run) {
    throw new CodeReviewRunNotFoundError(runId);
  }

  const session = await sessionManager.get(run.linkedSessionId);
  if (!session) {
    throw new SessionNotFoundError(run.linkedSessionId);
  }

  const findings = store.listFindings({ runId: run.id, status: "open" });
  if (findings.length === 0) {
    throw new CodeReviewNoOpenFindingsError(run);
  }

  const message = formatCodeReviewFindingsForAgent({ run, findings, session });
  await sessionManager.send(session.id, message);

  const sentAt = now();
  for (const finding of findings) {
    store.updateFinding(
      finding.id,
      {
        status: "sent_to_agent",
        sentToAgentAt: sentAt.toISOString(),
      },
      sentAt,
    );
  }

  store.updateRun(run.id, { status: "waiting_update" }, sentAt);

  return {
    run: summarizeRun(store, run.id),
    sentFindingCount: findings.length,
    message,
  };
}
