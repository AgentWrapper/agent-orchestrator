import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import Loading from "./loading";

describe("Loading (global)", () => {
  it("renders the loading text", () => {
    render(<Loading />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders a spinning indicator", () => {
    const { container } = render(<Loading />);
    const spinner = container.querySelector(".animate-spin");
    expect(spinner).toBeInTheDocument();
    expect(spinner?.tagName.toLowerCase()).toBe("svg");
  });
});
