import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    children,
    ...props
  }: React.PropsWithChildren<React.AnchorHTMLAttributes<HTMLAnchorElement>>) => (
    <a {...props}>{children}</a>
  ),
}));

import { ErrorDisplay } from "../ErrorDisplay";

describe("ErrorDisplay", () => {
  it("renders title, message, and actions", () => {
    const onRetry = vi.fn();

    render(
      <ErrorDisplay
        title="Failed to load session"
        message="Try again."
        primaryAction={{ label: "Try again", onClick: onRetry }}
        secondaryAction={{ label: "Back to dashboard", href: "/" }}
      />,
    );

    expect(screen.getByText("Failed to load session")).toBeInTheDocument();
    expect(screen.getByText("Try again.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    expect(screen.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute("href", "/");
  });

  it("renders technical details when provided", () => {
    render(
      <ErrorDisplay
        title="Something went wrong"
        message="Details are available."
        error={Object.assign(new Error("HTTP 500"), { digest: "abc123" })}
      />,
    );

    expect(screen.getByText("Technical details")).toBeInTheDocument();
    expect(screen.getByText(/digest: abc123/)).toBeInTheDocument();
    expect(screen.getByText("HTTP 500")).toBeInTheDocument();
  });
});
