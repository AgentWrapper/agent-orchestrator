import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/program.js";
import { renderSkillsTable } from "../../src/commands/skills.js";

describe("ao skills", () => {
  it("registers the `skills list` subcommand", () => {
    const skills = createProgram().commands.find((c) => c.name() === "skills");
    expect(skills?.commands.some((c) => c.name() === "list")).toBe(true);
  });

  it("renders an empty-library placeholder", () => {
    expect(renderSkillsTable([])).toContain("no skills");
  });

  it("renders name, enabled state, and description for each skill", () => {
    const table = renderSkillsTable([
      { name: "swift-build-verify", description: "Build the app.", enabled: true },
      { name: "legacy-skill", description: "Off.", enabled: false },
    ]);
    expect(table).toContain("swift-build-verify");
    expect(table).toContain("Build the app.");
    expect(table).toContain("legacy-skill");
    // disabled skills render as "no" in the ENABLED column
    expect(table).toContain("no");
  });

  it("shows an em-dash for a skill with no description", () => {
    const table = renderSkillsTable([{ name: "x", description: "", enabled: true }]);
    expect(table).toContain("—");
  });
});
