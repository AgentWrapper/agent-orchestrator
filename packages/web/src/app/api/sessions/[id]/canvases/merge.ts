import type { CanvasArtifact } from "@aoagents/ao-core";

/**
 * Merge synthesized + file canvases for the canvases endpoint.
 *
 * Semantics:
 *   1. Synthesized canvas (e.g. `core-git-diff`) seeds the map first. The
 *      `core-` prefix is reserved at the reader, so a legitimate file canvas
 *      can't collide; if collision happens anyway the trusted synthesized
 *      version wins by being inserted first.
 *   2. `fileCanvases` MUST be sorted newest-first by `updatedAt`. The first
 *      occurrence of each id is kept; subsequent duplicates are skipped, NOT
 *      used to overwrite.
 *
 * The naive `Map.set` loop did the opposite (older payload won) — see PR #1653
 * pass-14 review.
 *
 * Final output is sorted by `updatedAt` descending (newest first).
 */
export function mergeCanvases(
  synthesized: CanvasArtifact | null,
  fileCanvases: CanvasArtifact[],
): CanvasArtifact[] {
  const merged = new Map<string, CanvasArtifact>();
  if (synthesized) merged.set(synthesized.id, synthesized);
  for (const c of fileCanvases) {
    if (!merged.has(c.id)) merged.set(c.id, c);
  }
  return Array.from(merged.values()).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
