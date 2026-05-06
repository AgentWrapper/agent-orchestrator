import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import SessionLoading from "./loading";

describe("SessionLoading", () => {
  it("renders the session loading text", () => {
    render(<SessionLoading />);
    expect(screen.getByText("Loading session…")).toBeInTheDocument();
  });

  it("renders a spinning indicator", () => {
    const { container } = render(<SessionLoading />);
    const spinner = container.querySelector(".animate-spin");
    expect(spinner).toBeInTheDocument();
    expect(spinner?.tagName.toLowerCase()).toBe("svg");
  });
});
