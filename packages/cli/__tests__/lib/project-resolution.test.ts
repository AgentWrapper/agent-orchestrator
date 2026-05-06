import { describe, expect, it } from "vitest";
import { findProjectForDirectory } from "../../src/lib/project-resolution.js";

describe("findProjectForDirectory", () => {
  it("returns a project when cwd is inside a project subdirectory", () => {
    const projectId = findProjectForDirectory(
      {
        frontend: { path: "/repos/frontend" },
        backend: { path: "/repos/backend" },
      },
      "/repos/backend/packages/api",
    );

    expect(projectId).toBe("backend");
  });

  it("prefers the deepest matching project path", () => {
    const projectId = findProjectForDirectory(
      {
        monorepo: { path: "/repos/mono" },
        docs: { path: "/repos/mono/docs" },
      },
      "/repos/mono/docs/guides",
    );

    expect(projectId).toBe("docs");
  });

  it("returns null when cwd is outside every configured project", () => {
    const projectId = findProjectForDirectory(
      {
        frontend: { path: "/repos/frontend" },
      },
      "/repos/backend",
    );

    expect(projectId).toBeNull();
  });
});
