import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSettingsForm } from "@/components/ProjectSettingsForm";

const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn(), replace: vi.fn() }),
}));

describe("ProjectSettingsForm", () => {
  beforeEach(() => {
    refreshMock.mockReset();
    global.fetch = vi.fn();
  });

  it("submits only behavior fields and keeps identity fields disabled", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response);

    render(
      <ProjectSettingsForm
        projectId="docs"
        initialValues={{
          agent: "codex",
          runtime: "tmux",
          trackerPlugin: "github",
          scmPlugin: "github",
          reactions: '{\n  "ci-failed": {\n    "auto": true,\n    "action": "send-to-agent"\n  }\n}',
          identity: {
            projectId: "docs",
            path: "/tmp/docs",
            repo: "org/repo",
            defaultBranch: "main",
          },
        }}
      />,
    );

    expect(screen.getByDisplayValue("/tmp/docs")).toBeDisabled();
    expect(screen.getByDisplayValue("org/repo")).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "claude-code" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/projects/docs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: "claude-code",
          runtime: "tmux",
          tracker: { plugin: "github" },
          scm: { plugin: "github" },
          reactions: {
            "ci-failed": {
              auto: true,
              action: "send-to-agent",
            },
          },
        }),
      });
    });

    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalled();
      expect(screen.getByText("Project settings updated.")).toBeInTheDocument();
    });
  });

  it("shows an inline error for a 400 without losing form state", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "Identity fields are frozen: path" }),
    } as Response);

    render(
      <ProjectSettingsForm
        projectId="docs"
        initialValues={{
          agent: "codex",
          runtime: "tmux",
          trackerPlugin: "github",
          scmPlugin: "github",
          reactions: "{}",
          identity: {
            projectId: "docs",
            path: "/tmp/docs",
            repo: "org/repo",
            defaultBranch: "main",
          },
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "cursor" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Identity fields are frozen: path");
    });
    expect(screen.getByDisplayValue("cursor")).toBeInTheDocument();
  });
});
