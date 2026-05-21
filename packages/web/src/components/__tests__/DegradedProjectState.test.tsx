import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DegradedProjectState } from "@/components/DegradedProjectState";

vi.mock("next/link", () => ({
  default: ({
    children,
    ...props
  }: React.PropsWithChildren<React.AnchorHTMLAttributes<HTMLAnchorElement>>) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("@/components/RepairDegradedProjectButton", () => ({
  RepairDegradedProjectButton: ({ projectId }: { projectId: string }) => (
    <button>Repair {projectId}</button>
  ),
}));

const baseProps = {
  projectId: "my-project",
  resolveError: "Local config at /tmp/my-project/agent-orchestrator.yaml failed validation: bad field",
  projectPath: "/tmp/my-project",
};

describe("DegradedProjectState", () => {
  it("renders the default heading", () => {
    render(<DegradedProjectState {...baseProps} />);
    expect(screen.getByText("This project's config failed to load")).toBeInTheDocument();
  });

  it("renders a custom heading when provided", () => {
    render(<DegradedProjectState {...baseProps} heading="Custom heading" />);
    expect(screen.getByText("Custom heading")).toBeInTheDocument();
  });

  it("displays the resolve error", () => {
    render(<DegradedProjectState {...baseProps} />);
    expect(screen.getByText(baseProps.resolveError)).toBeInTheDocument();
  });

  it("extracts and displays the config path from the resolve error", () => {
    render(<DegradedProjectState {...baseProps} />);
    expect(
      screen.getByText("/tmp/my-project/agent-orchestrator.yaml"),
    ).toBeInTheDocument();
  });

  it("falls back to the project path when the config path cannot be parsed from the error", () => {
    render(
      <DegradedProjectState
        {...baseProps}
        resolveError="Something went wrong"
      />,
    );
    expect(
      screen.getByText("/tmp/my-project/agent-orchestrator.yaml or .yml"),
    ).toBeInTheDocument();
  });

  it("renders 'Back to dashboard' link pointing to /", () => {
    render(<DegradedProjectState {...baseProps} />);
    const link = screen.getByRole("link", { name: "Back to dashboard" });
    expect(link).toHaveAttribute("href", "/");
  });

  it("does not render an 'Edit settings' link", () => {
    render(<DegradedProjectState {...baseProps} />);
    expect(screen.queryByRole("link", { name: "Edit settings" })).not.toBeInTheDocument();
  });

  it("does not show the repair button for a generic validation error", () => {
    render(<DegradedProjectState {...baseProps} />);
    expect(screen.queryByRole("button", { name: /repair/i })).not.toBeInTheDocument();
  });

  it("shows the repair button when the error indicates a wrapped projects format", () => {
    render(
      <DegradedProjectState
        {...baseProps}
        resolveError="Local config at /tmp/x/agent-orchestrator.yaml still uses a wrapped projects: format"
      />,
    );
    expect(screen.getByRole("button", { name: /repair/i })).toBeInTheDocument();
  });
});
