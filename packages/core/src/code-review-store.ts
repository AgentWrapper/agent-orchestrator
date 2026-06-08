import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { getProjectCodeReviewsDir } from "./paths.js";

export type CodeReviewRunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "needs_triage"
  | "sent_to_agent"
  | "waiting_update"
  | "clean"
  | "outdated"
  | "failed"
  | "cancelled";

export type CodeReviewFindingStatus = "open" | "dismissed" | "sent_to_agent" | "resolved";

export type CodeReviewSeverity = "info" | "warning" | "error";

export interface CodeReviewRun {
  id: string;
  projectId: string;
  linkedSessionId: string;
  reviewerSessionId: string;
  status: CodeReviewRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  targetSha?: string;
  baseSha?: string;
  prNumber?: number;
  prUrl?: string;
  reviewerWorkspacePath?: string;
  summary?: string;
  terminationReason?: string;
}

export interface CodeReviewFinding {
  id: string;
  projectId: string;
  runId: string;
  linkedSessionId: string;
  status: CodeReviewFindingStatus;
  severity: CodeReviewSeverity;
  title: string;
  body: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  category?: string;
  confidence?: number;
  fingerprint?: string;
  createdAt: string;
  updatedAt: string;
  dismissedAt?: string;
  dismissedBy?: string;
  sentToAgentAt?: string;
}

export interface CodeReviewRunSummary extends CodeReviewRun {
  findingCount: number;
  openFindingCount: number;
  dismissedFindingCount: number;
  sentFindingCount: number;
  resolvedFindingCount: number;
}

export interface CodeReviewStoreOptions {
  /** Override storage dir for tests. Defaults to the project code review store path. */
  storeDir?: string;
}

export interface ListCodeReviewRunsFilter {
  linkedSessionId?: string;
  status?: CodeReviewRunStatus;
}

export interface ListCodeReviewFindingsFilter {
  runId?: string;
  linkedSessionId?: string;
  status?: CodeReviewFindingStatus;
}

export interface CreateCodeReviewRunInput {
  linkedSessionId: string;
  reviewerSessionId: string;
  status?: CodeReviewRunStatus;
  targetSha?: string;
  baseSha?: string;
  prNumber?: number;
  prUrl?: string;
  reviewerWorkspacePath?: string;
  summary?: string;
}

export interface CreateCodeReviewFindingInput {
  runId: string;
  linkedSessionId: string;
  severity: CodeReviewSeverity;
  title: string;
  body: string;
  status?: CodeReviewFindingStatus;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  category?: string;
  confidence?: number;
  fingerprint?: string;
}

const REVIEW_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function assertSafeReviewId(id: string, label: string): void {
  if (!id || id === "." || id === ".." || !REVIEW_ID_PATTERN.test(id)) {
    throw new Error(`Unsafe ${label}: "${id}"`);
  }
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function parseRunStatus(value: unknown): CodeReviewRunStatus {
  switch (value) {
    case "queued":
    case "preparing":
    case "running":
    case "needs_triage":
    case "sent_to_agent":
    case "waiting_update":
    case "clean":
    case "outdated":
    case "failed":
    case "cancelled":
      return value;
    default:
      return "queued";
  }
}

function parseFindingStatus(value: unknown): CodeReviewFindingStatus {
  switch (value) {
    case "dismissed":
    case "sent_to_agent":
    case "resolved":
      return value;
    case "open":
    default:
      return "open";
  }
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

function readJsonFile(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}

function compareUpdatedDesc(
  a: { updatedAt: string; createdAt: string; id: string },
  b: { updatedAt: string; createdAt: string; id: string },
): number {
  return (
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
    Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

function parseRun(projectId: string, value: unknown): CodeReviewRun | null {
  if (!isRecord(value)) return null;
  const id = parseOptionalString(value["id"]);
  const linkedSessionId = parseOptionalString(value["linkedSessionId"]);
  const reviewerSessionId = parseOptionalString(value["reviewerSessionId"]);
  const createdAt = normalizeIsoTimestamp(value["createdAt"]);
  const updatedAt = normalizeIsoTimestamp(value["updatedAt"]) ?? createdAt;
  if (!id || !linkedSessionId || !reviewerSessionId || !createdAt || !updatedAt) return null;

  return removeUndefined({
    id,
    projectId: parseOptionalString(value["projectId"]) ?? projectId,
    linkedSessionId,
    reviewerSessionId,
    status: parseRunStatus(value["status"]),
    createdAt,
    updatedAt,
    startedAt: normalizeIsoTimestamp(value["startedAt"]),
    completedAt: normalizeIsoTimestamp(value["completedAt"]),
    targetSha: parseOptionalString(value["targetSha"]),
    baseSha: parseOptionalString(value["baseSha"]),
    prNumber: parseNumber(value["prNumber"]),
    prUrl: parseOptionalString(value["prUrl"]),
    reviewerWorkspacePath: parseOptionalString(value["reviewerWorkspacePath"]),
    summary: parseOptionalString(value["summary"]),
    terminationReason: parseOptionalString(value["terminationReason"]),
  });
}

function parseFinding(projectId: string, value: unknown): CodeReviewFinding | null {
  if (!isRecord(value)) return null;
  const id = parseOptionalString(value["id"]);
  const runId = parseOptionalString(value["runId"]);
  const linkedSessionId = parseOptionalString(value["linkedSessionId"]);
  const title = parseOptionalString(value["title"]);
  const body = parseOptionalString(value["body"]);
  const createdAt = normalizeIsoTimestamp(value["createdAt"]);
  const updatedAt = normalizeIsoTimestamp(value["updatedAt"]) ?? createdAt;
  if (!id || !runId || !linkedSessionId || !title || !body || !createdAt || !updatedAt) {
    return null;
  }

  return removeUndefined({
    id,
    projectId: parseOptionalString(value["projectId"]) ?? projectId,
    runId,
    linkedSessionId,
    status: parseFindingStatus(value["status"]),
    severity: parseSeverity(value["severity"]),
    title,
    body,
    filePath: parseOptionalString(value["filePath"]),
    startLine: parseNumber(value["startLine"]),
    endLine: parseNumber(value["endLine"]),
    category: parseOptionalString(value["category"]),
    confidence: parseNumber(value["confidence"]),
    fingerprint: parseOptionalString(value["fingerprint"]),
    createdAt,
    updatedAt,
    dismissedAt: normalizeIsoTimestamp(value["dismissedAt"]),
    dismissedBy: parseOptionalString(value["dismissedBy"]),
    sentToAgentAt: normalizeIsoTimestamp(value["sentToAgentAt"]),
  });
}

export class CodeReviewStore {
  readonly projectId: string;
  readonly storeDir: string;

  constructor(projectId: string, options: CodeReviewStoreOptions = {}) {
    this.projectId = projectId;
    this.storeDir = options.storeDir ?? getProjectCodeReviewsDir(projectId);
  }

  get runsDir(): string {
    return join(this.storeDir, "runs");
  }

  get findingsDir(): string {
    return join(this.storeDir, "findings");
  }

  ensure(): void {
    mkdirSync(this.runsDir, { recursive: true });
    mkdirSync(this.findingsDir, { recursive: true });
  }

  listRuns(filter: ListCodeReviewRunsFilter = {}): CodeReviewRun[] {
    return this.readAllRuns()
      .filter((run) => !filter.linkedSessionId || run.linkedSessionId === filter.linkedSessionId)
      .filter((run) => !filter.status || run.status === filter.status)
      .sort(compareUpdatedDesc);
  }

  listRunSummaries(filter: ListCodeReviewRunsFilter = {}): CodeReviewRunSummary[] {
    const findings = this.listFindings();
    const countsByRun = new Map<string, Omit<CodeReviewRunSummary, keyof CodeReviewRun>>();

    for (const finding of findings) {
      const counts = countsByRun.get(finding.runId) ?? {
        findingCount: 0,
        openFindingCount: 0,
        dismissedFindingCount: 0,
        sentFindingCount: 0,
        resolvedFindingCount: 0,
      };
      counts.findingCount++;
      if (finding.status === "open") counts.openFindingCount++;
      if (finding.status === "dismissed") counts.dismissedFindingCount++;
      if (finding.status === "sent_to_agent") counts.sentFindingCount++;
      if (finding.status === "resolved") counts.resolvedFindingCount++;
      countsByRun.set(finding.runId, counts);
    }

    return this.listRuns(filter).map((run) => ({
      ...run,
      ...(countsByRun.get(run.id) ?? {
        findingCount: 0,
        openFindingCount: 0,
        dismissedFindingCount: 0,
        sentFindingCount: 0,
        resolvedFindingCount: 0,
      }),
    }));
  }

  getRun(runId: string): CodeReviewRun | null {
    assertSafeReviewId(runId, "review run id");
    return parseRun(this.projectId, readJsonFile(this.runPath(runId)));
  }

  createRun(input: CreateCodeReviewRunInput, now = new Date()): CodeReviewRun {
    const id = `review-run-${randomUUID()}`;
    const timestamp = now.toISOString();
    const run: CodeReviewRun = removeUndefined({
      id,
      projectId: this.projectId,
      linkedSessionId: input.linkedSessionId,
      reviewerSessionId: input.reviewerSessionId,
      status: input.status ?? "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: input.status === "running" ? timestamp : undefined,
      targetSha: input.targetSha,
      baseSha: input.baseSha,
      prNumber: input.prNumber,
      prUrl: input.prUrl,
      reviewerWorkspacePath: input.reviewerWorkspacePath,
      summary: input.summary,
    });
    this.writeRun(run);
    return run;
  }

  updateRun(
    runId: string,
    patch: Partial<Omit<CodeReviewRun, "id" | "projectId" | "createdAt">>,
    now = new Date(),
  ): CodeReviewRun {
    const existing = this.getRun(runId);
    if (!existing) {
      throw new Error(`Code review run not found: ${runId}`);
    }
    const next = removeUndefined({
      ...existing,
      ...patch,
      id: existing.id,
      projectId: existing.projectId,
      createdAt: existing.createdAt,
      updatedAt: now.toISOString(),
    });
    this.writeRun(next);
    return next;
  }

  listFindings(filter: ListCodeReviewFindingsFilter = {}): CodeReviewFinding[] {
    return this.readAllFindings()
      .filter((finding) => !filter.runId || finding.runId === filter.runId)
      .filter(
        (finding) => !filter.linkedSessionId || finding.linkedSessionId === filter.linkedSessionId,
      )
      .filter((finding) => !filter.status || finding.status === filter.status)
      .sort(compareUpdatedDesc);
  }

  getFinding(findingId: string): CodeReviewFinding | null {
    assertSafeReviewId(findingId, "review finding id");
    return parseFinding(this.projectId, readJsonFile(this.findingPath(findingId)));
  }

  createFinding(input: CreateCodeReviewFindingInput, now = new Date()): CodeReviewFinding {
    if (!this.getRun(input.runId)) {
      throw new Error(`Code review run not found: ${input.runId}`);
    }
    const id = `review-finding-${randomUUID()}`;
    const timestamp = now.toISOString();
    const finding: CodeReviewFinding = removeUndefined({
      id,
      projectId: this.projectId,
      runId: input.runId,
      linkedSessionId: input.linkedSessionId,
      status: input.status ?? "open",
      severity: input.severity,
      title: input.title,
      body: input.body,
      filePath: input.filePath,
      startLine: input.startLine,
      endLine: input.endLine,
      category: input.category,
      confidence: input.confidence,
      fingerprint: input.fingerprint,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.writeFinding(finding);
    return finding;
  }

  updateFinding(
    findingId: string,
    patch: Partial<
      Omit<CodeReviewFinding, "id" | "projectId" | "runId" | "linkedSessionId" | "createdAt">
    >,
    now = new Date(),
  ): CodeReviewFinding {
    const existing = this.getFinding(findingId);
    if (!existing) {
      throw new Error(`Code review finding not found: ${findingId}`);
    }
    const next = removeUndefined({
      ...existing,
      ...patch,
      id: existing.id,
      projectId: existing.projectId,
      runId: existing.runId,
      linkedSessionId: existing.linkedSessionId,
      createdAt: existing.createdAt,
      updatedAt: now.toISOString(),
    });
    this.writeFinding(next);
    return next;
  }

  deleteAll(): void {
    rmSync(this.storeDir, { recursive: true, force: true });
  }

  private runPath(runId: string): string {
    assertSafeReviewId(runId, "review run id");
    return join(this.runsDir, `${runId}.json`);
  }

  private findingPath(findingId: string): string {
    assertSafeReviewId(findingId, "review finding id");
    return join(this.findingsDir, `${findingId}.json`);
  }

  private writeRun(run: CodeReviewRun): void {
    this.ensure();
    writeJsonFile(this.runPath(run.id), run);
  }

  private writeFinding(finding: CodeReviewFinding): void {
    this.ensure();
    writeJsonFile(this.findingPath(finding.id), finding);
  }

  private readAllRuns(): CodeReviewRun[] {
    return this.readAllJsonFiles(this.runsDir)
      .map((value) => parseRun(this.projectId, value))
      .filter((run): run is CodeReviewRun => run !== null);
  }

  private readAllFindings(): CodeReviewFinding[] {
    return this.readAllJsonFiles(this.findingsDir)
      .map((value) => parseFinding(this.projectId, value))
      .filter((finding): finding is CodeReviewFinding => finding !== null);
  }

  private readAllJsonFiles(dir: string): unknown[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJsonFile(join(dir, entry.name)))
      .filter((value) => value !== null);
  }
}

export function createCodeReviewStore(
  projectId: string,
  options: CodeReviewStoreOptions = {},
): CodeReviewStore {
  return new CodeReviewStore(projectId, options);
}
