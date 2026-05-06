import { existsSync } from "node:fs";
import {
  TERMINAL_STATUSES as TERMINAL_STATUSES_SET,
  type OrchestratorConfig,
  type PluginRegistry,
  type Runtime,
  type Agent,
  type Workspace,
  type RuntimeHandle,
  type SessionStatus,
  type ActivityState,
  type Session,
} from "../types.js";
import { safeJsonParse, validateStatus } from "../utils/validation.js";
import type { ScannedSession } from "./scanner.js";
import {
  DEFAULT_RECOVERY_CONFIG,
  type RecoveryAssessment,
  type RecoveryClassification,
  type RecoveryAction,
  type RecoveryConfig,
} from "./types.js";
import { resolveAgentSelection, resolveSessionRole } from "../agent-selection.js";
import { createInitialCanonicalLifecycle } from "../lifecycle-state.js";
import { createActivitySignal } from "../activity-signal.js";

function indicatesLiveAgentActivity(activity: ActivityState | null): boolean {
  return (
    activity === "active" ||
    activity === "ready" ||
    activity === "idle" ||
    activity === "waiting_input" ||
    activity === "blocked"
  );
}

export async function validateSession(
  scanned: ScannedSession,
  config: OrchestratorConfig,
  registry: PluginRegistry,
  recoveryConfigInput?: Partial<RecoveryConfig>,
): Promise<RecoveryAssessment> {
  const { sessionId, projectId, project, rawMetadata } = scanned;

  const runtimeName = project.runtime ?? config.defaults.runtime;
  const agentName = resolveAgentSelection({
    role: resolveSessionRole(
      sessionId,
      rawMetadata,
      project.sessionPrefix,
      Object.values(config.projects).map((p) => p.sessionPrefix),
    ),
    project,
    defaults: config.defaults,
    persistedAgent: rawMetadata["agent"],
  }).agentName;
  const workspaceName = project.workspace ?? config.defaults.workspace;

  const runtime = registry.get<Runtime>("runtime", runtimeName);
  const agent = registry.get<Agent>("agent", agentName);
  const workspace = registry.get<Workspace>("workspace", workspaceName);

  const workspacePath = rawMetadata["worktree"] || null;
  const runtimeHandleStr = rawMetadata["runtimeHandle"];
  const runtimeHandle = runtimeHandleStr ? safeJsonParse<RuntimeHandle>(runtimeHandleStr) : null;
  const metadataStatus = validateStatus(rawMetadata["status"]);
  const recoveryConfig: RecoveryConfig = {
    ...DEFAULT_RECOVERY_CONFIG,
    ...(recoveryConfigInput ?? {}),
  };

  let runtimeAlive = false;
  let runtimeProbeSucceeded = false;
  if (runtime && runtimeHandle) {
    try {
      runtimeAlive = await runtime.isAlive(runtimeHandle);
      runtimeProbeSucceeded = true;
    } catch {
      runtimeAlive = false;
      runtimeProbeSucceeded = false;
    }
  }

  let workspaceExists = false;
  if (workspacePath) {
    try {
      workspaceExists = existsSync(workspacePath);
    } catch {
      workspaceExists = false;
    }
    if (!workspaceExists && workspace?.exists) {
      try {
        workspaceExists = await workspace.exists(workspacePath);
      } catch {
        workspaceExists = false;
      }
    }
  }

  let agentProcessRunning = false;
  let processProbeSucceeded = false;
  let agentActivity: ActivityState | null = null;
  if (agent && runtimeHandle) {
    try {
      agentProcessRunning = await agent.isProcessRunning(runtimeHandle);
      processProbeSucceeded = true;
    } catch {
      agentProcessRunning = false;
      processProbeSucceeded = false;
    }

    try {
      const lifecycle = createInitialCanonicalLifecycle("worker");
      const probeSession: Session = {
        id: sessionId,
        projectId,
        status: metadataStatus,
        activity: null,
        activitySignal: createActivitySignal("unavailable"),
        lifecycle,
        branch: rawMetadata["branch"] ?? null,
        issueId: rawMetadata["issue"] ?? null,
        pr: null,
        workspacePath,
        runtimeHandle,
        agentInfo: null,
        createdAt: new Date(rawMetadata["createdAt"] ?? Date.now()),
        lastActivityAt: new Date(rawMetadata["lastActivityAt"] ?? Date.now()),
        metadata: rawMetadata,
      };
      const detection = await agent.getActivityState(probeSession, config.readyThresholdMs);
      agentActivity = detection?.state ?? null;
      if (!agentProcessRunning && indicatesLiveAgentActivity(agentActivity)) {
        agentProcessRunning = true;
      }
      if (agentActivity === "exited") {
        agentProcessRunning = false;
      }
    } catch {
      agentActivity = null;
    }
  }

  const metadataValid = Object.keys(rawMetadata).length > 0;
  const classification = classifySession(
    runtimeAlive,
    workspaceExists,
    agentProcessRunning,
    metadataStatus,
    runtimeProbeSucceeded,
    processProbeSucceeded,
    runtimeHandle !== null,
  );
  const signalDisagreement =
    runtimeProbeSucceeded &&
    processProbeSucceeded &&
    ((runtimeAlive && !agentProcessRunning) || (!runtimeAlive && agentProcessRunning));
  const recoveryRule = determineRecoveryRule(
    classification,
    signalDisagreement,
    metadataStatus,
    recoveryConfig,
  );
  const action = determineAction(classification, metadataStatus, recoveryConfig, recoveryRule);

  return {
    sessionId,
    projectId,
    classification,
    action,
    reason: getReason(
      classification,
      runtimeAlive,
      workspaceExists,
      agentProcessRunning,
      runtimeProbeSucceeded,
      processProbeSucceeded,
      signalDisagreement,
    ),
    runtimeProbeSucceeded,
    processProbeSucceeded,
    signalDisagreement,
    recoveryRule,
    runtimeAlive,
    runtimeHandle,
    workspaceExists,
    workspacePath,
    agentProcessRunning,
    agentActivity,
    metadataValid,
    metadataStatus,
    rawMetadata,
  };
}

function classifySession(
  runtimeAlive: boolean,
  workspaceExists: boolean,
  agentProcessRunning: boolean,
  metadataStatus: SessionStatus,
  runtimeProbeSucceeded: boolean,
  processProbeSucceeded: boolean,
  hasRuntimeHandle: boolean,
): RecoveryClassification {
  if (TERMINAL_STATUSES_SET.has(metadataStatus)) {
    return "unrecoverable";
  }

  if (runtimeAlive && workspaceExists && agentProcessRunning) {
    return "live";
  }

  if (!workspaceExists && (!hasRuntimeHandle || (runtimeProbeSucceeded && !runtimeAlive))) {
    return "dead";
  }

  if (metadataStatus === "detecting" || !runtimeProbeSucceeded || !processProbeSucceeded) {
    return "partial";
  }

  if (runtimeAlive && !workspaceExists) {
    return "partial";
  }

  if (!runtimeAlive && workspaceExists) {
    return "dead";
  }

  if (runtimeAlive && workspaceExists && !agentProcessRunning) {
    return "partial";
  }

  return "partial";
}

function determineRecoveryRule(
  classification: RecoveryClassification,
  signalDisagreement: boolean,
  metadataStatus: SessionStatus,
  recoveryConfig: RecoveryConfig = DEFAULT_RECOVERY_CONFIG,
): "auto" | "human" | "skip" {
  if (classification === "unrecoverable") return "skip";
  if (signalDisagreement) {
    return "human";
  }
  if (classification === "live" || classification === "dead") {
    return "auto";
  }
  if (metadataStatus === "detecting") {
    return "human";
  }
  if (classification === "partial") {
    return recoveryConfig.escalatePartial ? "human" : "auto";
  }
  return "human";
}

function determineAction(
  classification: RecoveryClassification,
  _metadataStatus: SessionStatus,
  recoveryConfig: RecoveryConfig,
  recoveryRule: "auto" | "human" | "skip",
): RecoveryAction {
  if (recoveryRule === "skip") {
    return "skip";
  }
  if (recoveryRule === "human") {
    return "escalate";
  }
  switch (classification) {
    case "live":
      return "recover";
    case "dead":
      return recoveryConfig.autoCleanup ? "cleanup" : "escalate";
    case "partial":
      return recoveryConfig.escalatePartial ? "escalate" : "cleanup";
    case "unrecoverable":
      return "skip";
    default:
      return "skip";
  }
}

function getReason(
  classification: RecoveryClassification,
  runtimeAlive: boolean,
  workspaceExists: boolean,
  agentProcessRunning: boolean,
  runtimeProbeSucceeded: boolean,
  processProbeSucceeded: boolean,
  signalDisagreement: boolean,
): string {
  if (!runtimeProbeSucceeded || !processProbeSucceeded) {
    return `Probe uncertainty: runtimeProbe=${runtimeProbeSucceeded}, processProbe=${processProbeSucceeded}`;
  }
  if (signalDisagreement) {
    return `Signal disagreement: runtime=${runtimeAlive}, workspace=${workspaceExists}, agent=${agentProcessRunning}`;
  }
  switch (classification) {
    case "live":
      return "Session is running normally";
    case "dead":
      return `Runtime ${runtimeAlive ? "alive" : "dead"}, workspace ${workspaceExists ? "exists" : "missing"}`;
    case "partial":
      return `Incomplete state: runtime=${runtimeAlive}, workspace=${workspaceExists}, agent=${agentProcessRunning}`;
    case "unrecoverable":
      return "Session is in terminal state";
    default:
      return "Unknown classification";
  }
}

export { classifySession, determineAction };
