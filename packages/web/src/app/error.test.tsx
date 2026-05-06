import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    ...props
  }: React.PropsWithChildren<React.AnchorHTMLAttributes<HTMLAnchorElement>>) => (
    <a {...props}>{children}</a>
  ),
}));

import ErrorPage from "./error";

describe("Route error boundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("retries with reset and router refresh", () => {
    const reset = vi.fn();

    render(<ErrorPage error={new Error("boom")} reset={reset} />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(reset).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("renders a dashboard escape hatch", () => {
    render(<ErrorPage error={new Error("boom")} reset={vi.fn()} />);

    expect(screen.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute("href", "/");
  });
});
