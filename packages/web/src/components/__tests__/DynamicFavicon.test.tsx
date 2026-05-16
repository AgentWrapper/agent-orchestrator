import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { countNeedingAttention, DynamicFavicon } from "../DynamicFavicon";
import type { AttentionMap } from "@/hooks/useSessionEvents";

describe("countNeedingAttention", () => {
  it("returns 0 for empty map", () => {
    expect(countNeedingAttention({})).toBe(0);
  });

  it("returns 0 when all sessions are working/pending/done", () => {
    const levels: AttentionMap = {
      "s-1": "working",
      "s-2": "pending",
      "s-3": "done",
    };
    expect(countNeedingAttention(levels)).toBe(0);
  });

  it("counts respond, review, action, and merge sessions", () => {
    const levels: AttentionMap = {
      "s-1": "respond",
      "s-2": "review",
      "s-3": "merge",
      "s-4": "action",
      "s-5": "working",
      "s-6": "done",
    };
    expect(countNeedingAttention(levels)).toBe(4);
  });

  it("counts a single attention-needing session", () => {
    const levels: AttentionMap = {
      "s-1": "respond",
    };
    expect(countNeedingAttention(levels)).toBe(1);
  });
});

describe("DynamicFavicon", () => {
  beforeEach(() => {
    const existing = document.querySelector('link[rel="icon"]');
    if (existing) existing.remove();
  });

  it("creates a green favicon when no sessions need attention", () => {
    const levels: AttentionMap = { "s-1": "working", "s-2": "done" };
    render(<DynamicFavicon attentionLevels={levels} projectName="Test" />);

    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(link).not.toBeNull();
    expect(link!.href).toContain("%2322c55e"); // green
  });

  it("creates a yellow favicon when sessions need review", () => {
    const levels: AttentionMap = { "s-1": "review", "s-2": "working" };
    render(<DynamicFavicon attentionLevels={levels} projectName="Test" />);

    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(link!.href).toContain("%23eab308"); // yellow
  });

  it("creates a red favicon when sessions need response", () => {
    const levels: AttentionMap = { "s-1": "respond" };
    render(<DynamicFavicon attentionLevels={levels} projectName="Test" />);

    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(link!.href).toContain("%23ef4444"); // red
  });

  it("keeps favicon yellow (not red) for collapsed 'action' in simple mode", () => {
    // "action" collapses respond + review, so it contains routine review work
    // (ci_failed, changes_requested). Escalating to red would cry wolf on
    // every typical PR.
    const levels: AttentionMap = { "s-1": "action", "s-2": "working" };
    render(<DynamicFavicon attentionLevels={levels} projectName="Test" />);

    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(link!.href).toContain("%23eab308"); // yellow
  });

  it("still escalates to red when detailed 'respond' is present alongside 'action'", () => {
    const levels: AttentionMap = { "s-1": "action", "s-2": "respond" };
    render(<DynamicFavicon attentionLevels={levels} projectName="Test" />);

    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(link!.href).toContain("%23ef4444"); // red
  });

  it("uses first letter of projectName as initial", () => {
    const levels: AttentionMap = {};
    render(<DynamicFavicon attentionLevels={levels} projectName="MyApp" />);

    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(link!.href).toContain("M"); // initial letter
  });

  it("defaults to A when no projectName given", () => {
    const levels: AttentionMap = {};
    render(<DynamicFavicon attentionLevels={levels} />);

    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(link!.href).toContain("A");
  });

  it("updates favicon when attention levels change", () => {
    const { rerender } = render(
      <DynamicFavicon attentionLevels={{ "s-1": "working" }} projectName="Test" />,
    );

    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(link!.href).toContain("%2322c55e"); // green

    rerender(<DynamicFavicon attentionLevels={{ "s-1": "respond" }} projectName="Test" />);

    link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(link!.href).toContain("%23ef4444"); // red
  });
});
