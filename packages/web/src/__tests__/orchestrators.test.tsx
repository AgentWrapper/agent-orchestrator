import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import OrchestratorsRoute from "@/app/orchestrators/page";
import { getServices } from "@/lib/services";
import { getAllProjects } from "@/lib/project-name";

// ── Mocks ─────────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/lib/services", () => ({
  getServices: vi.fn(),
}));

vi.mock("@/lib/project-name", () => ({
  getAllProjects: vi.fn(),
}));

global.fetch = vi.fn();

// ── Tests ─────────────────────────────────────────────────────────────

describe("Orchestrators Page (OrchestratorsRoute)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the page with searchParams and listed orchestrators", async () => {
    const mockSessionManager = {
      list: vi.fn().mockResolvedValue([
        {
          id: "app-orchestrator",
          projectId: "my-app",
          status: "working",
          activity: "active",
          metadata: { role: "orchestrator" },
          createdAt: new Date(),
          lastActivityAt: new Date(),
        },
      ]),
    };

    (getServices as any).mockResolvedValue({
      config: {
        projects: {
          "my-app": { name: "My App", sessionPrefix: "app" },
        },
      },
      sessionManager: mockSessionManager,
    });

    (getAllProjects as any).mockReturnValue([{ id: "my-app", name: "My App" }]);

    const searchParams = Promise.resolve({ project: "my-app" });
    const jsx = await OrchestratorsRoute({ searchParams });
    render(jsx);

    expect(screen.getByText("My App")).toBeInTheDocument();
    expect(screen.getByText("app-orchestrator")).toBeInTheDocument();
  });

  it("shows error when project is missing in searchParams", async () => {
    const searchParams = Promise.resolve({});
    const jsx = await OrchestratorsRoute({ searchParams });
    render(jsx);

    expect(screen.getByText("Missing Project")).toBeInTheDocument();
  });

  it("shows error when project is not found in config", async () => {
    (getServices as any).mockResolvedValue({
      config: { projects: {} },
      sessionManager: { list: vi.fn() },
    });
    (getAllProjects as any).mockReturnValue([]);

    const searchParams = Promise.resolve({ project: "ghost" });
    const jsx = await OrchestratorsRoute({ searchParams });
    render(jsx);

    expect(screen.getByText('Project "ghost" not found')).toBeInTheDocument();
  });

  it("handles service errors gracefully", async () => {
    (getServices as any).mockRejectedValue(new Error("Database down"));

    const searchParams = Promise.resolve({ project: "my-app" });
    const jsx = await OrchestratorsRoute({ searchParams });
    render(jsx);

    expect(screen.getByText("Database down")).toBeInTheDocument();
  });
});
