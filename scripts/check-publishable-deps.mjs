#!/usr/bin/env node
/**
 * Pre-publish sanity check.
 *
 * Asserts that every `workspace:*` runtime dependency of a publishable
 * package (one without `"private": true`) is itself publishable. Without
 * this, pnpm would rewrite the workspace dep on publish to a literal
 * version pointing at a package that doesn't exist on npm, and consumers
 * doing `npm install -g @aoagents/ao` would fail.
 *
 * Concretely: this catches the case where `@aoagents/ao-cli` has
 * `"@aoagents/ao-web": "workspace:*"` while `@aoagents/ao-web` is
 * `"private": true` — the dashboard would never reach consumers.
 *
 * Run from CI before `changeset publish`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

/** Find every package.json under packages/, regardless of nesting depth. */
function collectPackages(root) {
  const found = [];
  function walk(dir) {
    if (dir.includes("node_modules")) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.name === "package.json") {
        const parsed = JSON.parse(readFileSync(full, "utf-8"));
        if (typeof parsed.name === "string") {
          found.push({ path: full, pkg: parsed });
        }
      }
    }
  }
  walk(join(root, "packages"));
  return found;
}

const packages = collectPackages(repoRoot);
const byName = new Map(packages.map((p) => [p.pkg.name, p]));

const problems = [];
for (const { pkg, path } of packages) {
  if (pkg.private === true) continue;
  const deps = { ...pkg.dependencies, ...pkg.peerDependencies };
  for (const [depName, depSpec] of Object.entries(deps)) {
    if (typeof depSpec !== "string" || !depSpec.startsWith("workspace:")) continue;
    const target = byName.get(depName);
    if (!target) continue;
    if (target.pkg.private === true) {
      problems.push(
        `  ${pkg.name} (${path}) depends on ${depName} via workspace:*, ` +
          `but ${depName} is private — install would fail on publish.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error("✗ Publishable-dependency check failed:\n");
  for (const p of problems) console.error(p);
  console.error(
    "\nFix by making the dependency publishable (drop `private: true` and add" +
      " it to the changeset linked group) OR by removing the runtime dependency.",
  );
  process.exit(1);
}

console.log(`✓ Publishable-dependency check passed (${packages.length} packages scanned).`);
