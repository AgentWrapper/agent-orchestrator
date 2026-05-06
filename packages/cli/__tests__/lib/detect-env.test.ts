import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/shell.js", () => ({
  git: vi.fn(),
  gh: vi.fn(),
  execSilent: vi.fn(),
}));

vi.mock("../../src/lib/git-utils.js", () => ({
  detectDefaultBranch: vi.fn().mockResolvedValue("main"),
}));

import { detectEnvironment } from "../../src/lib/detect-env.js";
import { git, execSilent } from "../../src/lib/shell.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(execSilent).mockResolvedValue(null);
});

describe("detectEnvironment", () => {
  describe("ownerRepo extraction", () => {
    it("extracts owner/repo from GitHub HTTPS remote", async () => {
      vi.mocked(git)
        .mockResolvedValueOnce(".git") // rev-parse
        .mockResolvedValueOnce("https://github.com/acme/my-app.git") // remote
        .mockResolvedValueOnce("main"); // branch

      const env = await detectEnvironment("/tmp/test");
      expect(env.ownerRepo).toBe("acme/my-app");
    });

    it("extracts owner/repo from GitHub SSH remote", async () => {
      vi.mocked(git)
        .mockResolvedValueOnce(".git")
        .mockResolvedValueOnce("git@github.com:acme/my-app.git")
        .mockResolvedValueOnce("main");

      const env = await detectEnvironment("/tmp/test");
      expect(env.ownerRepo).toBe("acme/my-app");
    });

    it("extracts owner/repo from GitLab HTTPS remote", async () => {
      vi.mocked(git)
        .mockResolvedValueOnce(".git")
        .mockResolvedValueOnce("https://gitlab.com/org/repo.git")
        .mockResolvedValueOnce("main");

      const env = await detectEnvironment("/tmp/test");
      expect(env.ownerRepo).toBe("org/repo");
    });

    it("extracts owner/repo from GitLab SSH remote", async () => {
      vi.mocked(git)
        .mockResolvedValueOnce(".git")
        .mockResolvedValueOnce("git@gitlab.com:org/repo.git")
        .mockResolvedValueOnce("main");

      const env = await detectEnvironment("/tmp/test");
      expect(env.ownerRepo).toBe("org/repo");
    });

    it("extracts GitLab subgroup paths", async () => {
      vi.mocked(git)
        .mockResolvedValueOnce(".git")
        .mockResolvedValueOnce("git@gitlab.com:group/subgroup/repo.git")
        .mockResolvedValueOnce("main");

      const env = await detectEnvironment("/tmp/test");
      expect(env.ownerRepo).toBe("group/subgroup/repo");
    });

    it("returns null for self-hosted / unknown git hosts", async () => {
      vi.mocked(git)
        .mockResolvedValueOnce(".git")
        .mockResolvedValueOnce("git@git.corp.com:team/project.git")
        .mockResolvedValueOnce("main");

      const env = await detectEnvironment("/tmp/test");
      expect(env.ownerRepo).toBeNull();
    });

    it("returns null when no remote is configured", async () => {
      vi.mocked(git)
        .mockResolvedValueOnce(".git")
        .mockResolvedValueOnce(null) // no remote
        .mockResolvedValueOnce("main");

      const env = await detectEnvironment("/tmp/test");
      expect(env.ownerRepo).toBeNull();
      expect(env.gitRemote).toBeNull();
    });

    it("returns null when not a git repo", async () => {
      vi.mocked(git).mockResolvedValueOnce(null); // not a git repo

      const env = await detectEnvironment("/tmp/test");
      expect(env.isGitRepo).toBe(false);
      expect(env.ownerRepo).toBeNull();
    });
  });
});
