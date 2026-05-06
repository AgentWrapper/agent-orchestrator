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

import NotFound from "./not-found";

describe("NotFound (global)", () => {
  it("renders the page-not-found message", () => {
    render(<NotFound />);
    expect(screen.getByText("Page not found")).toBeInTheDocument();
  });

  it("renders descriptive copy", () => {
    render(<NotFound />);
    expect(
      screen.getByText(
        "This route does not exist in the dashboard. Return to the main view to pick an active project or session.",
      ),
    ).toBeInTheDocument();
  });

  it("renders a link back to the dashboard", () => {
    render(<NotFound />);
    const link = screen.getByText("Back to dashboard");
    expect(link).toBeInTheDocument();
    expect(link.closest("a")).toHaveAttribute("href", "/");
  });

  it("renders the not-found icon", () => {
    const { container } = render(<NotFound />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });
});
