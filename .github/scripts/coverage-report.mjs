/**
 * Parses Vitest JSON coverage reports, filters to PR-changed files,
 * and writes a Markdown summary to coverage-comment.md.
 *
 * Expects:
 *   - changed-files.txt in cwd (one relative path per line)
 *   - coverage-final.json in each package's coverage/ directory
 *
 */

/* eslint-disable no-undef -- Node.js CI script; process/console are globals */
import { readFileSync, writeFileSync, existsSync, realpathSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import libCoverage from "istanbul-lib-coverage";

const COMMENT_TAG = "<!-- coverage-report -->";
const cwd = realpathSync(process.cwd());

// ── 1. Read changed files ──────────────────────────────────────────
const changedFiles = readFileSync("changed-files.txt", "utf-8")
  .split("\n")
  .map((f) => f.trim())
  .filter((f) => f && (f.endsWith(".ts") || f.endsWith(".tsx")))
  .filter((f) => !f.includes("__tests__") && !f.includes(".test."));

if (changedFiles.length === 0) {
  const comment = `${COMMENT_TAG}\n## Test Coverage Report\n\n_No TypeScript source files changed in this PR._\n`;
  writeFileSync("coverage-comment.md", comment);
  process.exit(0);
}

// ── 2. Discover and merge coverage-final.json files ────────────────
function findCoverageFiles(baseDir) {
  const results = [];
  const packagesDir = resolve(baseDir, "packages");

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "coverage") {
          const jsonFile = resolve(full, "coverage-final.json");
          if (existsSync(jsonFile)) results.push(jsonFile);
        } else {
          walk(full);
        }
      }
    }
  }

  walk(packagesDir);
  return results;
}

const coverageMap = libCoverage.createCoverageMap({});

for (const jsonPath of findCoverageFiles(cwd)) {
  const raw = JSON.parse(readFileSync(jsonPath, "utf-8"));
  coverageMap.merge(raw);
}

// ── 3. Filter to changed files and collect metrics ─────────────────
let totalLines = 0;
let coveredLines = 0;
const fileReports = [];

for (const absPath of coverageMap.files()) {
  // Normalize to handle symlinks (e.g. /tmp -> /private/tmp on macOS)
  const realAbsPath = existsSync(absPath) ? realpathSync(absPath) : absPath;
  const relPath = relative(cwd, realAbsPath);

  if (!changedFiles.includes(relPath)) continue;

  const fc = coverageMap.fileCoverageFor(absPath);
  const summary = fc.toSummary();
  const lineCoverage = fc.getLineCoverage();

  const fileTotalLines = summary.lines.total;
  const fileCoveredLines = summary.lines.covered;
  const uncoveredLineNums = Object.entries(lineCoverage)
    .filter(([, hits]) => hits === 0)
    .map(([line]) => Number(line))
    .sort((a, b) => a - b);

  totalLines += fileTotalLines;
  coveredLines += fileCoveredLines;

  if (fileTotalLines > 0) {
    fileReports.push({
      path: relPath,
      total: fileTotalLines,
      covered: fileCoveredLines,
      pct: summary.lines.pct.toFixed(1),
      uncoveredLines: uncoveredLineNums,
    });
  }
}

// ── 4. Build Markdown comment ──────────────────────────────────────

/** Collapse consecutive line numbers into ranges: [1,2,3,7,9,10] -> "L1-L3, L7, L9-L10" */
function consolidateRanges(lines) {
  if (lines.length === 0) return "";
  const ranges = [];
  let start = lines[0];
  let end = lines[0];

  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === end + 1) {
      end = lines[i];
    } else {
      ranges.push(start === end ? `L${start}` : `L${start}-L${end}`);
      start = lines[i];
      end = lines[i];
    }
  }
  ranges.push(start === end ? `L${start}` : `L${start}-L${end}`);
  return ranges.join(", ");
}

let comment = `${COMMENT_TAG}\n## Test Coverage Report\n\n`;

if (fileReports.length === 0) {
  comment +=
    "_Changed files have no coverage data (not instrumented or no tests ran)._\n";
} else {
  const pct =
    totalLines > 0 ? ((coveredLines / totalLines) * 100).toFixed(1) : "0.0";
  const uncoveredTotal = totalLines - coveredLines;

  comment += "| Metric | Value |\n";
  comment += "|--------|-------|\n";
  comment += `| Lines covered | ${coveredLines}/${totalLines} |\n`;
  comment += `| Lines not covered | ${uncoveredTotal}/${totalLines} |\n`;
  comment += `| Overall coverage | ${pct}% |\n\n`;

  // Per-file breakdown
  if (fileReports.length > 1) {
    comment += "<details>\n<summary>Per-file breakdown</summary>\n\n";
    comment += "| File | Coverage |\n";
    comment += "|------|----------|\n";
    for (const f of fileReports.sort((a, b) => a.path.localeCompare(b.path))) {
      comment += `| \`${f.path}\` | ${f.covered}/${f.total} (${f.pct}%) |\n`;
    }
    comment += "\n</details>\n\n";
  }

  // Uncovered lines section
  const filesWithUncovered = fileReports.filter(
    (f) => f.uncoveredLines.length > 0,
  );
  if (filesWithUncovered.length > 0) {
    comment += "### Uncovered lines\n\n";
    for (const file of filesWithUncovered.sort((a, b) =>
      a.path.localeCompare(b.path),
    )) {
      const ranges = consolidateRanges(file.uncoveredLines);
      comment += `- \`${file.path}\`: ${ranges}\n`;
    }
    comment += "\n";
  }

}

writeFileSync("coverage-comment.md", comment);
