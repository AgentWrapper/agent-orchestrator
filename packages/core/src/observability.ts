import {
  appendFileSync,
  statSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { OrchestratorConfig, SessionId } from "./types.js";
import { getObservabilityBaseDir } from "./paths.js";

export type ObservabilityLevel = "debug" | "info" | "warn" | "error";
export type ObservabilityOutcome = "success" | "failure";
export type ObservabilityHealthStatus = "ok" | "warn" | "error";
export type ObservabilityMetricName =
  | "api_request"
  | "claim_pr"
  | "cleanup"
  | "graphql_batch"
  | "kill"
  | "lifecycle_poll"
  | "restore"
  | "send"
  | "spawn"
  | "sse_connect"
  | "sse_disconnect"
  | "sse_snapshot"
  | "websocket_connect"
  | "websocket_disconnect"
  | "websocket_error";

export interface ObservabilityMetricCounter {
  total: number;
  success: number;
  failure: number;
  lastAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailureReason?: string;
}

export interface ObservabilityTraceRecord {
  id: string;
  timestamp: string;
  component: string;
  operation: string;
  outcome: ObservabilityOutcome;
  correlationId: string;
  projectId?: string;
  sessionId?: SessionId;
  path?: string;
  reason?: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}

export interface ObservabilitySessionStatus {
  sessionId: SessionId;
  projectId?: string;
  correlationId: string;
  operation: string;
  outcome: ObservabilityOutcome;
  updatedAt: string;
  reason?: string;
}

export interface ObservabilityHealthSurface {
  surface: string;
  status: ObservabilityHealthStatus;
  updatedAt: string;
  component: string;
  projectId?: string;
  correlationId?: string;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface ObservabilityProjectSnapshot {
  projectId: string;
  updatedAt: string;
  metrics: Record<string, ObservabilityMetricCounter>;
  health: Record<string, ObservabilityHealthSurface>;
  recentTraces: ObservabilityTraceRecord[];
  sessions: Record<string, ObservabilitySessionStatus>;
}

export interface ObservabilitySummary {
  generatedAt: string;
  overallStatus: ObservabilityHealthStatus;
  projects: Record<string, ObservabilityProjectSnapshot>;
}

interface ProcessObservabilitySnapshot {
  version: 1;
  component: string;
  pid: number;
  updatedAt: string;
  metrics: Record<string, ObservabilityMetricCounter>;
  traces: ObservabilityTraceRecord[];
  sessions: Record<string, ObservabilitySessionStatus>;
  health: Record<string, ObservabilityHealthSurface>;
}

export interface RecordOperationInput {
  metric: ObservabilityMetricName;
  operation?: string;
  outcome: ObservabilityOutcome;
  correlationId: string;
  projectId?: string;
  sessionId?: SessionId;
  reason?: string;
  durationMs?: number;
  path?: string;
  data?: Record<string, unknown>;
  level?: ObservabilityLevel;
}

export interface SetHealthInput {
  surface: string;
  status: ObservabilityHealthStatus;
  projectId?: string;
  correlationId?: string;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface ProjectObserver {
  readonly component: string;
  recordOperation(input: RecordOperationInput): void;
  recordDiagnostic?(input: {
    operation: string;
    correlationId: string;
    projectId?: string;
    sessionId?: SessionId;
    message: string;
    level?: ObservabilityLevel;
    path?: string;
    data?: Record<string, unknown>;
  }): void;
  setHealth(input: SetHealthInput): void;
}

const TRACE_LIMIT = 80;
const SESSION_LIMIT = 200;
const AUDIT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const OBSERVABILITY_ERROR_LOG_MAX_BYTES = 512 * 1024;
const MAX_REDACTED_DEPTH = 4;
const MAX_REDACTED_STRING_LENGTH = 256;
const REDACTED_VALUE = "[redacted]";
const LEVEL_ORDER: Record<ObservabilityLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeComponent(component: string): string {
  return component.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "component";
}

function getLogLevel(): ObservabilityLevel {
  const raw = process.env["AO_LOG_LEVEL"]?.trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "warn";
}

function shouldLog(level: ObservabilityLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[getLogLevel()];
}

function shouldMirrorStructuredLogsToStderr(): boolean {
  const raw = process.env["AO_OBSERVABILITY_STDERR"]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function emitStructuredLog(entry: Record<string, unknown>, level: ObservabilityLevel): void {
  if (!shouldMirrorStructuredLogsToStderr() || !shouldLog(level)) return;
  process.stderr.write(`${JSON.stringify({ ...entry, level })}\n`);
}

function atomicWriteJson(filePath: string, payload: unknown): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, filePath);
}

function getObservabilityDir(config: OrchestratorConfig): string {
  const dir = join(getObservabilityBaseDir(config.configPath), "processes");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getSnapshotPath(config: OrchestratorConfig, component: string): string {
  return join(getObservabilityDir(config), `${sanitizeComponent(component)}-${process.pid}.json`);
}

function getAuditLogPath(config: OrchestratorConfig, component: string): string {
  return join(getObservabilityDir(config), `${sanitizeComponent(component)}-${process.pid}.ndjson`);
}

function shouldRedactKey(key: string): boolean {
  return /token|secret|password|cookie|authorization|api[-_]?key|prompt|message|note/i.test(
    key,
  );
}

function sanitizeString(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_REDACTED_STRING_LENGTH
    ? `${collapsed.slice(0, MAX_REDACTED_STRING_LENGTH)}…`
    : collapsed;
}

function sanitizeUnknown(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_REDACTED_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((entry) => sanitizeUnknown(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 25).map(([key, entry]) => [
        key,
        shouldRedactKey(key) ? REDACTED_VALUE : sanitizeUnknown(entry, depth + 1),
      ]),
    );
  }
  return String(value);
}

function sanitizeDataRecord(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined;
  return sanitizeUnknown(data) as Record<string, unknown>;
}

function sanitizeReason(reason?: string): string | undefined {
  if (!reason) return undefined;
  return sanitizeString(reason);
}

function sanitizePath(path?: string): string | undefined {
  if (!path) return undefined;
  return sanitizeString(path);
}

function appendRotatingNdjson(filePath: string, payload: Record<string, unknown>, maxBytes: number): void {
  const rotatedPath = `${filePath}.1`;
  if (existsSync(filePath)) {
    const currentSize = statSync(filePath).size;
    if (currentSize >= maxBytes) {
      if (existsSync(rotatedPath)) {
        unlinkSync(rotatedPath);
      }
      renameSync(filePath, rotatedPath);
    }
  }
  appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf-8");
}

function appendAuditLog(
  config: OrchestratorConfig,
  component: string,
  payload: Record<string, unknown>,
  level: ObservabilityLevel,
): void {
  const filePath = getAuditLogPath(config, component);
  appendRotatingNdjson(filePath, { ...payload, level }, AUDIT_LOG_MAX_BYTES);
}

function appendObservabilityFailure(
  config: OrchestratorConfig,
  payload: Record<string, unknown>,
): void {
  try {
    const filePath = join(getObservabilityDir(config), "observability-errors.ndjson");
    appendRotatingNdjson(filePath, payload, OBSERVABILITY_ERROR_LOG_MAX_BYTES);
  } catch {
    // Best effort only — avoid recursive observability failures.
  }
}

function readSnapshot(filePath: string, component: string): ProcessObservabilitySnapshot {
  if (!existsSync(filePath)) {
    return {
      version: 1,
      component,
      pid: process.pid,
      updatedAt: nowIso(),
      metrics: {},
      traces: [],
      sessions: {},
      health: {},
    };
  }

  try {
    const parsed = JSON.parse(
      readFileSync(filePath, "utf-8"),
    ) as Partial<ProcessObservabilitySnapshot>;
    return {
      version: 1,
      component,
      pid: process.pid,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
      metrics: parsed.metrics && typeof parsed.metrics === "object" ? parsed.metrics : {},
      traces: Array.isArray(parsed.traces) ? parsed.traces : [],
      sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
      health: parsed.health && typeof parsed.health === "object" ? parsed.health : {},
    };
  } catch {
    return {
      version: 1,
      component,
      pid: process.pid,
      updatedAt: nowIso(),
      metrics: {},
      traces: [],
      sessions: {},
      health: {},
    };
  }
}

function writeSnapshot(config: OrchestratorConfig, snapshot: ProcessObservabilitySnapshot): void {
  const filePath = getSnapshotPath(config, snapshot.component);
  snapshot.updatedAt = nowIso();
  atomicWriteJson(filePath, snapshot);
}

function compareIsoDesc(a: string, b: string): number {
  return b.localeCompare(a);
}

function mergeCounter(
  target: ObservabilityMetricCounter | undefined,
  source: ObservabilityMetricCounter,
): ObservabilityMetricCounter {
  const merged: ObservabilityMetricCounter = {
    total: (target?.total ?? 0) + (source.total ?? 0),
    success: (target?.success ?? 0) + (source.success ?? 0),
    failure: (target?.failure ?? 0) + (source.failure ?? 0),
    lastAt: target?.lastAt,
    lastSuccessAt: target?.lastSuccessAt,
    lastFailureAt: target?.lastFailureAt,
    lastFailureReason: target?.lastFailureReason,
  };

  if (source.lastAt && (!merged.lastAt || source.lastAt > merged.lastAt)) {
    merged.lastAt = source.lastAt;
  }
  if (
    source.lastSuccessAt &&
    (!merged.lastSuccessAt || source.lastSuccessAt > merged.lastSuccessAt)
  ) {
    merged.lastSuccessAt = source.lastSuccessAt;
  }
  if (
    source.lastFailureAt &&
    (!merged.lastFailureAt || source.lastFailureAt > merged.lastFailureAt)
  ) {
    merged.lastFailureAt = source.lastFailureAt;
    merged.lastFailureReason = source.lastFailureReason;
  }

  return merged;
}

function healthSeverity(status: ObservabilityHealthStatus): number {
  switch (status) {
    case "error":
      return 3;
    case "warn":
      return 2;
    default:
      return 1;
  }
}

function metricBucketKey(metric: ObservabilityMetricName, projectId?: string): string {
  return `${projectId ?? "unknown"}::${metric}`;
}

function parseMetricBucketKey(bucketKey: string): { projectId?: string; metric: string } {
  const separatorIndex = bucketKey.indexOf("::");
  if (separatorIndex === -1) {
    return { metric: bucketKey };
  }
  const projectId = bucketKey.slice(0, separatorIndex);
  return {
    projectId: projectId === "unknown" ? undefined : projectId,
    metric: bucketKey.slice(separatorIndex + 2),
  };
}

export function createCorrelationId(prefix = "ao"): string {
  return `${prefix}-${randomUUID()}`;
}

export function createProjectObserver(
  config: OrchestratorConfig,
  component: string,
): ProjectObserver {
  const normalizedComponent = sanitizeComponent(component);

  function updateSnapshot(
    updater: (snapshot: ProcessObservabilitySnapshot) => void,
    logEntry?: { level: ObservabilityLevel; payload: Record<string, unknown> },
  ): void {
    try {
      const filePath = getSnapshotPath(config, normalizedComponent);
      const snapshot = readSnapshot(filePath, normalizedComponent);
      updater(snapshot);
      writeSnapshot(config, snapshot);
      if (logEntry && shouldLog(logEntry.level)) {
        appendAuditLog(config, normalizedComponent, logEntry.payload, logEntry.level);
        emitStructuredLog(logEntry.payload, logEntry.level);
      }
    } catch (error) {
      const payload = {
        source: "ao-observability",
        timestamp: nowIso(),
        component: normalizedComponent,
        outcome: "failure",
        operation: "observability.write",
        reason: error instanceof Error ? error.message : String(error),
      };
      appendObservabilityFailure(config, payload);
      emitStructuredLog(payload, "error");
    }
  }

  return {
    component: normalizedComponent,
    recordOperation(input) {
      const timestamp = nowIso();
      const operation = input.operation ?? input.metric;
      const level = input.level ?? (input.outcome === "failure" ? "error" : "info");
      const trace: ObservabilityTraceRecord = {
        id: randomUUID(),
        timestamp,
        component: normalizedComponent,
        operation,
        outcome: input.outcome,
        correlationId: input.correlationId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        path: sanitizePath(input.path),
        reason: sanitizeReason(input.reason),
        durationMs: input.durationMs,
        data: sanitizeDataRecord(input.data),
      };

      updateSnapshot(
        (snapshot) => {
          const bucketKey = metricBucketKey(input.metric, input.projectId);
          const currentCounter = snapshot.metrics[bucketKey] ?? {
            total: 0,
            success: 0,
            failure: 0,
          };
          currentCounter.total += 1;
          currentCounter.lastAt = timestamp;
          if (input.outcome === "success") {
            currentCounter.success += 1;
            currentCounter.lastSuccessAt = timestamp;
          } else {
            currentCounter.failure += 1;
            currentCounter.lastFailureAt = timestamp;
            currentCounter.lastFailureReason = sanitizeReason(input.reason);
          }
          snapshot.metrics[bucketKey] = currentCounter;

          snapshot.traces = [trace, ...snapshot.traces]
            .sort((a, b) => compareIsoDesc(a.timestamp, b.timestamp))
            .slice(0, TRACE_LIMIT);

          if (input.sessionId) {
            snapshot.sessions[input.sessionId] = {
              sessionId: input.sessionId,
              projectId: input.projectId,
              correlationId: input.correlationId,
              operation,
              outcome: input.outcome,
              updatedAt: timestamp,
              reason: sanitizeReason(input.reason),
            };

            const sessionEntries = Object.entries(snapshot.sessions).sort(([, a], [, b]) =>
              compareIsoDesc(a.updatedAt, b.updatedAt),
            );
            snapshot.sessions = Object.fromEntries(sessionEntries.slice(0, SESSION_LIMIT));
          }
        },
        {
          level,
          payload: {
            source: "ao-observability",
            timestamp,
            component: normalizedComponent,
            metric: input.metric,
            operation,
            outcome: input.outcome,
            correlationId: input.correlationId,
            projectId: input.projectId,
            sessionId: input.sessionId,
            reason: sanitizeReason(input.reason),
            durationMs: input.durationMs,
            path: sanitizePath(input.path),
            data: sanitizeDataRecord(input.data),
          },
        },
      );
    },

    recordDiagnostic(input) {
      const timestamp = nowIso();
      const level = input.level ?? "info";
      const trace: ObservabilityTraceRecord = {
        id: randomUUID(),
        timestamp,
        component: normalizedComponent,
        operation: input.operation,
        outcome: "success",
        correlationId: input.correlationId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        path: sanitizePath(input.path),
        data: {
          message: sanitizeString(input.message),
          ...sanitizeDataRecord(input.data),
        },
      };

      updateSnapshot(
        (snapshot) => {
          snapshot.traces = [trace, ...snapshot.traces]
            .sort((a, b) => compareIsoDesc(a.timestamp, b.timestamp))
            .slice(0, TRACE_LIMIT);

          if (input.sessionId) {
            snapshot.sessions[input.sessionId] = {
              sessionId: input.sessionId,
              projectId: input.projectId,
              correlationId: input.correlationId,
              operation: input.operation,
              outcome: "success",
              updatedAt: timestamp,
            };

            const sessionEntries = Object.entries(snapshot.sessions).sort(([, a], [, b]) =>
              compareIsoDesc(a.updatedAt, b.updatedAt),
            );
            snapshot.sessions = Object.fromEntries(sessionEntries.slice(0, SESSION_LIMIT));
          }
        },
        {
          level,
          payload: {
            source: "ao-observability",
            timestamp,
            component: normalizedComponent,
            operation: input.operation,
            correlationId: input.correlationId,
            projectId: input.projectId,
            sessionId: input.sessionId,
            path: sanitizePath(input.path),
            data: {
              message: sanitizeString(input.message),
              ...sanitizeDataRecord(input.data),
            },
          },
        },
      );
    },

    setHealth(input) {
      const updatedAt = nowIso();
      updateSnapshot(
        (snapshot) => {
          snapshot.health[input.surface] = {
            surface: input.surface,
            status: input.status,
            updatedAt,
            component: normalizedComponent,
            projectId: input.projectId,
            correlationId: input.correlationId,
            reason: sanitizeReason(input.reason),
            details: sanitizeDataRecord(input.details),
          };
        },
        {
          level: input.status === "error" ? "error" : input.status === "warn" ? "warn" : "info",
          payload: {
            source: "ao-observability",
            timestamp: updatedAt,
            component: normalizedComponent,
            surface: input.surface,
            status: input.status,
            projectId: input.projectId,
            correlationId: input.correlationId,
            reason: sanitizeReason(input.reason),
            details: sanitizeDataRecord(input.details),
          },
        },
      );
    },
  };
}

export function readObservabilitySummary(config: OrchestratorConfig): ObservabilitySummary {
  const dir = getObservabilityDir(config);
  const projects: Record<string, ObservabilityProjectSnapshot> = {};

  for (const fileName of readdirSync(dir)) {
    if (!fileName.endsWith(".json")) continue;
    const filePath = join(dir, fileName);

    let snapshot: ProcessObservabilitySnapshot;
    try {
      snapshot = JSON.parse(readFileSync(filePath, "utf-8")) as ProcessObservabilitySnapshot;
    } catch {
      continue;
    }

    if (!snapshot || typeof snapshot !== "object") continue;

    for (const [bucketKey, counter] of Object.entries(snapshot.metrics ?? {})) {
      const { projectId, metric } = parseMetricBucketKey(bucketKey);
      if (!projectId) continue;
      const project =
        projects[projectId] ??
        (projects[projectId] = {
          projectId,
          updatedAt: snapshot.updatedAt,
          metrics: {},
          health: {},
          recentTraces: [],
          sessions: {},
        });
      project.metrics[metric] = mergeCounter(project.metrics[metric], counter);
      if (snapshot.updatedAt > project.updatedAt) {
        project.updatedAt = snapshot.updatedAt;
      }
    }

    for (const trace of snapshot.traces ?? []) {
      if (!trace.projectId) continue;
      const project =
        projects[trace.projectId] ??
        (projects[trace.projectId] = {
          projectId: trace.projectId,
          updatedAt: trace.timestamp,
          metrics: {},
          health: {},
          recentTraces: [],
          sessions: {},
        });
      project.recentTraces.push(trace);
      if (trace.timestamp > project.updatedAt) {
        project.updatedAt = trace.timestamp;
      }
    }

    for (const health of Object.values(snapshot.health ?? {})) {
      const projectId = health.projectId;
      if (!projectId) continue;
      const project =
        projects[projectId] ??
        (projects[projectId] = {
          projectId,
          updatedAt: health.updatedAt,
          metrics: {},
          health: {},
          recentTraces: [],
          sessions: {},
        });
      const existing = project.health[health.surface];
      if (!existing || health.updatedAt >= existing.updatedAt) {
        project.health[health.surface] = health;
      }
      if (health.updatedAt > project.updatedAt) {
        project.updatedAt = health.updatedAt;
      }
    }

    for (const session of Object.values(snapshot.sessions ?? {})) {
      if (!session.projectId) continue;
      const project =
        projects[session.projectId] ??
        (projects[session.projectId] = {
          projectId: session.projectId,
          updatedAt: session.updatedAt,
          metrics: {},
          health: {},
          recentTraces: [],
          sessions: {},
        });
      const existing = project.sessions[session.sessionId];
      if (!existing || session.updatedAt >= existing.updatedAt) {
        project.sessions[session.sessionId] = session;
      }
      if (session.updatedAt > project.updatedAt) {
        project.updatedAt = session.updatedAt;
      }
    }
  }

  let overallStatus: ObservabilityHealthStatus = "ok";
  for (const project of Object.values(projects)) {
    project.recentTraces = project.recentTraces
      .sort((a, b) => compareIsoDesc(a.timestamp, b.timestamp))
      .slice(0, TRACE_LIMIT);
    for (const health of Object.values(project.health)) {
      if (healthSeverity(health.status) > healthSeverity(overallStatus)) {
        overallStatus = health.status;
      }
    }
  }

  return {
    generatedAt: nowIso(),
    overallStatus,
    projects,
  };
}
