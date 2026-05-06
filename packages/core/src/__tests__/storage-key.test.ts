import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveStorageKey, normalizeOriginUrl, relativeSubdir } from "../storage-key.js";

describe("storage-key", () => {
  describe("normalizeOriginUrl", () => {
    it("canonicalizes ssh and https forms to the same https url", () => {
      expect(normalizeOriginUrl("git@GitHub.com:OpenAI/Agent-Orchestrator.git")).toBe(
        "https://github.com/OpenAI/Agent-Orchestrator",
      );
      expect(normalizeOriginUrl("https://github.com/OpenAI/Agent-Orchestrator.git")).toBe(
        "https://github.com/OpenAI/Agent-Orchestrator",
      );
    });

    it("strips credentials, query strings, and fragments", () => {
      expect(normalizeOriginUrl("https://user:pass@GitHub.com/OpenAI/Agent-Orchestrator.git?x=1#frag")).toBe(
        "https://github.com/OpenAI/Agent-Orchestrator",
      );
    });

    it("lowercases only the hostname and preserves path case", () => {
      expect(normalizeOriginUrl("https://GITHUB.com/OpenAI/MixedCaseRepo")).toBe(
        "https://github.com/OpenAI/MixedCaseRepo",
      );
    });
  });

  describe("relativeSubdir", () => {
    it("returns an empty string at the repo root", () => {
      expect(relativeSubdir("/repo", "/repo")).toBe("");
    });

    it("returns a posix-separated subdir", () => {
      expect(relativeSubdir("/repo", "/repo/packages/api")).toBe("packages/api");
    });

    it("throws when the project path is outside the git root", () => {
      expect(() => relativeSubdir("/repo", "/other")).toThrow(/not within gitRoot/);
    });
  });

  describe("deriveStorageKey", () => {
    it("is deterministic for a repo root project", () => {
      const key = deriveStorageKey({
        originUrl: "git@github.com:OpenAI/agent-orchestrator.git",
        gitRoot: "/repo",
        projectPath: "/repo",
      });

      const expected = createHash("sha256")
        .update("https://github.com/OpenAI/agent-orchestrator#")
        .digest("hex")
        .slice(0, 12);

      expect(key).toBe(expected);
    });

    it("distinguishes monorepo subdirectories", () => {
      const rootKey = deriveStorageKey({
        originUrl: "https://github.com/OpenAI/agent-orchestrator.git",
        gitRoot: "/repo",
        projectPath: "/repo/packages/web",
      });
      const otherKey = deriveStorageKey({
        originUrl: "https://github.com/OpenAI/agent-orchestrator.git",
        gitRoot: "/repo",
        projectPath: "/repo/packages/core",
      });

      expect(rootKey).not.toBe(otherKey);
    });

    it("uses a synthetic local url when no origin exists", () => {
      const key = deriveStorageKey({
        originUrl: null,
        gitRoot: "/tmp/local-repo",
        projectPath: "/tmp/local-repo",
      });

      const expected = createHash("sha256")
        .update("local:///tmp/local-repo#")
        .digest("hex")
        .slice(0, 12);

      expect(key).toBe(expected);
    });
  });
});
