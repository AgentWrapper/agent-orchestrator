/**
 * Shared findings parser for the agent and command executors.
 *
 * Both executors collect ArtifactInput records produced by their stage —
 * agents drop them in a JSONL file, commands print them to stdout. The
 * validation rules (kind discrimination, required fields, severity enum,
 * confidence range) are identical, so they live here.
 */

import type { ArtifactInput } from "../types.js";

const VALID_SEVERITIES = ["error", "warning", "info"] as const;

/**
 * Parse a JSONL body into ArtifactInput records.
 *
 * Empty / whitespace-only lines are skipped. The first bad line throws with
 * its 1-based line number so the caller can echo it back to operators.
 */
export function parseFindingsJsonl(body: string): ArtifactInput[] {
  const out: ArtifactInput[] = [];
  for (const [lineNo, raw] of body.split("\n").entries()) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`line ${lineNo + 1}: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    out.push(coerceArtifactInput(parsed, lineNo + 1));
  }
  return out;
}

/**
 * Coerce one parsed JSON value into an ArtifactInput, validating required
 * fields by `kind`. Throws on unknown kinds or missing/out-of-range fields.
 */
export function coerceArtifactInput(value: unknown, lineNo: number): ArtifactInput {
  if (!value || typeof value !== "object") {
    throw new Error(`line ${lineNo}: expected object`);
  }
  const obj = value as Record<string, unknown>;
  if (obj["kind"] === "finding") {
    requireString(obj, "filePath", lineNo);
    requireNumber(obj, "startLine", lineNo);
    requireNumber(obj, "endLine", lineNo);
    requireString(obj, "title", lineNo);
    requireString(obj, "description", lineNo);
    requireString(obj, "category", lineNo);
    requireEnum(obj, "severity", VALID_SEVERITIES, lineNo);
    requireNumberInRange(obj, "confidence", 0, 1, lineNo);
    return obj as unknown as ArtifactInput;
  }
  if (obj["kind"] === "json") {
    if (!obj["data"] || typeof obj["data"] !== "object") {
      throw new Error(`line ${lineNo}: "json" artifact requires object \`data\``);
    }
    return obj as unknown as ArtifactInput;
  }
  throw new Error(`line ${lineNo}: unknown artifact kind=${JSON.stringify(obj["kind"])}`);
}

function requireString(obj: Record<string, unknown>, key: string, lineNo: number): void {
  if (typeof obj[key] !== "string") {
    throw new Error(`line ${lineNo}: missing string field "${key}"`);
  }
}

function requireNumber(obj: Record<string, unknown>, key: string, lineNo: number): void {
  if (typeof obj[key] !== "number") {
    throw new Error(`line ${lineNo}: missing numeric field "${key}"`);
  }
}

function requireNumberInRange(
  obj: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  lineNo: number,
): void {
  const value = obj[key];
  if (typeof value !== "number" || value < min || value > max) {
    throw new Error(
      `line ${lineNo}: field "${key}" must be a number in [${min}, ${max}], got ${JSON.stringify(value)}`,
    );
  }
}

function requireEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  lineNo: number,
): void {
  const value = obj[key];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(
      `line ${lineNo}: field "${key}" must be one of ${allowed
        .map((v) => `"${v}"`)
        .join(", ")}, got ${JSON.stringify(value)}`,
    );
  }
}
