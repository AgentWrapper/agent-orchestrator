import { z } from "zod";

/**
 * Artifact schema — structured agent output rendered as cards in the session
 * detail right rail.
 *
 * Two renderer types:
 *   - `markdown` — rendered in-app (no HTML pass-through; safe by construction)
 *   - `html`     — rendered inside a sandboxed iframe (allow-scripts, no
 *                  allow-same-origin → null-origin → can't reach auth tokens
 *                  or call APIs even if the agent is prompt-injected)
 *
 * Server-stamped metadata (createdAt, updatedAt, source) is filled in by core
 * during ingest. The agent supplies type, id, title, and payload.
 */

export const ARTIFACT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ARTIFACT_RESERVED_PREFIX = "core-";

/** Maximum serialized artifact size on disk. */
export const ARTIFACT_MAX_BYTES = 256 * 1024;

/** Maximum artifacts retained per session (oldest by updatedAt evicted). */
export const ARTIFACT_MAX_PER_SESSION = 32;

/** Maximum chars in a markdown payload. */
export const MARKDOWN_MAX_CHARS = 64_000;

/** Maximum chars in an HTML payload. */
export const HTML_MAX_CHARS = 200_000;

const baseFields = {
  version: z.literal(1),
  id: z.string().regex(ARTIFACT_ID_PATTERN),
  title: z.string().min(1).max(200),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  source: z.string().min(1).max(64).optional(),
};

const markdownPayload = z
  .object({ markdown: z.string().max(MARKDOWN_MAX_CHARS) })
  .strict();

const htmlPayload = z
  .object({ html: z.string().max(HTML_MAX_CHARS) })
  .strict();

export const ArtifactSchema = z.discriminatedUnion("type", [
  z.object({ ...baseFields, type: z.literal("markdown"), payload: markdownPayload }).strict(),
  z.object({ ...baseFields, type: z.literal("html"), payload: htmlPayload }).strict(),
]);

export type Artifact = z.infer<typeof ArtifactSchema>;
export type ArtifactType = Artifact["type"];

/** Agent-supplied fields. The agent supplies these; ingest stamps the rest. */
export interface ArtifactPublishInput {
  type: ArtifactType;
  id: string;
  title: string;
  payload: Artifact["payload"];
}

/** Server-side: producer plugin interface. v0.2 wires this on plugin slots. */
export interface ArtifactProducer {
  /** Called on each GET /artifacts. Returns synthesized artifacts. */
  listArtifacts(
    session: { id: string; workspacePath?: string },
    project: { defaultBranch: string },
  ): Promise<Artifact[]>;
}
