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

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

/** Parsed view of a SKILL.md frontmatter block, with fail-open defaults. */
export interface SkillFrontmatter {
  /** Frontmatter `name`, or undefined when absent/blank. */
  name?: string;
  /** Frontmatter `description`, or undefined when absent/blank. */
  description?: string;
  /**
   * `false` ONLY when the frontmatter explicitly sets `enabled: false`. The
   * absence of the key — or any unparseable frontmatter — is treated as
   * enabled (fail-open: don't drop a skill over a parse hiccup or the Phase-1
   * `name` + `description`-only convention).
   */
  enabled: boolean;
}

/**
 * Extract the leading YAML frontmatter block (`---\n…\n---`) from a SKILL.md.
 * Returns null when the file has no frontmatter.
 */
function extractFrontmatter(content: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  return match ? match[1] : null;
}

/**
 * Parse a SKILL.md's frontmatter into `{ name, description, enabled }`. The
 * single source of truth for reading skill metadata — both provisioning (which
 * only needs `enabled`) and the `ao skills list` catalog reuse it. See
 * {@link SkillFrontmatter} for the fail-open `enabled` contract.
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return { enabled: true };
  try {
    const parsed = parseYaml(frontmatter) as Record<string, unknown> | null;
    const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
    const description =
      typeof parsed?.description === "string" ? parsed.description.trim() : "";
    return {
      name: name || undefined,
      description: description || undefined,
      enabled: parsed?.enabled !== false,
    };
  } catch {
    return { enabled: true };
  }
}

/**
 * A skill is disabled only when its frontmatter explicitly sets
 * `enabled: false`. See {@link parseSkillFrontmatter}.
 */
function isSkillDisabled(content: string): boolean {
  return !parseSkillFrontmatter(content).enabled;
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

/** One skill in the project's library, as surfaced by `ao skills list`. */
export interface SkillCatalogEntry {
  /** Folder name (the value `--skills` expects); falls back to frontmatter `name`. */
  name: string;
  /** Frontmatter `description`, or "" when absent. */
  description: string;
  /** `false` only when the frontmatter sets `enabled: false` (see {@link parseSkillFrontmatter}). */
  enabled: boolean;
}

/**
 * Enumerate the project's skill-pool library
 * (`<projectRoot>/.maestro/skills/<name>/SKILL.md`) into a sorted catalog of
 * `{ name, description, enabled }`. The orchestrator consults this (via
 * `ao skills list`) to pick a relevant subset to provision per task.
 *
 * The directory name is the canonical `name` (it is what `--skills` matches and
 * what {@link provisionSkills} copies); the frontmatter `name` is only a
 * fallback for display when present. FAIL-OPEN like provisioning: a missing
 * library, an unreadable entry, or a folder without `SKILL.md` is skipped, not
 * thrown.
 */
export function listProjectSkills(projectRoot: string): SkillCatalogEntry[] {
  const libDir = join(projectRoot, ".maestro", "skills");
  if (!existsSync(libDir)) return [];

  let dirents;
  try {
    dirents = readdirSync(libDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: SkillCatalogEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const dirName = dirent.name;
    const skillPath = join(libDir, dirName, "SKILL.md");
    if (!existsSync(skillPath)) continue;

    let content: string;
    try {
      content = readFileSync(skillPath, "utf-8");
    } catch {
      continue;
    }

    const fm = parseSkillFrontmatter(content);
    skills.push({
      name: dirName || fm.name || "",
      description: fm.description ?? "",
      enabled: fm.enabled,
    });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}
