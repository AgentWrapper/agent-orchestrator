import { describe, expect, it } from "vitest";
import {
  deriveProjectIdFromPath,
  deriveProjectNameFromPath,
  getBreadcrumbs,
  getParentBrowsePath,
  joinBrowsePath,
} from "@/components/AddProjectModal.parts";

describe("AddProjectModal path helpers", () => {
  it("derives project metadata from Windows paths", () => {
    expect(deriveProjectIdFromPath("D:\\projects\\my-repo")).toBe("my-repo");
    expect(deriveProjectNameFromPath("D:\\projects\\my-repo")).toBe("My Repo");
  });

  it("joins and climbs Windows drive paths without falling back to home", () => {
    expect(joinBrowsePath("D:\\", "projects")).toBe("D:\\projects");
    expect(joinBrowsePath("D:\\projects", "my-repo")).toBe("D:\\projects\\my-repo");
    expect(getParentBrowsePath("D:\\projects\\my-repo")).toBe("D:\\projects");
    expect(getParentBrowsePath("D:\\projects")).toBe("D:\\");
    expect(getParentBrowsePath("D:\\")).toBeNull();
  });

  it("builds Windows breadcrumbs from the drive root", () => {
    expect(getBreadcrumbs("D:\\projects\\my-repo")).toEqual([
      { label: "D:", path: "D:\\" },
      { label: "projects", path: "D:\\projects" },
      { label: "my-repo", path: "D:\\projects\\my-repo" },
    ]);
  });
});
