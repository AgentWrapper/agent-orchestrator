import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getProjectRouteDataMock: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    ...props
  }: React.PropsWithChildren<React.AnchorHTMLAttributes<HTMLAnchorElement>>) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/project-route-data", () => ({
  getProjectRouteData: hoisted.getProjectRouteDataMock,
}));

import ProjectSettingsPage from "./page";

describe("ProjectSettingsPage", () => {
  it("loads project config and renders the current values", async () => {
    hoisted.getProjectRouteDataMock.mockResolvedValue({
      projectId: "docs",
      degradedProject: null,
      projects: [{ id: "docs", name: "Docs" }],
      project: {
        name: "Docs",
        path: "/tmp/docs",
        repo: "org/repo",
        defaultBranch: "main",
        sessionPrefix: "docs",
        agent: "codex",
        runtime: "tmux",
        tracker: { plugin: "github" },
        scm: { plugin: "github" },
        reactions: { "ci-failed": { auto: true, action: "send-to-agent" } },
      },
    });

    render(await ProjectSettingsPage({ params: Promise.resolve({ projectId: "docs" }) }));

    expect(screen.getByRole("heading", { name: "Docs" })).toBeInTheDocument();
    expect(screen.getByLabelText("Agent")).toHaveValue("codex");
    expect(screen.getByLabelText("Runtime")).toHaveValue("tmux");
    expect(screen.getByLabelText("Tracker plugin")).toHaveValue("github");
    expect(screen.getByLabelText("SCM plugin")).toHaveValue("github");
    expect(screen.getByDisplayValue("/tmp/docs")).toBeDisabled();
    expect(screen.getByDisplayValue("org/repo")).toBeDisabled();
  });

  it("renders degraded state instead of the form for degraded projects", async () => {
    hoisted.getProjectRouteDataMock.mockResolvedValue({
      projectId: "broken",
      project: null,
      projects: [{ id: "broken", name: "Broken" }],
      degradedProject: {
        projectId: "broken",
        path: "/tmp/broken",
        resolveError: "Local config failed validation",
      },
    });

    render(await ProjectSettingsPage({ params: Promise.resolve({ projectId: "broken" }) }));

    expect(
      screen.getByText("This project's settings can't be edited until its config loads cleanly"),
    ).toBeInTheDocument();
    expect(screen.getByText("Local config failed validation")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });
});
