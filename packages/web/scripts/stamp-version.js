/**
 * Writes the current package version to .next/AO_VERSION after a Next.js build.
 * This stamp is compared at `ao start` to detect stale runtime caches from
 * a previous version and clear them automatically.
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const nextDir = resolve(__dirname, "..", ".next");

if (!existsSync(nextDir)) {
  console.warn("stamp-version: .next directory not found — skipping stamp");
  process.exit(0);
}

const pkgPath = resolve(__dirname, "..", "package.json");
if (!existsSync(pkgPath)) {
  console.warn("stamp-version: package.json not found — skipping stamp");
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
if (!pkg.version) {
  console.warn("stamp-version: no version field in package.json — skipping stamp");
  process.exit(0);
}
writeFileSync(resolve(nextDir, "AO_VERSION"), pkg.version, "utf8");
