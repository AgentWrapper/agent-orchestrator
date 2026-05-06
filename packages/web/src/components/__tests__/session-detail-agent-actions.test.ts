import { describe, expect, it } from "vitest";
import { buildAgentFixMessage } from "../session-detail-agent-actions";

const baseComment = {
  url: "https://github.com/acme/app/pull/1#discussion_r1",
  path: "packages/web/src/components/SessionDetail.tsx",
  body: "### Tighten the copy\n<!-- DESCRIPTION START -->Make the empty state shorter.<!-- DESCRIPTION END -->",
};

describe("buildAgentFixMessage", () => {
  it("includes the parsed bugbot title, description, file path, and resolve URL", () => {
    const message = buildAgentFixMessage(baseComment);
    expect(message).toContain(`File: ${baseComment.path}`);
    expect(message).toContain("Comment: Tighten the copy");
    expect(message).toContain("Description: Make the empty state shorter.");
    expect(message).toContain(`Resolve the comment at ${baseComment.url}`);
  });

  it("falls back to the raw body when the comment is not in bugbot format", () => {
    const message = buildAgentFixMessage({
      ...baseComment,
      body: "this is just a plain comment",
    });
    expect(message).toContain("Comment: Comment");
    expect(message).toContain("Description: this is just a plain comment");
  });

  it("truncates an overlong description with a single ellipsis", () => {
    const longDescription = "x".repeat(20_000);
    const message = buildAgentFixMessage({
      ...baseComment,
      body: `### Big one\n<!-- DESCRIPTION START -->${longDescription}<!-- DESCRIPTION END -->`,
    });
    const descriptionLine = message
      .split("\n")
      .find((line) => line.startsWith("Description: "))!;
    const value = descriptionLine.replace("Description: ", "");
    expect(value.length).toBeLessThanOrEqual(7_500);
    expect(value.endsWith("…")).toBe(true);
  });

  it("caps the entire message at the agent message length budget", () => {
    const huge = "y".repeat(50_000);
    const message = buildAgentFixMessage({
      ...baseComment,
      body: `### Title\n<!-- DESCRIPTION START -->${huge}<!-- DESCRIPTION END -->`,
    });
    expect(message.length).toBeLessThanOrEqual(9_500);
  });

  it("trims surrounding whitespace from the rendered fields", () => {
    const message = buildAgentFixMessage({
      ...baseComment,
      body: "### Spaced     \n<!-- DESCRIPTION START -->\n\n   spaced description    \n\n<!-- DESCRIPTION END -->",
    });
    expect(message).toContain("Comment: Spaced");
    expect(message).toContain("Description: spaced description");
  });
});
