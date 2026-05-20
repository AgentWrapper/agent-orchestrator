import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  createProjectObserver,
  getObservabilityBaseDir,
  readObservabilitySummary,
  type OrchestratorConfig,
} from "../index.js";

let tempRoot: string;
let configPath: string;
let config: OrchestratorConfig;

beforeEach(() => {
  tempRoot = join(tmpdir(), `ao-observability-test-${randomUUID()}`);
  mkdirSync(tempRoot, { recursive: true });
  configPath = join(tempRoot, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n", "utf-8");

  config = {
    configPath,
    port: 3000,
    readyThresholdMs: 300_000,
    power: { preventIdleSleep: false },
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: [],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "acme/my-app",
        path: join(tempRoot, "my-app"),
        defaultBranch: "main",
        sessionPrefix: "app",
      },
    },
    notifiers: {},
    notificationRouting: {
      urgent: [],
      action: [],
      warning: [],
      info: [],
    },
    reactions: {},
  };
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("observability snapshot", () => {
  it("records counters, traces, and session status", () => {
    const observer = createProjectObserver(config, "session-manager");

    observer.recordOperation({
      metric: "spawn",
      operation: "session.spawn",
      outcome: "success",
      correlationId: "corr-1",
      projectId: "my-app",
      sessionId: "app-1",
      data: { issueId: "INT-1" },
      level: "info",
    });

    observer.recordOperation({
      metric: "send",
      operation: "session.send",
      outcome: "failure",
      correlationId: "corr-2",
      projectId: "my-app",
      sessionId: "app-1",
      reason: "runtime unavailable",
      level: "error",
    });

    observer.setHealth({
      surface: "lifecycle.worker",
      status: "warn",
      projectId: "my-app",
      correlationId: "corr-3",
      reason: "poll delayed",
      details: { projectId: "my-app" },
    });

    const summary = readObservabilitySummary(config);
    const project = summary.projects["my-app"];

    expect(project).toBeDefined();
    expect(project.metrics["spawn"]?.total).toBe(1);
    expect(project.metrics["spawn"]?.success).toBe(1);
    expect(project.metrics["send"]?.failure).toBe(1);
    expect(project.sessions["app-1"]?.operation).toBe("session.send");
    expect(project.recentTraces.some((trace) => trace.operation === "session.spawn")).toBe(true);
    expect(project.health["lifecycle.worker"]?.status).toBe("warn");
    expect(summary.overallStatus).toBe("warn");
  });

  it("writes observability diagnostics to audit files without mirroring to stderr by default", () => {
    const originalObservabilityStderr = process.env["AO_OBSERVABILITY_STDERR"];
    delete process.env["AO_OBSERVABILITY_STDERR"];

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    try {
      const observer = createProjectObserver(config, "session-manager");

      observer.recordOperation({
        metric: "spawn",
        operation: "session.spawn",
        outcome: "success",
        correlationId: "corr-1",
        projectId: "my-app",
        sessionId: "app-1",
        level: "warn",
      });

      observer.recordDiagnostic?.({
        operation: "batch_enrichment.log",
        correlationId: "corr-2",
        projectId: "my-app",
        message: "GraphQL batch returned cached result",
        level: "warn",
        data: { plugin: "github" },
      });

      observer.setHealth({
        surface: "lifecycle.worker",
        status: "warn",
        projectId: "my-app",
        correlationId: "corr-3",
        details: { projectId: "my-app" },
      });

      const auditDir = join(getObservabilityBaseDir(config.configPath), "processes");
      const auditFiles = readdirSync(auditDir).filter((fileName) => fileName.endsWith(".ndjson"));
      expect(auditFiles.length).toBeGreaterThan(0);

      const auditLog = readFileSync(join(auditDir, auditFiles[0]!), "utf-8");
      expect(auditLog).toContain('"operation":"session.spawn"');
      expect(auditLog).toContain('"operation":"batch_enrichment.log"');
      expect(auditLog).toContain('"message":"GraphQL batch returned cached result"');
      expect(auditLog).toContain('"timestamp"');
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
      if (originalObservabilityStderr === undefined) {
        delete process.env["AO_OBSERVABILITY_STDERR"];
      } else {
        process.env["AO_OBSERVABILITY_STDERR"] = originalObservabilityStderr;
      }
    }
  });

  it("uses YAML observability log level and stderr settings", () => {
    const originalLogLevel = process.env["AO_LOG_LEVEL"];
    const originalObservabilityStderr = process.env["AO_OBSERVABILITY_STDERR"];
    delete process.env["AO_LOG_LEVEL"];
    delete process.env["AO_OBSERVABILITY_STDERR"];
    config.observability = { logLevel: "warn", stderr: true };

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    try {
      const observer = createProjectObserver(config, "session-manager");
      observer.recordOperation({
        metric: "spawn",
        operation: "notification.success-no-audit",
        outcome: "success",
        correlationId: "corr-info",
        projectId: "my-app",
        level: "info",
      });
      observer.recordOperation({
        metric: "notification_delivery",
        operation: "notification.deliver",
        outcome: "failure",
        correlationId: "corr-warn",
        projectId: "my-app",
        sessionId: "app-1",
        reason: "notifier target not found",
        level: "warn",
      });

      const auditDir = join(getObservabilityBaseDir(config.configPath), "processes");
      const auditFiles = readdirSync(auditDir).filter((fileName) => fileName.endsWith(".ndjson"));
      const auditLog = auditFiles
        .map((fileName) => readFileSync(join(auditDir, fileName), "utf-8"))
        .join("\n");

      expect(auditLog).toContain('"operation":"notification.deliver"');
      expect(auditLog).not.toContain("notification.success-no-audit");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(String(stderrSpy.mock.calls[0]?.[0])).toContain('"operation":"notification.deliver"');
    } finally {
      stderrSpy.mockRestore();
      if (originalLogLevel === undefined) {
        delete process.env["AO_LOG_LEVEL"];
      } else {
        process.env["AO_LOG_LEVEL"] = originalLogLevel;
      }
      if (originalObservabilityStderr === undefined) {
        delete process.env["AO_OBSERVABILITY_STDERR"];
      } else {
        process.env["AO_OBSERVABILITY_STDERR"] = originalObservabilityStderr;
      }
    }
  });

  it("lets observability env vars override YAML settings", () => {
    const originalLogLevel = process.env["AO_LOG_LEVEL"];
    const originalObservabilityStderr = process.env["AO_OBSERVABILITY_STDERR"];
    process.env["AO_LOG_LEVEL"] = "info";
    process.env["AO_OBSERVABILITY_STDERR"] = "0";
    config.observability = { logLevel: "error", stderr: true };

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    try {
      const observer = createProjectObserver(config, "session-manager");
      observer.recordOperation({
        metric: "notification_delivery",
        operation: "notification.deliver",
        outcome: "success",
        correlationId: "corr-env",
        projectId: "my-app",
        sessionId: "app-1",
        level: "info",
      });

      const auditDir = join(getObservabilityBaseDir(config.configPath), "processes");
      const auditFiles = readdirSync(auditDir).filter((fileName) => fileName.endsWith(".ndjson"));
      const auditLog = auditFiles
        .map((fileName) => readFileSync(join(auditDir, fileName), "utf-8"))
        .join("\n");

      expect(auditLog).toContain('"operation":"notification.deliver"');
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
      if (originalLogLevel === undefined) {
        delete process.env["AO_LOG_LEVEL"];
      } else {
        process.env["AO_LOG_LEVEL"] = originalLogLevel;
      }
      if (originalObservabilityStderr === undefined) {
        delete process.env["AO_OBSERVABILITY_STDERR"];
      } else {
        process.env["AO_OBSERVABILITY_STDERR"] = originalObservabilityStderr;
      }
    }
  });

  it("redacts sensitive observability payload fields before persisting them", () => {
    const observer = createProjectObserver(config, "session-manager");

    observer.recordOperation({
      metric: "send",
      operation: "session.send",
      outcome: "failure",
      correlationId: "corr-redact",
      projectId: "my-app",
      sessionId: "app-1",
      reason: "Authorization token abc123 failed validation",
      data: {
        token: "abc123",
        prompt: "ship it",
        nested: {
          password: "s3cr3t",
          detail: "safe detail",
        },
      },
      level: "error",
    });

    const summary = readObservabilitySummary(config);
    const trace = summary.projects["my-app"]?.recentTraces.find(
      (entry) => entry.operation === "session.send",
    );

    expect(trace).toBeDefined();
    expect(trace?.reason).toContain("Authorization token abc123 failed validation");
    expect(trace?.data).toEqual({
      token: "[redacted]",
      prompt: "[redacted]",
      nested: {
        password: "[redacted]",
        detail: "safe detail",
      },
    });
  });
});
