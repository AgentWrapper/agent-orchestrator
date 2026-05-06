import { beforeEach, describe, expect, it, vi } from "vitest";
import { derivePortfolioProjectId, resolvePortfolioProject, resolvePortfolioSession } from "../portfolio-routing.js";
import type { PortfolioProject } from "../types.js";

const { listPortfolioSessionsMock } = vi.hoisted(() => ({
  listPortfolioSessionsMock: vi.fn(),
}));

vi.mock("../portfolio-session-service.js", () => ({
  listPortfolioSessions: listPortfolioSessionsMock,
}));

describe("portfolio-routing", () => {
  const portfolio: PortfolioProject[] = [
    {
      id: "docs",
      name: "Docs",
      configPath: "/tmp/global-config.yaml",
      configProjectKey: "docs",
      repoPath: "/tmp/docs",
      sessionPrefix: "docs",
      source: "config",
      enabled: true,
      pinned: false,
      lastSeenAt: new Date().toISOString(),
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves a project by id", () => {
    expect(resolvePortfolioProject(portfolio, "docs")?.name).toBe("Docs");
    expect(resolvePortfolioProject(portfolio, "missing")).toBeUndefined();
  });

  it("resolves a session within the selected project", async () => {
    listPortfolioSessionsMock.mockResolvedValue([
      {
        project: portfolio[0],
        session: { id: "docs-2" },
      },
    ]);

    const result = await resolvePortfolioSession(portfolio, "docs", "docs-2");

    expect(listPortfolioSessionsMock).toHaveBeenCalledWith([portfolio[0]]);
    expect(result?.session.id).toBe("docs-2");
  });

  it("derives a collision-safe project id", () => {
    expect(derivePortfolioProjectId("docs", new Set(["api"]))).toBe("docs");
    expect(derivePortfolioProjectId("docs", new Set(["docs", "docs-2"]))).toBe("docs-3");
  });
});
