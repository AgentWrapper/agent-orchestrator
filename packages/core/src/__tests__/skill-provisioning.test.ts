import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionSkills } from "../skill-provisioning.js";

let projectRoot: string;
let worktreePath: string;

/** Write a skill into the project's `.maestro/skills/<name>/SKILL.md` library. */
function writeLibrarySkill(name: string, body: string): void {
  const dir = join(projectRoot, ".maestro", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body, "utf-8");
}

/** Path a provisioned skill would land at inside the worktree. */
function worktreeSkillPath(name: string): string {
  return join(worktreePath, ".claude", "skills", name, "SKILL.md");
}

const ENABLED_SKILL = `---
name: swift-build-verify
description: Build and test the Swift app.
---

# Build & verify
Run \`swift build\`.
`;

const DISABLED_SKILL = `---
name: legacy-skill
description: An old skill that is turned off.
enabled: false
---

# Legacy
Do not use me.
`;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "skill-prov-"));
  projectRoot = join(base, "project");
  worktreePath = join(base, "worktree");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
});

afterEach(() => {
  // base is the parent of both project + worktree
  rmSync(join(projectRoot, ".."), { recursive: true, force: true });
});

describe("provisionSkills", () => {
  it("copies only the listed skills into the worktree, preserving content", () => {
    writeLibrarySkill("swift-build-verify", ENABLED_SKILL);
    writeLibrarySkill("rust-core-test", "---\nname: rust-core-test\ndescription: x\n---\nbody");

    const result = provisionSkills({
      projectRoot,
      worktreePath,
      skills: ["swift-build-verify"],
    });

    expect(result.provisioned).toEqual(["swift-build-verify"]);
    expect(existsSync(worktreeSkillPath("swift-build-verify"))).toBe(true);
    expect(readFileSync(worktreeSkillPath("swift-build-verify"), "utf-8")).toBe(ENABLED_SKILL);
    // A skill present in the library but NOT listed must not be copied.
    expect(existsSync(worktreeSkillPath("rust-core-test"))).toBe(false);
  });

  it("provisions multiple listed skills", () => {
    writeLibrarySkill("a", "---\nname: a\ndescription: x\n---\nA");
    writeLibrarySkill("b", "---\nname: b\ndescription: y\n---\nB");

    const result = provisionSkills({ projectRoot, worktreePath, skills: ["a", "b"] });

    expect(result.provisioned.sort()).toEqual(["a", "b"]);
    expect(existsSync(worktreeSkillPath("a"))).toBe(true);
    expect(existsSync(worktreeSkillPath("b"))).toBe(true);
  });

  it("skips a skill disabled via frontmatter (enabled: false)", () => {
    writeLibrarySkill("legacy-skill", DISABLED_SKILL);

    const result = provisionSkills({
      projectRoot,
      worktreePath,
      skills: ["legacy-skill"],
    });

    expect(result.provisioned).toEqual([]);
    expect(result.disabled).toEqual(["legacy-skill"]);
    expect(existsSync(worktreeSkillPath("legacy-skill"))).toBe(false);
  });

  it("skips a missing skill without throwing", () => {
    writeLibrarySkill("present", ENABLED_SKILL.replace("swift-build-verify", "present"));

    const result = provisionSkills({
      projectRoot,
      worktreePath,
      skills: ["present", "does-not-exist"],
    });

    expect(result.provisioned).toEqual(["present"]);
    expect(result.missing).toEqual(["does-not-exist"]);
    expect(existsSync(worktreeSkillPath("present"))).toBe(true);
  });

  it("rejects unsafe names (path traversal) instead of escaping the library", () => {
    const result = provisionSkills({
      projectRoot,
      worktreePath,
      skills: ["../../etc/passwd", "good/../bad", "ok-name"],
    });

    expect(result.invalid).toContain("../../etc/passwd");
    expect(result.invalid).toContain("good/../bad");
    // ok-name has no library entry, so it lands in missing (not provisioned).
    expect(result.missing).toContain("ok-name");
    expect(result.provisioned).toEqual([]);
  });

  it("de-duplicates repeated names in the input", () => {
    writeLibrarySkill("dup", ENABLED_SKILL.replace("swift-build-verify", "dup"));

    const result = provisionSkills({
      projectRoot,
      worktreePath,
      skills: ["dup", "dup"],
    });

    expect(result.provisioned).toEqual(["dup"]);
  });

  it("treats a skill with no frontmatter as enabled (fail-open)", () => {
    writeLibrarySkill("plain", "# Just a body, no frontmatter\nrun things");

    const result = provisionSkills({ projectRoot, worktreePath, skills: ["plain"] });

    expect(result.provisioned).toEqual(["plain"]);
    expect(existsSync(worktreeSkillPath("plain"))).toBe(true);
  });
});
