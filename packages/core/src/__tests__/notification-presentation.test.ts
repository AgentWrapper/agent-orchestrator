import { describe, expect, it } from "vitest";
import type { OrchestratorEvent } from "../types.js";
import {
  buildCIFailureNotificationData,
  buildPRStateNotificationData,
  buildReactionEscalationNotificationData,
  buildReactionNotificationData,
  buildSessionTransitionNotificationData,
  type NotificationEventContext,
} from "../notification-data.js";
import { buildNotificationPresentation } from "../notification-presentation.js";

const CONTEXT: NotificationEventContext = {
  pr: {
    number: 42,
    url: "https://github.com/acme/app/pull/42",
    title: "Add concise notifications",
    branch: "feat/notifications",
    baseBranch: "main",
  },
  issueId: "AO-42",
  issueTitle: "Add concise notifications",
  summary: "Add concise notifications",
  branch: "feat/notifications",
};

function event(overrides: Partial<OrchestratorEvent>): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "session.needs_input",
    priority: "action",
    sessionId: "worker-1",
    projectId: "demo",
    timestamp: new Date("2026-05-13T12:00:00.000Z"),
    message: "Context: noisy\nStatus: waiting\nBranch: feat/noisy\nTransition: working → waiting",
    data: {},
    ...overrides,
  };
}

function expectNotificationSafe(input: OrchestratorEvent): void {
  const presentation = buildNotificationPresentation(input);
  expect(`${presentation.title}\n${presentation.body}`).not.toMatch(
    /Context:|Status:|Branch:|Transition:/,
  );
}

describe("buildNotificationPresentation", () => {
  it("formats agent needs-input notifications", () => {
    const presentation = buildNotificationPresentation(
      event({
        type: "session.needs_input",
        data: buildSessionTransitionNotificationData({
          eventType: "session.needs_input",
          sessionId: "worker-1",
          projectId: "demo",
          context: CONTEXT,
          oldStatus: "working",
          newStatus: "needs_input",
        }),
      }),
    );

    expect(presentation).toMatchObject({
      category: "agent_needs_input",
      title: "Agent needs input",
      body: "worker-1 is waiting for input.",
    });
  });

  it("formats agent stuck notifications", () => {
    const presentation = buildNotificationPresentation(
      event({
        type: "session.stuck",
        priority: "urgent",
        data: buildSessionTransitionNotificationData({
          eventType: "session.stuck",
          sessionId: "worker-1",
          projectId: "demo",
          context: CONTEXT,
          oldStatus: "working",
          newStatus: "stuck",
        }),
      }),
    );

    expect(presentation.title).toBe("Agent may be stuck");
    expect(presentation.body).toBe("worker-1 has been inactive and needs attention.");
  });

  it("formats CI failing notifications with failed check names", () => {
    const presentation = buildNotificationPresentation(
      event({
        type: "ci.failing",
        data: buildCIFailureNotificationData({
          sessionId: "worker-1",
          projectId: "demo",
          context: CONTEXT,
          failedChecks: [
            { name: "typecheck", status: "failed" },
            { name: "unit-tests", status: "failed" },
          ],
        }),
      }),
    );

    expect(presentation.title).toBe("CI failing on PR #42");
    expect(presentation.body).toBe("2 checks failed: typecheck, unit-tests.");
  });

  it("formats review changes requested notifications with thread count", () => {
    const data = buildSessionTransitionNotificationData({
      eventType: "review.changes_requested",
      sessionId: "worker-1",
      projectId: "demo",
      context: CONTEXT,
      oldStatus: "review_pending",
      newStatus: "changes_requested",
    });
    data.review = { ...(data.review ?? {}), unresolvedThreads: 3 };

    const presentation = buildNotificationPresentation(event({ type: "review.changes_requested", data }));

    expect(presentation.title).toBe("Changes requested on PR #42");
    expect(presentation.body).toBe("3 review threads need attention.");
  });

  it("formats merge ready notifications", () => {
    const presentation = buildNotificationPresentation(
      event({
        type: "merge.ready",
        data: buildReactionNotificationData({
          eventType: "reaction.triggered",
          sessionId: "worker-1",
          projectId: "demo",
          context: CONTEXT,
          reactionKey: "approved-and-green",
          action: "notify",
        }),
      }),
    );

    expect(presentation.title).toBe("PR #42 is ready to merge");
    expect(presentation.body).toBe("Approved and CI is green.");
  });

  it("formats PR closed notifications", () => {
    const presentation = buildNotificationPresentation(
      event({
        type: "pr.closed",
        priority: "warning",
        data: buildPRStateNotificationData({
          eventType: "pr.closed",
          sessionId: "worker-1",
          projectId: "demo",
          context: CONTEXT,
          oldPRState: "open",
          newPRState: "closed",
        }),
      }),
    );

    expect(presentation.title).toBe("PR #42 was closed");
    expect(presentation.body).toBe("The pull request was closed before merge.");
  });

  it("formats reaction escalations", () => {
    const presentation = buildNotificationPresentation(
      event({
        type: "reaction.escalated",
        priority: "urgent",
        data: buildReactionEscalationNotificationData({
          eventType: "reaction.escalated",
          sessionId: "worker-1",
          projectId: "demo",
          context: CONTEXT,
          reactionKey: "ci-failed",
          action: "escalated",
          attempts: 4,
          cause: "max_attempts",
        }),
      }),
    );

    expect(presentation.title).toBe("Reaction escalated");
    expect(presentation.body).toBe("ci-failed escalated after 4 attempts.");
  });

  it("formats all-complete notifications", () => {
    const presentation = buildNotificationPresentation(
      event({
        type: "summary.all_complete",
        priority: "info",
        projectId: "demo",
        data: buildReactionNotificationData({
          eventType: "reaction.triggered",
          sessionId: "worker-1",
          projectId: "demo",
          context: { ...CONTEXT, pr: null },
          reactionKey: "all-complete",
          action: "notify",
        }),
      }),
    );

    expect(presentation.title).toBe("All sessions complete");
    expect(presentation.body).toBe("demo has no active work requiring attention.");
  });

  it("uses a generic fallback for unknown event types", () => {
    const presentation = buildNotificationPresentation(
      event({
        type: "session.spawned",
        data: {},
        message: "Session worker-1 spawned",
      }),
    );

    expect(presentation.category).toBe("generic");
    expect(presentation.title).toBe("Session Spawned");
    expect(presentation.body).toBe("Session worker-1 spawned");
  });

  it("keeps desktop-visible title and body free of report labels", () => {
    for (const input of [
      event({ type: "session.needs_input" }),
      event({ type: "session.stuck" }),
      event({ type: "ci.failing" }),
      event({ type: "review.changes_requested" }),
      event({ type: "merge.ready" }),
      event({ type: "pr.closed" }),
      event({ type: "reaction.escalated" }),
      event({ type: "summary.all_complete" }),
      event({ type: "session.spawned" }),
    ]) {
      expectNotificationSafe(input);
    }
  });
});
