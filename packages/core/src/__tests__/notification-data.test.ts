import { describe, expect, it } from "vitest";
import {
  buildCIFailureNotificationData,
  buildPRStateNotificationData,
  buildReactionEscalationNotificationData,
  buildReactionNotificationData,
  buildSessionTransitionNotificationData,
  getNotificationDataV3,
  semanticTypeForReactionKey,
  type NotificationEventContext,
} from "../notification-data.js";

const context: NotificationEventContext = {
  pr: {
    number: 42,
    url: "https://github.com/acme/app/pull/42",
    title: "Normalize notifier payloads",
    branch: "ao/notifier-payloads",
    baseBranch: "main",
    owner: "acme",
    repo: "app",
    isDraft: false,
  },
  prs: [
    {
      number: 42,
      url: "https://github.com/acme/app/pull/42",
      title: "Normalize notifier payloads",
      branch: "ao/notifier-payloads",
      baseBranch: "main",
      owner: "acme",
      repo: "app",
      isDraft: false,
    },
  ],
  issueId: "AO-42",
  issueTitle: "Notifier payloads",
  summary: "Normalize notifier payloads",
  branch: "ao/notifier-payloads",
};

describe("notification data v3", () => {
  it("builds semantic session transition data without legacy flat fields", () => {
    const data = buildSessionTransitionNotificationData({
      eventType: "session.needs_input",
      sessionId: "worker-1",
      projectId: "demo",
      context,
      oldStatus: "working",
      newStatus: "needs_input",
    });

    expect(data).toMatchObject({
      schemaVersion: 3,
      semanticType: "session.needs_input",
      subject: {
        session: { id: "worker-1", projectId: "demo" },
        pr: { number: 42, url: "https://github.com/acme/app/pull/42" },
        issue: { id: "AO-42" },
      },
      transition: { kind: "session_status", from: "working", to: "needs_input" },
    });
    expect(data).not.toHaveProperty("context");
    expect(data).not.toHaveProperty("prUrl");
    expect(data).not.toHaveProperty("oldStatus");
    expect(data).not.toHaveProperty("newStatus");
  });

  it("builds CI failure data with nested check details", () => {
    const data = buildCIFailureNotificationData({
      sessionId: "worker-1",
      projectId: "demo",
      context,
      failedChecks: [
        {
          name: "typecheck",
          status: "failed",
          conclusion: "FAILURE",
          url: "https://github.com/acme/app/actions/runs/1",
        },
      ],
    });

    expect(data).toMatchObject({
      semanticType: "ci.failing",
      ci: {
        status: "failing",
        failedChecks: [
          {
            name: "typecheck",
            status: "failed",
            conclusion: "FAILURE",
            url: "https://github.com/acme/app/actions/runs/1",
          },
        ],
      },
    });
    expect(data).not.toHaveProperty("failedChecks", ["typecheck"]);
  });

  it("maps reaction keys to semantic domain blocks", () => {
    const data = buildReactionNotificationData({
      eventType: "reaction.triggered",
      sessionId: "worker-1",
      projectId: "demo",
      context,
      reactionKey: "approved-and-green",
      action: "notify",
      enrichment: {
        state: "open",
        ciStatus: "passing",
        reviewDecision: "approved",
        mergeable: true,
        hasConflicts: false,
        isBehind: false,
      },
    });

    expect(data.semanticType).toBe("merge.ready");
    expect(data.reaction).toEqual({ key: "approved-and-green", action: "notify" });
    expect(data.ci).toEqual({ status: "passing" });
    expect(data.review).toEqual({ decision: "approved" });
    expect(data.merge).toMatchObject({ ready: true, conflicts: false, baseBranch: "main" });
  });

  it("adds escalation details to reaction data", () => {
    const data = buildReactionEscalationNotificationData({
      eventType: "reaction.escalated",
      sessionId: "worker-1",
      projectId: "demo",
      context,
      reactionKey: "ci-failed",
      action: "escalated",
      attempts: 4,
      cause: "max_retries",
      durationMs: 12_000,
    });

    expect(data.semanticType).toBe("ci.failing");
    expect(data.escalation).toEqual({
      attempts: 4,
      cause: "max_retries",
      durationMs: 12_000,
    });
  });

  it("builds PR state transition data", () => {
    const data = buildPRStateNotificationData({
      eventType: "pr.closed",
      sessionId: "worker-1",
      projectId: "demo",
      context,
      oldPRState: "open",
      newPRState: "closed",
    });

    expect(data.transition).toEqual({ kind: "pr_state", from: "open", to: "closed" });
    expect(data.subject.pr?.url).toBe("https://github.com/acme/app/pull/42");
    expect(data).not.toHaveProperty("oldPRState");
    expect(data).not.toHaveProperty("newPRState");
  });

  it("recognizes only v3 notification data", () => {
    const data = buildCIFailureNotificationData({
      sessionId: "worker-1",
      projectId: "demo",
      context,
      failedChecks: [],
    });

    expect(getNotificationDataV3(data)).toBe(data);
    expect(getNotificationDataV3({ schemaVersion: 2, prUrl: context.pr?.url })).toBeNull();
  });

  it("falls back to event type for unknown reaction keys", () => {
    expect(semanticTypeForReactionKey("custom-reaction", "reaction.triggered")).toBe(
      "reaction.triggered",
    );
  });
});
