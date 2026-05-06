import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isGitBranchNameSafe,
  isRetryableHttpStatus,
  normalizeRetryConfig,
  readLastJsonlEntry,
} from "../utils.js";
import { parsePrFromUrl } from "../utils/pr.js";

describe("readLastJsonlEntry", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(content: string): string {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-utils-test-"));
    const filePath = join(tmpDir, "test.jsonl");
    writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  it("returns null for empty file", async () => {
    const path = setup("");
    expect(await readLastJsonlEntry(path)).toBeNull();
  });

  it("returns null for nonexistent file", async () => {
    expect(await readLastJsonlEntry("/tmp/nonexistent-ao-test.jsonl")).toBeNull();
  });

  it("reads last entry type from single-line JSONL", async () => {
    const path = setup('{"type":"assistant","message":"hello"}\n');
    const result = await readLastJsonlEntry(path);
    expect(result).not.toBeNull();
    expect(result!.lastType).toBe("assistant");
  });

  it("reads last entry from multi-line JSONL", async () => {
    const path = setup(
      '{"type":"human","text":"hi"}\n{"type":"assistant","text":"hello"}\n{"type":"result","text":"done"}\n',
    );
    const result = await readLastJsonlEntry(path);
    expect(result!.lastType).toBe("result");
  });

  it("handles trailing newlines", async () => {
    const path = setup('{"type":"done"}\n\n\n');
    const result = await readLastJsonlEntry(path);
    expect(result!.lastType).toBe("done");
  });

  it("returns lastType null for entry without type field", async () => {
    const path = setup('{"message":"no type"}\n');
    const result = await readLastJsonlEntry(path);
    expect(result).not.toBeNull();
    expect(result!.lastType).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    const path = setup("not json at all\n");
    expect(await readLastJsonlEntry(path)).toBeNull();
  });

  it("handles multi-byte UTF-8 characters in JSONL entries", async () => {
    // Create a JSONL entry with multi-byte characters (CJK, emoji)
    const entry = { type: "assistant", text: "日本語テスト 🎉 données résumé" };
    const path = setup(JSON.stringify(entry) + "\n");
    const result = await readLastJsonlEntry(path);
    expect(result!.lastType).toBe("assistant");
  });

  it("handles multi-byte UTF-8 at chunk boundaries", async () => {
    // Create content larger than the 4096 byte chunk size with multi-byte
    // characters that could straddle a boundary. Each 🎉 is 4 bytes.
    const padding = '{"type":"padding","data":"' + "x".repeat(4080) + '"}\n';
    // The emoji-heavy last line will be at a chunk boundary
    const lastLine = { type: "final", text: "🎉".repeat(100) };
    const path = setup(padding + JSON.stringify(lastLine) + "\n");
    const result = await readLastJsonlEntry(path);
    expect(result!.lastType).toBe("final");
  });

  it("returns modifiedAt as a Date", async () => {
    const path = setup('{"type":"test"}\n');
    const result = await readLastJsonlEntry(path);
    expect(result!.modifiedAt).toBeInstanceOf(Date);
  });

  it("extracts payloadType from nested payload.type", async () => {
    // Real Codex writes records like {"type":"event_msg","payload":{"type":"error",...}}
    // Consumers need the inner payload.type to classify activity correctly.
    const path = setup(
      '{"type":"event_msg","payload":{"type":"error","message":"bad"}}\n',
    );
    const result = await readLastJsonlEntry(path);
    expect(result!.lastType).toBe("event_msg");
    expect(result!.payloadType).toBe("error");
  });

  it("returns payloadType null when payload has no type field", async () => {
    const path = setup('{"type":"session_meta","payload":{"cwd":"/workspace"}}\n');
    const result = await readLastJsonlEntry(path);
    expect(result!.lastType).toBe("session_meta");
    expect(result!.payloadType).toBeNull();
  });

  it("returns payloadType null when payload is not an object", async () => {
    const path = setup('{"type":"x","payload":"string"}\n');
    const result = await readLastJsonlEntry(path);
    expect(result!.lastType).toBe("x");
    expect(result!.payloadType).toBeNull();
  });
});

describe("isGitBranchNameSafe", () => {
  it("accepts typical Linear-style branch names", () => {
    expect(isGitBranchNameSafe("feature/foo-bar-123")).toBe(true);
    expect(isGitBranchNameSafe("feat/INT-123")).toBe(true);
  });

  it("rejects empty, @, lock suffix, double dots, and leading dot", () => {
    expect(isGitBranchNameSafe("")).toBe(false);
    expect(isGitBranchNameSafe("@")).toBe(false);
    expect(isGitBranchNameSafe("foo.lock")).toBe(false);
    expect(isGitBranchNameSafe("a..b")).toBe(false);
    expect(isGitBranchNameSafe(".hidden")).toBe(false);
  });

  it("rejects consecutive slashes and dot-prefixed components", () => {
    expect(isGitBranchNameSafe("feat//bar")).toBe(false);
    expect(isGitBranchNameSafe("feat/.hidden")).toBe(false);
  });

  it("rejects characters invalid in git refs", () => {
    expect(isGitBranchNameSafe("bad branch")).toBe(false);
    expect(isGitBranchNameSafe("x:y")).toBe(false);
    expect(isGitBranchNameSafe("x~y")).toBe(false);
    expect(isGitBranchNameSafe("x?y")).toBe(false);
    expect(isGitBranchNameSafe("x[y]")).toBe(false);
    expect(isGitBranchNameSafe("a\nb")).toBe(false);
  });
});

describe("retry utilities", () => {
  it("marks 429 and 5xx statuses as retryable", () => {
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
  });

  it("marks 4xx statuses (except 429) as non-retryable", () => {
    expect(isRetryableHttpStatus(400)).toBe(false);
    expect(isRetryableHttpStatus(401)).toBe(false);
    expect(isRetryableHttpStatus(404)).toBe(false);
  });

  it("normalizes retry config with defaults", () => {
    expect(normalizeRetryConfig(undefined)).toEqual({ retries: 2, retryDelayMs: 1000 });
  });

  it("normalizes retry config values and clamps invalid input", () => {
    expect(normalizeRetryConfig({ retries: 4, retryDelayMs: 250 })).toEqual({
      retries: 4,
      retryDelayMs: 250,
    });
    expect(normalizeRetryConfig({ retries: -1, retryDelayMs: -50 })).toEqual({
      retries: 0,
      retryDelayMs: 1000,
    });
  });
});

describe("parsePrFromUrl", () => {
  it("parses GitHub PR URLs", () => {
    expect(parsePrFromUrl("https://github.com/foo/bar/pull/123")).toEqual({
      owner: "foo",
      repo: "bar",
      number: 123,
      url: "https://github.com/foo/bar/pull/123",
    });
  });

  it("falls back to trailing number for non-GitHub URLs", () => {
    expect(parsePrFromUrl("https://gitlab.com/foo/bar/-/merge_requests/456")).toEqual({
      owner: "foo",
      repo: "bar",
      number: 456,
      url: "https://gitlab.com/foo/bar/-/merge_requests/456",
    });
  });

  it("parses GitHub Enterprise pull request URLs", () => {
    expect(parsePrFromUrl("https://github.example.com/foo/bar/pull/789")).toEqual({
      owner: "foo",
      repo: "bar",
      number: 789,
      url: "https://github.example.com/foo/bar/pull/789",
    });
  });

  it("parses GitHub pull request URLs with trailing path segments", () => {
    expect(parsePrFromUrl("https://github.com/foo/bar/pull/123/files")).toEqual({
      owner: "foo",
      repo: "bar",
      number: 123,
      url: "https://github.com/foo/bar/pull/123/files",
    });
  });

  it("returns null when the URL has no PR number", () => {
    expect(parsePrFromUrl("https://example.com/foo/bar/pull/not-a-number")).toBeNull();
  });
});
