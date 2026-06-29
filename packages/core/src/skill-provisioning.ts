/**
 * Task-scoped skill provisioning for worker spawns.
 *
 * When `ao spawn --skills <name,...>` runs, the engine copies the named
 * `SKILL.md` files from the project's skill-pool library
 * (`<projectRoot>/.maestro/skills/<name>/SKILL.md`) into the new worktree's
 * `.claude/skills/<name>/SKILL.md`, where Claude Agent Skills are picked up
 * natively. Only the listed skills are copied — the worker's skill scope is
 * deliberately bounded to the task, it does not see the whole library.
 *
 * FAIL-OPEN by design: a missing skill, a skill disabled via frontmatter, or an
 * unsafe name is skipped (and reported via the result), never throwing.
 * Provisioning must never break a spawn.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface SkillProvisionResult {
  /** Names whose `SKILL.md` was copied into the worktree. */
  provisioned: string[];
  /** Names with no matching folder in the project skill library. */
  missing: string[];
  /** Names skipped because their frontmatter declares `enabled: false`. */
  disabled: string[];
  /** Names rejected as unsafe (path traversal / unexpected characters). */
  invalid: string[];
}

/**
 * Skill names are kebab-case folder names that match the frontmatter `name`,
 * never paths. Anchor the whole string and forbid `..` so a malicious or
 * fat-fingered `--skills ../../etc` can't escape the library directory.
 */
const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Extract the leading YAML frontmatter block (`---\n…\n---`) from a SKILL.md.
 * Returns null when the file has no frontmatter.
 */
function extractFrontmatter(content: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  return match ? match[1] : null;
}

/**
 * A skill is disabled only when its frontmatter explicitly sets
 * `enabled: false`. An enabled skill is the clean `name` + `description` form
 * with no `enabled` key (Phase-1 convention), so the absence of the key — or
 * any unparseable frontmatter — is treated as enabled (fail-open: don't drop a
 * skill the user explicitly asked for over a parse hiccup).
 */
function isSkillDisabled(content: string): boolean {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return false;
  try {
    const parsed = parseYaml(frontmatter) as Record<string, unknown> | null;
    return parsed?.enabled === false;
  } catch {
    return false;
  }
}

/**
 * Copy the selected skills from the project skill library into the worktree's
 * `.claude/skills/`. Duplicates in the input list are de-duplicated. See the
 * module docstring for the fail-open contract.
 */
export function provisionSkills(opts: {
  projectRoot: string;
  worktreePath: string;
  skills: string[];
}): SkillProvisionResult {
  const result: SkillProvisionResult = {
    provisioned: [],
    missing: [],
    disabled: [],
    invalid: [],
  };

  const seen = new Set<string>();
  for (const raw of opts.skills) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    if (!SAFE_SKILL_NAME.test(name) || name.includes("..")) {
      result.invalid.push(name);
      continue;
    }

    const srcPath = join(opts.projectRoot, ".maestro", "skills", name, "SKILL.md");
    if (!existsSync(srcPath)) {
      result.missing.push(name);
      continue;
    }

    let content: string;
    try {
      content = readFileSync(srcPath, "utf-8");
    } catch {
      result.missing.push(name);
      continue;
    }

    if (isSkillDisabled(content)) {
      result.disabled.push(name);
      continue;
    }

    const destDir = join(opts.worktreePath, ".claude", "skills", name);
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "SKILL.md"), content, "utf-8");
    result.provisioned.push(name);
  }

  return result;
}
