import { describe, expect, it } from "vitest";
import { validateConfiguredProject } from "@/lib/validation";

describe("validateConfiguredProject", () => {
  const projects = { "my-app": { name: "My App" }, docs: { name: "Docs" } };

  it("returns null for a configured project", () => {
    expect(validateConfiguredProject(projects, "my-app")).toBeNull();
  });

  it("returns error for an unknown project id", () => {
    expect(validateConfiguredProject(projects, "ghost")).toBe("Unknown project: ghost");
  });

  it("rejects prototype chain keys like 'constructor'", () => {
    expect(validateConfiguredProject(projects, "constructor")).toBe("Unknown project: constructor");
  });

  it("rejects prototype chain keys like 'toString'", () => {
    expect(validateConfiguredProject(projects, "toString")).toBe("Unknown project: toString");
  });

  it("rejects '__proto__'", () => {
    expect(validateConfiguredProject(projects, "__proto__")).toBe("Unknown project: __proto__");
  });
});
