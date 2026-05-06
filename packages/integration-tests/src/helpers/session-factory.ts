/**
 * Factory helpers to build Session and RuntimeHandle objects for tests.
 */

import { createActivitySignal, createInitialCanonicalLifecycle, type RuntimeHandle, type Session } from "@aoagents/ao-core";

/** Build a tmux RuntimeHandle for a given session name. */
export function makeTmuxHandle(sessionName: string): RuntimeHandle {
  return {
    id: sessionName,
    runtimeName: "tmux",
    data: {},
  };
}

/** Build a minimal Session object suitable for agent plugin methods. */
export function makeSession(
  id: string,
  handle: RuntimeHandle | null,
  workspacePath: string | null,
): Session {
  const lifecycle = createInitialCanonicalLifecycle("worker", new Date());
  lifecycle.session.state = "working";
  lifecycle.session.reason = "task_in_progress";
  lifecycle.session.startedAt = lifecycle.session.lastTransitionAt;
  lifecycle.runtime.state = handle ? "alive" : "unknown";
  lifecycle.runtime.reason = handle ? "process_running" : "spawn_incomplete";
  lifecycle.runtime.handle = handle;
  return {
    id,
    projectId: "inttest",
    status: "working",
    activity: "active",
    activitySignal: createActivitySignal("valid", {
      activity: "active",
      timestamp: new Date(),
      source: "native",
    }),
    lifecycle,
    branch: null,
    issueId: null,
    pr: null,
    workspacePath,
    runtimeHandle: handle,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
  };
}
