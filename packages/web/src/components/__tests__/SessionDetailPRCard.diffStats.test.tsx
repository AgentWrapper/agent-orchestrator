import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionDetailPRCard } from "../SessionDetailPRCard";
import { makePR } from "../../__tests__/helpers";

describe("SessionDetailPRCard diff stats", () => {
  it("shows diff stats for enriched PRs", () => {
    render(
      <SessionDetailPRCard
        pr={makePR({
          enriched: true,
          additions: 629,
          deletions: 44,
        })}
        metadata={{}}
        onAskAgentToFix={vi.fn()}
      />,
    );

    expect(screen.getByText("+629")).toBeInTheDocument();
    expect(screen.getByText("-44")).toBeInTheDocument();
  });

  it("hides diff stats for unenriched PRs", () => {
    render(
      <SessionDetailPRCard
        pr={makePR({
          enriched: false,
          additions: 629,
          deletions: 44,
        })}
        metadata={{}}
        onAskAgentToFix={vi.fn()}
      />,
    );

    expect(screen.queryByText("+629")).not.toBeInTheDocument();
    expect(screen.queryByText("-44")).not.toBeInTheDocument();
  });
});
