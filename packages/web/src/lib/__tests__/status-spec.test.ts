import { describe, expect, it } from "vitest";
import { getStatusSpec } from "@/lib/status-spec";
import { makePR, makeSession } from "@/__tests__/helpers";

describe("getStatusSpec — the one mission-control status spectrum", () => {
  it("maps a working agent to the breathing orange tone", () => {
    const spec = getStatusSpec(makeSession({ id: "w", status: "working", activity: "active" }));
    expect(spec).toEqual({ tone: "working", label: "Working", breathing: true });
  });

  it("maps an idle working agent to neutral (no breathe)", () => {
    const spec = getStatusSpec(makeSession({ id: "i", status: "working", activity: "idle" }));
    expect(spec.tone).toBe("neutral");
    expect(spec.breathing).toBe(false);
  });

  it("maps a session waiting on input to amber 'Needs input'", () => {
    const spec = getStatusSpec(
      makeSession({ id: "n", status: "waiting_input", activity: "waiting_input" }),
    );
    expect(spec).toEqual({ tone: "input", label: "Needs input", breathing: false });
  });

  it("maps a stuck session to red 'Stuck'", () => {
    const spec = getStatusSpec(makeSession({ id: "s", status: "stuck", activity: "idle" }));
    expect(spec).toEqual({ tone: "fail", label: "Stuck", breathing: false });
  });

  it("maps CI failure to red 'CI failed'", () => {
    const spec = getStatusSpec(
      makeSession({
        id: "c",
        status: "working",
        pr: makePR({
          number: 1,
          ciStatus: "failing",
          reviewDecision: "pending",
          mergeability: {
            mergeable: false,
            ciPassing: false,
            approved: false,
            noConflicts: true,
            blockers: [],
          },
        }),
      }),
    );
    expect(spec).toEqual({ tone: "fail", label: "CI failed", breathing: false });
  });

  it("maps changes-requested to amber 'Changes req.'", () => {
    const spec = getStatusSpec(
      makeSession({
        id: "r",
        status: "working",
        pr: makePR({
          number: 2,
          ciStatus: "passing",
          reviewDecision: "changes_requested",
          mergeability: {
            mergeable: false,
            ciPassing: true,
            approved: false,
            noConflicts: true,
            blockers: [],
          },
        }),
      }),
    );
    expect(spec).toEqual({ tone: "changes", label: "Changes req.", breathing: false });
  });

  it("maps a mergeable PR to green 'Mergeable'", () => {
    const spec = getStatusSpec(makeSession({ id: "m", status: "working", pr: makePR({ number: 3 }) }));
    expect(spec).toEqual({ tone: "ready", label: "Mergeable", breathing: false });
  });

  it("maps a merged PR to green 'Merged'", () => {
    const spec = getStatusSpec(
      makeSession({ id: "g", status: "merged", pr: makePR({ number: 4, state: "merged" }) }),
    );
    expect(spec).toEqual({ tone: "merged", label: "Merged", breathing: false });
  });
});
