import { describe, it, expect } from "vitest";
import type { CanvasArtifact } from "@aoagents/ao-core";
import { mergeCanvases } from "../merge";

function md(id: string, updatedAt: string, body: string): CanvasArtifact {
  return {
    version: 1,
    id,
    type: "markdown",
    title: id,
    createdAt: updatedAt,
    updatedAt,
    payload: { markdown: body },
  };
}

describe("mergeCanvases", () => {
  it("returns empty when nothing to merge", () => {
    expect(mergeCanvases(null, [])).toEqual([]);
  });

  it("includes synthesized canvas alongside file canvases", () => {
    const synth = md("core-git-diff", "2026-05-06T10:00:00Z", "diff");
    const file = md("notes", "2026-05-06T09:00:00Z", "notes");
    const out = mergeCanvases(synth, [file]);
    expect(out.map((c) => c.id)).toEqual(["core-git-diff", "notes"]);
  });

  it("on duplicate ids, keeps the NEWEST file entry (regression: PR #1653 pass-14 P1)", () => {
    // readCanvases sorts newest-first; merge must respect that.
    // If two files emit the same id, the user must see the newer payload.
    const newer = md("test-results", "2026-05-06T10:00:00Z", "v2 (newer)");
    const older = md("test-results", "2026-05-06T08:00:00Z", "v1 (older)");
    const out = mergeCanvases(null, [newer, older]); // newest-first input
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "test-results" });
    if (out[0]?.type === "markdown") {
      expect(out[0].payload.markdown).toBe("v2 (newer)");
    } else {
      throw new Error("expected markdown canvas");
    }
  });

  it("synthesized wins on id collision with a file canvas", () => {
    // Even though `core-` is reserved at the reader, the merge layer also
    // needs to resolve collisions deterministically in favor of synthesized.
    const synth = md("core-git-diff", "2026-05-06T08:00:00Z", "synthesized");
    const fake = md("core-git-diff", "2026-05-06T10:00:00Z", "imposter");
    const out = mergeCanvases(synth, [fake]);
    expect(out).toHaveLength(1);
    if (out[0]?.type === "markdown") {
      expect(out[0].payload.markdown).toBe("synthesized");
    }
  });

  it("output is sorted newest-first by updatedAt", () => {
    const a = md("a", "2026-05-06T08:00:00Z", "");
    const b = md("b", "2026-05-06T10:00:00Z", "");
    const c = md("c", "2026-05-06T09:00:00Z", "");
    const out = mergeCanvases(null, [b, c, a]); // arbitrary input order
    expect(out.map((x) => x.id)).toEqual(["b", "c", "a"]);
  });
});
