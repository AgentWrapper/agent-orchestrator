import { describe, it, expect } from "vitest";
import {
  ArtifactSchema,
  ARTIFACT_ID_PATTERN,
  ARTIFACT_RESERVED_PREFIX,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MAX_PER_SESSION,
  type Artifact,
} from "../artifact-schema.js";

const validBase = {
  version: 1 as const,
  id: "test-artifact",
  title: "Test",
  createdAt: "2026-05-13T10:00:00.000Z",
  updatedAt: "2026-05-13T10:00:00.000Z",
};

describe("ArtifactSchema", () => {
  it("accepts a valid markdown artifact", () => {
    const artifact: Artifact = {
      ...validBase,
      type: "markdown",
      payload: { markdown: "# Hello" },
    };
    expect(ArtifactSchema.safeParse(artifact).success).toBe(true);
  });

  it("accepts a valid html artifact", () => {
    const artifact: Artifact = {
      ...validBase,
      type: "html",
      payload: { html: "<p>hi</p>" },
    };
    expect(ArtifactSchema.safeParse(artifact).success).toBe(true);
  });

  it("rejects invalid ids", () => {
    for (const id of ["", "Caps", "a/b", "a b", "-leading", "way-too-long-".repeat(20)]) {
      const result = ArtifactSchema.safeParse({ ...validBase, id, type: "markdown", payload: { markdown: "x" } });
      expect(result.success, `id "${id}" should fail`).toBe(false);
    }
  });

  it("accepts core- prefix at schema level (rejection happens at ingest)", () => {
    const result = ArtifactSchema.safeParse({
      ...validBase,
      id: "core-git-diff",
      type: "markdown",
      payload: { markdown: "x" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects markdown payload exceeding 64_000 chars", () => {
    const result = ArtifactSchema.safeParse({
      ...validBase,
      type: "markdown",
      payload: { markdown: "a".repeat(64_001) },
    });
    expect(result.success).toBe(false);
  });

  it("rejects html payload exceeding 200_000 chars", () => {
    const result = ArtifactSchema.safeParse({
      ...validBase,
      type: "html",
      payload: { html: "a".repeat(200_001) },
    });
    expect(result.success).toBe(false);
  });

  it("ARTIFACT_MAX_BYTES is 256 KB", () => {
    expect(ARTIFACT_MAX_BYTES).toBe(256 * 1024);
  });

  it("ARTIFACT_MAX_PER_SESSION is 32", () => {
    expect(ARTIFACT_MAX_PER_SESSION).toBe(32);
  });

  it("ARTIFACT_RESERVED_PREFIX is 'core-'", () => {
    expect(ARTIFACT_RESERVED_PREFIX).toBe("core-");
  });

  it("ARTIFACT_ID_PATTERN matches valid ids", () => {
    expect(ARTIFACT_ID_PATTERN.test("a")).toBe(true);
    expect(ARTIFACT_ID_PATTERN.test("agent-plan")).toBe(true);
    expect(ARTIFACT_ID_PATTERN.test("core-git-diff")).toBe(true);
    expect(ARTIFACT_ID_PATTERN.test("A")).toBe(false);
    expect(ARTIFACT_ID_PATTERN.test("-a")).toBe(false);
  });
});
