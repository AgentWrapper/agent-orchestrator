import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAllProjectsMock, getPrimaryProjectIdMock, getProjectNameMock } = vi.hoisted(() => ({
  getAllProjectsMock: vi.fn(),
  getPrimaryProjectIdMock: vi.fn(),
  getProjectNameMock: vi.fn(),
}));

vi.mock("@/lib/project-name", () => ({
  getAllProjects: getAllProjectsMock,
  getPrimaryProjectId: getPrimaryProjectIdMock,
  getProjectName: getProjectNameMock,
}));

vi.mock("@/lib/services", () => ({
  getServices: vi.fn(),
  getSCM: vi.fn(),
}));

import { formatDashboardLoadError, resolveDashboardProjectFilter } from "@/lib/dashboard-page-data";

describe("resolveDashboardProjectFilter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAllProjectsMock.mockReturnValue([
      { id: "mono", name: "Mono" },
      { id: "docs", name: "Docs" },
    ]);
    getPrimaryProjectIdMock.mockReturnValue("mono");
    getProjectNameMock.mockReturnValue("Mono");
  });

  it("keeps valid project ids", () => {
    expect(resolveDashboardProjectFilter("docs")).toBe("docs");
  });

  it("keeps the all-projects sentinel", () => {
    expect(resolveDashboardProjectFilter("all")).toBe("all");
  });

  it("falls back to primary project for unknown ids", () => {
    expect(resolveDashboardProjectFilter("mono-orchestrator")).toBe("mono");
  });

  it("falls back to primary project when no project is given", () => {
    expect(resolveDashboardProjectFilter(undefined)).toBe("mono");
  });
});

describe("formatDashboardLoadError", () => {
  it("uses Error.message when present", () => {
    expect(formatDashboardLoadError(new Error("No agent-orchestrator.yaml found"))).toBe(
      "No agent-orchestrator.yaml found",
    );
  });

  it("trims whitespace from Error messages", () => {
    expect(formatDashboardLoadError(new Error("  boom  "))).toBe("boom");
  });

  it("keeps only the first non-empty line from multiline errors", () => {
    expect(formatDashboardLoadError(new Error("\n  config parse failed  \n  at line 4\n"))).toBe(
      "config parse failed",
    );
  });

  it("accepts string throws", () => {
    expect(formatDashboardLoadError("config invalid")).toBe("config invalid");
  });

  it("falls back for unknown throws", () => {
    expect(formatDashboardLoadError(null)).toMatch(/could not load dashboard data/i);
  });
});
