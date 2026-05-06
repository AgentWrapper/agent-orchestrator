import { describe, expect, it } from "vitest";
import { buildBlockerChips } from "../SessionDetailPRCard";
import { makePR } from "../../__tests__/helpers";

describe("buildBlockerChips", () => {
  it("returns no chips when the PR is fully green", () => {
    expect(buildBlockerChips(makePR(), {})).toEqual([]);
  });

  it("emits a count-aware CI failing chip when ciStatus is failing", () => {
    const pr = makePR({
      ciStatus: "failing",
      ciChecks: [
        { name: "build", status: "failed" },
        { name: "lint", status: "failed" },
        { name: "typecheck", status: "passed" },
      ],
    });
    const chips = buildBlockerChips(pr, { lastCIFailureDispatchHash: "abc" });
    const ci = chips.find((chip) => chip.text.includes("failing"));
    expect(ci).toMatchObject({
      text: "2 checks failing",
      variant: "fail",
      notified: true,
    });
  });

  it("falls back to a generic CI failing chip when no individual checks are failed", () => {
    const pr = makePR({ ciStatus: "failing", ciChecks: [] });
    const chips = buildBlockerChips(pr, {});
    expect(chips.find((chip) => chip.text === "CI failing")).toBeTruthy();
  });

  it("treats lifecyclePrReason 'ci_failing' as failing CI even if PR ciStatus disagrees", () => {
    const pr = makePR({ ciStatus: "passing", ciChecks: [] });
    const chips = buildBlockerChips(pr, {}, "ci_failing");
    expect(chips.find((chip) => chip.text === "CI failing")).toBeTruthy();
  });

  it("treats metadata.status === 'ci_failed' as failing CI", () => {
    const pr = makePR({ ciStatus: "passing", ciChecks: [] });
    const chips = buildBlockerChips(pr, { status: "ci_failed" });
    expect(chips.find((chip) => chip.text === "CI failing")).toBeTruthy();
  });

  it("emits a CI pending chip when ciStatus is pending and not failing", () => {
    const pr = makePR({ ciStatus: "pending" });
    const chips = buildBlockerChips(pr, {});
    expect(chips.find((chip) => chip.text === "CI pending" && chip.variant === "warn")).toBeTruthy();
  });

  it("emits a Changes requested chip when reviewDecision is changes_requested", () => {
    const pr = makePR({ reviewDecision: "changes_requested" });
    const chips = buildBlockerChips(pr, { lastPendingReviewDispatchHash: "h" });
    expect(chips.find((c) => c.text === "Changes requested")).toMatchObject({
      variant: "fail",
      notified: true,
    });
  });

  it("emits an Awaiting reviewer chip when not approved and no changes requested", () => {
    const pr = makePR({
      reviewDecision: "review_required",
      mergeability: {
        mergeable: true,
        ciPassing: true,
        approved: false,
        noConflicts: true,
        blockers: [],
      },
    });
    const chips = buildBlockerChips(pr, {});
    expect(chips.find((c) => c.text === "Awaiting reviewer" && c.variant === "muted")).toBeTruthy();
  });

  it("emits a Merge conflicts chip only when mergeability is reliable and noConflicts=false", () => {
    const pr = makePR({
      mergeability: {
        mergeable: false,
        ciPassing: true,
        approved: true,
        noConflicts: false,
        blockers: [],
      },
    });
    const chips = buildBlockerChips(pr, { lastMergeConflictDispatched: "true" });
    expect(chips.find((c) => c.text === "Merge conflicts")).toMatchObject({
      variant: "fail",
      notified: true,
    });
  });

  it("suppresses the Merge conflicts chip for unenriched PRs (mergeability unreliable)", () => {
    const pr = makePR({
      enriched: false,
      mergeability: {
        mergeable: false,
        ciPassing: true,
        approved: true,
        noConflicts: false,
        blockers: ["unavailable"],
      },
    });
    const chips = buildBlockerChips(pr, {});
    expect(chips.find((c) => c.text === "Merge conflicts")).toBeUndefined();
  });

  it("suppresses the Merge conflicts chip when the PR is already merged", () => {
    const pr = makePR({
      state: "merged",
      mergeability: {
        mergeable: false,
        ciPassing: true,
        approved: true,
        noConflicts: false,
        blockers: [],
      },
    });
    const chips = buildBlockerChips(pr, {});
    expect(chips.find((c) => c.text === "Merge conflicts")).toBeUndefined();
  });

  it("emits a Draft chip when the PR is a draft", () => {
    const pr = makePR({ isDraft: true });
    const chips = buildBlockerChips(pr, {});
    expect(chips.find((c) => c.text === "Draft" && c.variant === "muted")).toBeTruthy();
  });
});
