import type {
  CanonicalSessionLifecycle,
  OrchestratorConfig,
  PluginRegistry,
  Runtime,
  Workspace,
} from "../types.js";
import { updateMetadata } from "../metadata.js";
import { getProjectSessionsDir } from "../paths.js";
import { validateStatus } from "../utils/validation.js";
import { sessionFromMetadata } from "../utils/session-from-metadata.js";
import {
  buildLifecycleMetadataPatch,
  cloneLifecycle,
  parseCanonicalLifecycle,
} from "../lifecycle-state.js";
import type { RecoveryAssessment, RecoveryResult, RecoveryContext } from "./types.js";

/**
 * For V2 lifecycle-backed sessions, the canonical `lifecycle` object is the
 * source of truth: `readMetadataRaw()` overrides any flat `status` field with
 * `deriveLegacyStatus(lifecycle)`. Recovery actions that write only the flat
 * status would therefore appear to succeed but be silently overridden on the
 * next read. Build a lifecycle patch alongside the flat status so V2 sessions
 * actually reflect the recovery decision.
 *
 * Returns an empty patch when the session has no V2 lifecycle (legacy
 * pre-lifecycle metadata) — in that case the flat fields are still authoritative.
 */
function buildLifecycleRecoveryPatch(
  rawMetadata: Record<string, string>,
  next: { state: CanonicalSessionLifecycle["session"]["state"]; reason: CanonicalSessionLifecycle["session"]["reason"]; terminatedAt?: string },
): Partial<Record<string, string>> {
  if (!rawMetadata["lifecycle"] && !(rawMetadata["statePayload"] && rawMetadata["stateVersion"] === "2")) {
    return {};
  }
  const current = parseCanonicalLifecycle(rawMetadata);
  const updated = cloneLifecycle(current);
  const nowIso = new Date().toISOString();
  updated.session = {
    ...updated.session,
    state: next.state,
    reason: next.reason,
    lastTransitionAt: nowIso,
    terminatedAt:
      next.state === "terminated"
        ? (next.terminatedAt ?? nowIso)
        : updated.session.terminatedAt,
  };
  return buildLifecycleMetadataPatch(updated);
}

export async function recoverSession(
  assessment: RecoveryAssessment,
  config: OrchestratorConfig,
  registry: PluginRegistry,
  context: RecoveryContext,
): Promise<RecoveryResult> {
  const { sessionId, projectId, rawMetadata } = assessment;
  const recoveryCount = rawMetadata["recoveryCount"]
    ? parseInt(rawMetadata["recoveryCount"], 10) + 1
    : 1;

  if (context.dryRun) {
    if (recoveryCount > context.recoveryConfig.maxRecoveryAttempts) {
      return {
        success: true,
        sessionId,
        action: "escalate",
        requiresManualIntervention: true,
        reason: `Exceeded max recovery attempts (${context.recoveryConfig.maxRecoveryAttempts})`,
      };
    }

    return {
      success: true,
      sessionId,
      action: "recover",
    };
  }

  try {
    const now = new Date().toISOString();
    const preservedStatus = validateStatus(rawMetadata["status"]);

    const project = config.projects[projectId];
    if (!project) {
      return {
        success: false,
        sessionId,
        action: "recover",
        error: `Unknown project: ${projectId}`,
      };
    }
    const sessionsDir = getProjectSessionsDir(projectId);

    if (recoveryCount > context.recoveryConfig.maxRecoveryAttempts) {
      updateMetadata(sessionsDir, sessionId, {
        status: "stuck",
        escalatedAt: now,
        escalationReason: `Exceeded max recovery attempts (${context.recoveryConfig.maxRecoveryAttempts})`,
        recoveryCount: String(recoveryCount),
        ...buildLifecycleRecoveryPatch(rawMetadata, {
          state: "stuck",
          reason: "probe_failure",
        }),
      });
      context.invalidateCache?.();

      return {
        success: true,
        sessionId,
        action: "escalate",
        requiresManualIntervention: true,
        reason: `Exceeded max recovery attempts (${context.recoveryConfig.maxRecoveryAttempts})`,
      };
    }

    updateMetadata(sessionsDir, sessionId, {
      status: preservedStatus,
      restoredAt: now,
      recoveryCount: String(recoveryCount),
    });
    context.invalidateCache?.();

    const updatedMetadata = {
      ...rawMetadata,
      status: preservedStatus,
      restoredAt: now,
      recoveryCount: String(recoveryCount),
    };

    const session = sessionFromMetadata(sessionId, updatedMetadata, {
      projectId: assessment.projectId,
      status: preservedStatus,
      runtimeHandle: assessment.runtimeHandle,
      lastActivityAt: new Date(),
      restoredAt: new Date(now),
    });

    return {
      success: true,
      sessionId,
      action: "recover",
      session,
    };
  } catch (error) {
    return {
      success: false,
      sessionId,
      action: "recover",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function cleanupSession(
  assessment: RecoveryAssessment,
  config: OrchestratorConfig,
  registry: PluginRegistry,
  context: RecoveryContext,
): Promise<RecoveryResult> {
  const { sessionId, projectId, rawMetadata, runtimeAlive, workspaceExists } = assessment;

  if (context.dryRun) {
    return {
      success: true,
      sessionId,
      action: "cleanup",
    };
  }

  try {
    const project = config.projects[projectId];
    if (!project) {
      return {
        success: false,
        sessionId,
        action: "cleanup",
        error: `Unknown project: ${projectId}`,
      };
    }
    const runtimeName = project.runtime ?? config.defaults.runtime;
    const workspaceName = project.workspace ?? config.defaults.workspace;
    const runtime = registry.get<Runtime>("runtime", runtimeName);
    const workspace = registry.get<Workspace>("workspace", workspaceName);

    if (runtimeAlive && assessment.runtimeHandle && runtime) {
      try {
        await runtime.destroy(assessment.runtimeHandle);
      } catch {
        // ignore cleanup errors
      }
    }

    const workspacePath = rawMetadata["worktree"];
    if (workspacePath && workspaceExists && workspace) {
      try {
        await workspace.destroy(workspacePath);
      } catch {
        // ignore cleanup errors
      }
    }

    const sessionsDir = getProjectSessionsDir(projectId);

    const cleanupAt = new Date().toISOString();
    updateMetadata(sessionsDir, sessionId, {
      status: "terminated",
      terminatedAt: cleanupAt,
      terminationReason: "cleanup",
      ...buildLifecycleRecoveryPatch(rawMetadata, {
        state: "terminated",
        reason: "auto_cleanup",
        terminatedAt: cleanupAt,
      }),
    });

    context.invalidateCache?.();

    return {
      success: true,
      sessionId,
      action: "cleanup",
    };
  } catch (error) {
    return {
      success: false,
      sessionId,
      action: "cleanup",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function escalateSession(
  assessment: RecoveryAssessment,
  config: OrchestratorConfig,
  _registry: PluginRegistry,
  context: RecoveryContext,
): Promise<RecoveryResult> {
  const { sessionId, projectId, rawMetadata, reason } = assessment;

  if (context.dryRun) {
    return {
      success: true,
      sessionId,
      action: "escalate",
      requiresManualIntervention: true,
      reason,
    };
  }

  try {
    const project = config.projects[projectId];
    if (!project) {
      return {
        success: false,
        sessionId,
        action: "escalate",
        error: `Unknown project: ${projectId}`,
        requiresManualIntervention: true,
      };
    }
    const sessionsDir = getProjectSessionsDir(projectId);

    updateMetadata(sessionsDir, sessionId, {
      status: "stuck",
      escalatedAt: new Date().toISOString(),
      escalationReason: reason,
      ...buildLifecycleRecoveryPatch(rawMetadata, {
        state: "stuck",
        reason: "probe_failure",
      }),
    });
    context.invalidateCache?.();

    return {
      success: true,
      sessionId,
      action: "escalate",
      requiresManualIntervention: true,
      reason,
    };
  } catch (error) {
    return {
      success: false,
      sessionId,
      action: "escalate",
      error: error instanceof Error ? error.message : String(error),
      requiresManualIntervention: true,
    };
  }
}

export async function executeAction(
  assessment: RecoveryAssessment,
  config: OrchestratorConfig,
  registry: PluginRegistry,
  context: RecoveryContext,
): Promise<RecoveryResult> {
  switch (assessment.action) {
    case "recover":
      return recoverSession(assessment, config, registry, context);
    case "cleanup":
      return cleanupSession(assessment, config, registry, context);
    case "escalate":
      return escalateSession(assessment, config, registry, context);
    case "skip":
    default:
      return {
        success: true,
        sessionId: assessment.sessionId,
        action: "skip",
      };
  }
}
