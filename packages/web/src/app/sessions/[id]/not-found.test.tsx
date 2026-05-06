import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    children,
    ...props
  }: React.PropsWithChildren<React.AnchorHTMLAttributes<HTMLAnchorElement>>) => (
    <a {...props}>{children}</a>
  ),
}));

import SessionNotFound from "./not-found";

describe("SessionNotFound", () => {
  it("renders the session-not-found message", () => {
    render(<SessionNotFound />);
    expect(screen.getByText("Session not found")).toBeInTheDocument();
  });

  it("renders descriptive subtext", () => {
    render(<SessionNotFound />);
    expect(
      screen.getByText(
        "The session you’re looking for does not exist anymore, or the link is stale.",
      ),
    ).toBeInTheDocument();
  });

  it("renders a link back to the dashboard", () => {
    render(<SessionNotFound />);
    const link = screen.getByText("Back to dashboard");
    expect(link).toBeInTheDocument();
    expect(link.closest("a")).toHaveAttribute("href", "/");
  });

  it("renders the terminal icon", () => {
    const { container } = render(<SessionNotFound />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });
});
