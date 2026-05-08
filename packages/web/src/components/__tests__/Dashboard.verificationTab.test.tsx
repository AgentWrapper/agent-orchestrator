import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../Dashboard";

const searchParamsMock = vi.hoisted(() => ({ value: new URLSearchParams() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => searchParamsMock.value,
}));

function mockEventSource() {
  global.EventSource = vi.fn(
    () =>
      ({
        onmessage: null,
        onerror: null,
        close: vi.fn(),
      }) as unknown as EventSource,
  ) as unknown as typeof EventSource;
}

describe("Dashboard verification tab", () => {
  beforeEach(() => {
    searchParamsMock.value = new URLSearchParams("tab=verification");
    mockEventSource();
    global.fetch = vi.fn();
  });

  it("loads merged-unverified issues in a dedicated verification tab", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        issues: [
          {
            id: "#157",
            title: "검증 탭 추가",
            description: "",
            url: "https://github.com/ComposioHQ/agent-orchestrator/issues/157",
            state: "open",
            labels: ["merged-unverified"],
            projectId: "ao",
          },
        ],
      }),
    } as Response);

    render(
      <Dashboard
        initialSessions={[]}
        projectId="ao"
        projectName="Agent Orchestrator"
        projects={[{ id: "ao", name: "Agent Orchestrator" }]}
      />,
    );

    expect(screen.getByRole("link", { name: "에이전트" })).toHaveAttribute("href", "/projects/ao");
    expect(screen.getByRole("link", { name: "검증" })).toHaveAttribute(
      "href",
      "/projects/ao?tab=verification",
    );

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/verify");
    });
    expect(await screen.findByRole("link", { name: "검증 탭 추가" })).toHaveAttribute(
      "href",
      "https://github.com/ComposioHQ/agent-orchestrator/issues/157",
    );
    expect(screen.getByText("merged-unverified")).toBeInTheDocument();
  });

  it("marks a verification issue as complete and removes it from the list", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          issues: [
            {
              id: "#157",
              title: "검증 탭 추가",
              description: "",
              url: "https://github.com/ComposioHQ/agent-orchestrator/issues/157",
              state: "open",
              labels: ["merged-unverified"],
              projectId: "ao",
            },
          ],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response);

    render(
      <Dashboard
        initialSessions={[]}
        projectId="ao"
        projectName="Agent Orchestrator"
        projects={[{ id: "ao", name: "Agent Orchestrator" }]}
      />,
    );

    await screen.findByRole("link", { name: "검증 탭 추가" });
    fireEvent.click(screen.getByRole("button", { name: "검증 완료" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenLastCalledWith("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issueId: "#157",
          projectId: "ao",
          action: "verify",
        }),
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole("link", { name: "검증 탭 추가" })).not.toBeInTheDocument();
    });
    expect(screen.getByText(/검증 대기 중인 이슈가 없습니다/)).toBeInTheDocument();
  });
});
