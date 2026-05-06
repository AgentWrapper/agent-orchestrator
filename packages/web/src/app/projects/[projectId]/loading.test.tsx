import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ProjectRouteLoading from "./loading";

describe("ProjectRouteLoading", () => {
  it("renders the project shell chrome during route loading", () => {
    render(<ProjectRouteLoading />);

    expect(screen.getByText("Agent Orchestrator")).toBeInTheDocument();
    expect(screen.getByText("Loading project…")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByLabelText("Loading project dashboard")).toBeInTheDocument();
  });
});
