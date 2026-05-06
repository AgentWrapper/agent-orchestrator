import { describe, it, expect } from "vitest";
import { isValidRepoString, extractOwnerRepo } from "../../src/lib/repo-utils.js";

describe("isValidRepoString", () => {
  it("accepts valid owner/repo", () => {
    expect(isValidRepoString("acme/my-app")).toBe(true);
    expect(isValidRepoString("ComposioHQ/agent-orchestrator")).toBe(true);
    expect(isValidRepoString("org/repo")).toBe(true);
  });

  it("accepts GitLab subgroup paths", () => {
    expect(isValidRepoString("group/subgroup/repo")).toBe(true);
    expect(isValidRepoString("a/b/c/d")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidRepoString("")).toBe(false);
  });

  it("rejects lone slash", () => {
    expect(isValidRepoString("/")).toBe(false);
  });

  it("rejects missing owner", () => {
    expect(isValidRepoString("/repo")).toBe(false);
  });

  it("rejects missing repo name", () => {
    expect(isValidRepoString("owner/")).toBe(false);
  });

  it("rejects strings with whitespace", () => {
    expect(isValidRepoString("acme/repo extra")).toBe(false);
    expect(isValidRepoString("acme /repo")).toBe(false);
  });

  it("rejects strings without a slash", () => {
    expect(isValidRepoString("notaslash")).toBe(false);
  });

  it("rejects strings with spaces in segments", () => {
    expect(isValidRepoString("my org/repo")).toBe(false);
    expect(isValidRepoString("org/my repo")).toBe(false);
  });
});

describe("extractOwnerRepo", () => {
  it("extracts from GitHub HTTPS remote", () => {
    expect(extractOwnerRepo("https://github.com/acme/my-app.git")).toBe("acme/my-app");
  });

  it("extracts from GitHub SSH remote", () => {
    expect(extractOwnerRepo("git@github.com:acme/my-app.git")).toBe("acme/my-app");
  });

  it("extracts from GitLab HTTPS remote", () => {
    expect(extractOwnerRepo("https://gitlab.com/org/repo.git")).toBe("org/repo");
  });

  it("extracts from GitLab SSH remote", () => {
    expect(extractOwnerRepo("git@gitlab.com:org/repo.git")).toBe("org/repo");
  });

  it("extracts GitLab subgroup paths", () => {
    expect(extractOwnerRepo("git@gitlab.com:group/subgroup/repo.git")).toBe("group/subgroup/repo");
  });

  it("handles remotes without .git suffix", () => {
    expect(extractOwnerRepo("https://github.com/acme/my-app")).toBe("acme/my-app");
  });

  it("returns null for unknown hosts", () => {
    expect(extractOwnerRepo("git@git.corp.com:team/project.git")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractOwnerRepo("")).toBeNull();
  });
});
