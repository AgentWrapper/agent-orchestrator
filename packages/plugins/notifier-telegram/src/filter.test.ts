import { describe, expect, it } from "vitest";
import type { OrchestratorEvent } from "@aoagents/ao-core";
import {
  classify,
  createNotificationGate,
  effectiveType,
  isOrchestratorSessionId,
  DEFAULT_DEDUP_WINDOW_MS,
  DEFAULT_STUCK_THROTTLE_MS,
} from "./filter.js";

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  const sessionId = overrides.sessionId ?? "mae-10";
  const type = overrides.type ?? "session.needs_input";
  return {
    id: "evt-1",
    type,
    priority: "action",
    sessionId,
    projectId: "maestro",
    timestamp: new Date("2026-06-20T12:00:00Z"),
    message: "hi",
    // Direct events mirror their own type into semanticType (see notification-data.ts).
    data: {
      schemaVersion: 3,
      semanticType: type,
      subject: { session: { id: sessionId, projectId: "maestro" } },
    },
    ...overrides,
  };
}

/** A reaction event: `data.semanticType` carries the underlying meaning. */
function makeReaction(
  reactionKey: string,
  semanticType: string,
  sessionId = "mae-10",
): OrchestratorEvent {
  return makeEvent({
    type: "reaction.triggered",
    sessionId,
    data: {
      schemaVersion: 3,
      semanticType,
      reaction: { key: reactionKey, action: "notify" },
      subject: { session: { id: sessionId, projectId: "maestro" } },
    },
  });
}

describe("isOrchestratorSessionId", () => {
  it("matches the AO orchestrator id convention, portably", () => {
    expect(isOrchestratorSessionId("mae-orchestrator")).toBe(true);
    expect(isOrchestratorSessionId("app-orchestrator")).toBe(true);
    expect(isOrchestratorSessionId("mae-orchestrator-2")).toBe(true);
  });
  it("does not match workers or empty ids", () => {
    expect(isOrchestratorSessionId("mae-13")).toBe(false);
    expect(isOrchestratorSessionId("mae-10")).toBe(false);
    expect(isOrchestratorSessionId("")).toBe(false);
    expect(isOrchestratorSessionId(undefined)).toBe(false);
  });
});

describe("effectiveType / classify", () => {
  it("unwraps a reaction to its semantic type", () => {
    expect(effectiveType(makeReaction("agent-stuck", "session.stuck"))).toBe("session.stuck");
    expect(effectiveType(makeReaction("ci-failed", "ci.failing"))).toBe("ci.failing");
  });
  it("classifies actionable, stuck, and lifecycle-drop", () => {
    expect(classify(makeEvent({ type: "session.needs_input" }))).toBe("actionable");
    expect(classify(makeEvent({ type: "pr.created" }))).toBe("actionable");
    expect(classify(makeEvent({ type: "ci.failing" }))).toBe("actionable");
    expect(classify(makeEvent({ type: "session.stuck" }))).toBe("stuck");
    expect(classify(makeReaction("agent-stuck", "session.stuck"))).toBe("stuck");
    expect(classify(makeEvent({ type: "session.working" }))).toBe("drop");
    expect(classify(makeEvent({ type: "session.idle" }))).toBe("drop");
    expect(classify(makeEvent({ type: "session.spawned" }))).toBe("drop");
  });
});

describe("createNotificationGate", () => {
  const t0 = 1_000_000;

  it("sends actionable events", () => {
    const gate = createNotificationGate();
    const d = gate.evaluate(makeEvent({ type: "session.needs_input" }), t0);
    expect(d.send).toBe(true);
    expect(d.reason).toBe("actionable");
  });

  it("drops lifecycle pulses (working/idle/spawned)", () => {
    const gate = createNotificationGate();
    for (const type of ["session.working", "session.idle", "session.spawned"] as const) {
      const d = gate.evaluate(makeEvent({ type }), t0);
      expect(d.send, type).toBe(false);
      expect(d.reason).toBe("lifecycle");
    }
  });

  it("never sends a stuck orchestrator — direct or via reaction", () => {
    const gate = createNotificationGate();
    const direct = gate.evaluate(
      makeEvent({ type: "session.stuck", sessionId: "mae-orchestrator" }),
      t0,
    );
    expect(direct.send).toBe(false);
    expect(direct.reason).toBe("orchestrator-stuck");

    const reaction = gate.evaluate(
      makeReaction("agent-stuck", "session.stuck", "mae-orchestrator"),
      t0,
    );
    expect(reaction.send).toBe(false);
    expect(reaction.reason).toBe("orchestrator-stuck");
  });

  it("throttles worker stuck to one per window, then allows after it elapses", () => {
    const gate = createNotificationGate();
    const ev = () => makeEvent({ type: "session.stuck", sessionId: "mae-13" });

    expect(gate.evaluate(ev(), t0).send).toBe(true); // first gets through
    const throttled = gate.evaluate(ev(), t0 + 1000);
    expect(throttled.send).toBe(false);
    expect(throttled.reason).toBe("stuck-throttled");
    // still throttled just before the window closes
    expect(gate.evaluate(ev(), t0 + DEFAULT_STUCK_THROTTLE_MS - 1).send).toBe(false);
    // allowed once the window elapses
    expect(gate.evaluate(ev(), t0 + DEFAULT_STUCK_THROTTLE_MS + 1).send).toBe(true);
  });

  it("dedups identical (session, kind) actionable bursts within the window", () => {
    const gate = createNotificationGate();
    const ev = () => makeEvent({ type: "pr.created", sessionId: "mae-13" });

    expect(gate.evaluate(ev(), t0).send).toBe(true);
    const dup = gate.evaluate(ev(), t0 + 500);
    expect(dup.send).toBe(false);
    expect(dup.reason).toBe("duplicate");
    // a different kind for the same session is not a duplicate
    expect(
      gate.evaluate(makeEvent({ type: "ci.failing", sessionId: "mae-13" }), t0 + 500).send,
    ).toBe(true);
    // the same kind again after the window passes goes through
    expect(gate.evaluate(ev(), t0 + DEFAULT_DEDUP_WINDOW_MS + 1).send).toBe(true);
  });

  it("anchors the throttle window on the last send, not the last attempt", () => {
    const gate = createNotificationGate();
    const ev = () => makeEvent({ type: "session.stuck", sessionId: "mae-13" });
    expect(gate.evaluate(ev(), t0).send).toBe(true);
    // a blocked attempt midway must not reset the clock
    expect(gate.evaluate(ev(), t0 + DEFAULT_STUCK_THROTTLE_MS / 2).send).toBe(false);
    // window is still measured from t0, so it opens at t0 + window
    expect(gate.evaluate(ev(), t0 + DEFAULT_STUCK_THROTTLE_MS + 1).send).toBe(true);
  });

  it("honours config overrides for the windows", () => {
    const gate = createNotificationGate({ dedupWindowMs: 100, stuckThrottleMs: 200 });
    const dup = () => makeEvent({ type: "pr.created", sessionId: "mae-13" });
    expect(gate.evaluate(dup(), t0).send).toBe(true);
    expect(gate.evaluate(dup(), t0 + 50).send).toBe(false);
    expect(gate.evaluate(dup(), t0 + 101).send).toBe(true);
  });

  describe("orchestratorOnly mode", () => {
    it("suppresses worker events, passes orchestrator events", () => {
      const gate = createNotificationGate({ orchestratorOnly: true });

      // A worker's actionable event is suppressed as worker-suppressed.
      const worker = gate.evaluate(
        makeEvent({ type: "pr.created", sessionId: "mae-13" }),
        t0,
      );
      expect(worker.send).toBe(false);
      expect(worker.reason).toBe("worker-suppressed");

      // The orchestrator's own event falls through to normal actionable logic.
      const orch = gate.evaluate(
        makeEvent({ type: "session.needs_input", sessionId: "mae-orchestrator" }),
        t0,
      );
      expect(orch.send).toBe(true);
      expect(orch.reason).toBe("actionable");
    });

    it("is off by default — worker events still flow", () => {
      const gate = createNotificationGate();
      const worker = gate.evaluate(
        makeEvent({ type: "pr.created", sessionId: "mae-13" }),
        t0,
      );
      expect(worker.send).toBe(true);
      expect(worker.reason).toBe("actionable");
    });
  });
});
