import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PRCard } from "../PRStatus";
import { makePR } from "../../__tests__/helpers";

describe("PRCard diff coverage", () => {
  it("shows fallback review and CI labels for unenriched PRs", () => {
    const { container } = render(
      <PRCard
        pr={makePR({
          number: 635,
          title: "Hydrate PR details later",
          enriched: false,
        })}
      />,
    );

    expect(screen.getByRole("link", { name: /#635/i })).toBeTruthy();
    expect(screen.queryByText("approved")).toBeNull();
    expect(screen.queryByText("CI passing")).toBeNull();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThanOrEqual(2);
  });

  it("does not show review-needed text for merged PRs", () => {
    render(
      <PRCard
        pr={makePR({
          number: 636,
          title: "Already merged",
          state: "merged",
          reviewDecision: "pending",
        })}
      />,
    );

    expect(screen.getByText("merged")).toBeInTheDocument();
    expect(screen.queryByText("needs review")).toBeNull();
  });
});
