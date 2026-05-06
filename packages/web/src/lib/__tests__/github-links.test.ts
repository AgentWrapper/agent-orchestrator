import { describe, expect, it } from "vitest";
import { buildGitHubCompareUrl } from "../github-links";

describe("buildGitHubCompareUrl", () => {
  it("builds a GitHub compare URL for base and head branches", () => {
    expect(
      buildGitHubCompareUrl({
        owner: "acme",
        repo: "app",
        baseBranch: "main",
        branch: "feat/foo-bar",
      }),
    ).toBe("https://github.com/acme/app/compare/main...feat%2Ffoo-bar");
  });

  it("encodes special characters in branch names", () => {
    expect(
      buildGitHubCompareUrl({
        owner: "o",
        repo: "r",
        baseBranch: "release/1.0",
        branch: "fix#123",
      }),
    ).toBe("https://github.com/o/r/compare/release%2F1.0...fix%23123");
  });

  it("encodes owner and repo segments", () => {
    expect(
      buildGitHubCompareUrl({
        owner: "../../evil",
        repo: "app?tab=code",
        baseBranch: "main",
        branch: "feat/x",
      }),
    ).toBe("https://github.com/..%2F..%2Fevil/app%3Ftab%3Dcode/compare/main...feat%2Fx");
  });
});
