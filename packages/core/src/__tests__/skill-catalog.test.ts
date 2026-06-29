import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProjectSkills, parseSkillFrontmatter } from "../skill-provisioning.js";

let projectRoot: string;

/** Write a skill into the project's `.maestro/skills/<name>/SKILL.md` library. */
function writeLibrarySkill(name: string, body: string): void {
  const dir = join(projectRoot, ".maestro", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body, "utf-8");
}

const ENABLED_SKILL = `---
name: swift-build-verify
description: Build and test the Swift app.
---

# Build & verify
`;

const DISABLED_SKILL = `---
name: legacy-skill
description: An old skill that is turned off.
enabled: false
---

# Legacy
`;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "skill-catalog-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("parseSkillFrontmatter", () => {
  it("reads name, description, and enabled", () => {
    expect(parseSkillFrontmatter(ENABLED_SKILL)).toEqual({
      name: "swift-build-verify",
      description: "Build and test the Swift app.",
      enabled: true,
    });
  });

  it("treats explicit enabled: false as disabled", () => {
    expect(parseSkillFrontmatter(DISABLED_SKILL).enabled).toBe(false);
  });

  it("is fail-open (enabled) when frontmatter is absent or unparseable", () => {
    expect(parseSkillFrontmatter("# no frontmatter\nbody").enabled).toBe(true);
    expect(parseSkillFrontmatter("---\n: : bad yaml :\n---\nbody").enabled).toBe(true);
  });
});

describe("listProjectSkills", () => {
  it("returns [] for a project with no skill library", () => {
    expect(listProjectSkills(projectRoot)).toEqual([]);
  });

  it("returns [] for an empty library directory", () => {
    mkdirSync(join(projectRoot, ".maestro", "skills"), { recursive: true });
    expect(listProjectSkills(projectRoot)).toEqual([]);
  });

  it("enumerates skills sorted by name with parsed metadata", () => {
    writeLibrarySkill("swift-build-verify", ENABLED_SKILL);
    writeLibrarySkill("legacy-skill", DISABLED_SKILL);

    const catalog = listProjectSkills(projectRoot);

    expect(catalog).toEqual([
      {
        name: "legacy-skill",
        description: "An old skill that is turned off.",
        enabled: false,
      },
      {
        name: "swift-build-verify",
        description: "Build and test the Swift app.",
        enabled: true,
      },
    ]);
  });

  it("defaults enabled to true and description to '' when frontmatter is missing", () => {
    writeLibrarySkill("plain", "# Just a body, no frontmatter\n");

    expect(listProjectSkills(projectRoot)).toEqual([
      { name: "plain", description: "", enabled: true },
    ]);
  });

  it("uses the folder name as the canonical name even if frontmatter name differs", () => {
    writeLibrarySkill("folder-name", "---\nname: different\ndescription: d\n---\n");

    expect(listProjectSkills(projectRoot)[0].name).toBe("folder-name");
  });

  it("skips folders without a SKILL.md", () => {
    mkdirSync(join(projectRoot, ".maestro", "skills", "no-manifest"), { recursive: true });
    writeLibrarySkill("real", ENABLED_SKILL);

    expect(listProjectSkills(projectRoot).map((s) => s.name)).toEqual(["real"]);
  });

  it("produces the JSON contract shape { name, description, enabled }", () => {
    writeLibrarySkill("a", "---\nname: a\ndescription: x\n---\n");

    const json = JSON.parse(JSON.stringify(listProjectSkills(projectRoot)));
    expect(json).toEqual([{ name: "a", description: "x", enabled: true }]);
  });
});
