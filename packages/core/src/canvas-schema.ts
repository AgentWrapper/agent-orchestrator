import { z } from "zod";

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

const baseFields = {
  version: z.literal(1),
  id: z.string().regex(idPattern),
  title: z.string().min(1).max(200),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  source: z.string().min(1).max(64).optional(),
};

const markdownPayload = z
  .object({
    markdown: z.string().max(64_000),
  })
  .strict();

const diffLine = z
  .object({
    kind: z.enum(["context", "add", "del"]),
    text: z.string(),
  })
  .strict();

// Bounds matching the synthesized git-diff path's caps in canvas-log.ts.
// Without these, an agent-emitted diff canvas could pack tens of thousands of
// hunk lines into a 256 KB payload and stall the session detail page on every
// 5s poll. Numbers chosen to be generous for legitimate review/refactor diffs
// while preventing DOM blowup. See canvas-log.ts: DIFF_MAX_FILES, DIFF_MAX_LINES.
const DIFF_MAX_LINES_PER_HUNK = 1000;
const DIFF_MAX_HUNKS_PER_FILE = 50;
const DIFF_MAX_FILES_PER_CANVAS = 200;

const diffHunk = z
  .object({
    header: z.string(),
    lines: z.array(diffLine).max(DIFF_MAX_LINES_PER_HUNK),
  })
  .strict();

const diffFile = z
  .object({
    path: z.string().min(1),
    oldPath: z.string().optional(),
    status: z.enum(["added", "modified", "deleted", "renamed"]),
    hunks: z.array(diffHunk).max(DIFF_MAX_HUNKS_PER_FILE),
  })
  .strict();

const diffPayload = z
  .object({
    files: z.array(diffFile).max(DIFF_MAX_FILES_PER_CANVAS),
  })
  .strict();

const tableColumn = z
  .object({
    key: z.string().min(1),
    label: z.string(),
    align: z.enum(["left", "right", "center"]).optional(),
  })
  .strict();

const tableRow = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

const tablePayload = z
  .object({
    columns: z.array(tableColumn).min(1).max(32),
    rows: z.array(tableRow).max(1000),
  })
  .strict();

const statMetric = z
  .object({
    label: z.string().min(1).max(80),
    value: z.union([z.string().max(80), z.number()]),
    delta: z.string().max(40).optional(),
    tone: z.enum(["neutral", "good", "warn", "bad"]).optional(),
  })
  .strict();

const statsPayload = z
  .object({
    metrics: z.array(statMetric).min(1).max(32),
  })
  .strict();

export const CanvasArtifactSchema = z.discriminatedUnion("type", [
  z.object({ ...baseFields, type: z.literal("markdown"), payload: markdownPayload }).strict(),
  z.object({ ...baseFields, type: z.literal("diff"), payload: diffPayload }).strict(),
  z.object({ ...baseFields, type: z.literal("table"), payload: tablePayload }).strict(),
  z.object({ ...baseFields, type: z.literal("stats"), payload: statsPayload }).strict(),
]);
