#!/usr/bin/env node
/**
 * Smoke test for tracker-jira plugin against a real Jira instance.
 * Reads credentials from ../.env.
 *
 * Usage:  node scripts/smoke-tracker-jira.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// ---- load .env -----------------------------------------------------------
const envPath = resolve(repoRoot, ".env");
if (!existsSync(envPath)) {
  console.error("No .env file at repo root");
  process.exit(1);
}
for (const line of readFileSync(envPath, "utf-8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) continue;
  const k = trimmed.slice(0, eq).trim();
  let v = trimmed.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (!process.env[k]) process.env[k] = v;
}

const baseUrl = process.env.JIRA_BASE_URL;
const projectKey = process.env.JIRA_PROJECT_KEY ?? "TT";
console.log(`Jira: ${baseUrl}  project=${projectKey}  email=${process.env.JIRA_EMAIL}`);

// ---- import built plugin -------------------------------------------------
const pluginPath = resolve(
  repoRoot,
  "packages/plugins/tracker-jira/dist/index.js",
);
const plugin = (await import(pluginPath)).default;

console.log("\n== manifest ==");
console.log(plugin.manifest);

console.log("\n== detect() ==");
console.log(plugin.detect?.());

const tracker = plugin.create();
console.log(`\n== tracker name: ${tracker.name} ==`);

// Minimal ProjectConfig
const project = {
  id: "smoke-test",
  repo: "owner/repo",
  tracker: {
    plugin: "jira",
    baseUrl,
    projectKey,
  },
};

// ---- listIssues ----------------------------------------------------------
console.log("\n== listIssues({ limit: 3 }) ==");
const issues = await tracker.listIssues({ limit: 3 }, project);
console.log(`Got ${issues.length} issues`);
for (const i of issues) {
  console.log(`  ${i.id}  [${i.state}]  ${i.title.slice(0, 60)}`);
}

if (issues.length === 0) {
  console.error("No issues returned — cannot continue smoke test");
  process.exit(1);
}

const sampleKey = issues[0].id;

// ---- getIssue ------------------------------------------------------------
console.log(`\n== getIssue(${sampleKey}) ==`);
const single = await tracker.getIssue(sampleKey, project);
if (!single) {
  console.error("getIssue returned null");
  process.exit(1);
}
console.log(`  title: ${single.title}`);
console.log(`  state: ${single.state}`);
console.log(`  priority: ${single.priority ?? "(none)"}`);
console.log(`  assignee: ${single.assignee ?? "(unassigned)"}`);
console.log(`  labels: ${JSON.stringify(single.labels ?? [])}`);
console.log(`  url: ${single.url}`);
if (single.description) {
  console.log(`  description (first 200 chars):\n    ${single.description.slice(0, 200).replace(/\n/g, "\n    ")}`);
}

// ---- getIssue for non-existent — other trackers throw, so we do too ------
console.log("\n== getIssue(ZZZ-999999) — expected to throw ==");
try {
  await tracker.getIssue("ZZZ-999999", project);
  console.error("  UNEXPECTED: did not throw");
  process.exit(1);
} catch (err) {
  console.log(`  threw ✓  (${err.message.slice(0, 80)})`);
}

// ---- listIssues with filters -------------------------------------------
console.log("\n== listIssues({ state: 'closed', limit: 2 }) ==");
const closed = await tracker.listIssues({ state: "closed", limit: 2 }, project);
console.log(`  got ${closed.length} closed issues`);
for (const i of closed) {
  console.log(`  ${i.id}  [${i.state}]  ${i.title.slice(0, 50)}`);
}

// ---- isCompleted --------------------------------------------------------
console.log(`\n== isCompleted(${sampleKey}) ==`);
const done = await tracker.isCompleted(sampleKey, project);
console.log(`  ${done}`);

// ---- issueUrl ------------------------------------------------------------
console.log("\n== issueUrl(key) ==");
const url = tracker.issueUrl(sampleKey, project);
console.log(`  ${sampleKey} -> ${url}`);

// ---- issueLabel ----------------------------------------------------------
if (tracker.issueLabel) {
  console.log("\n== issueLabel(url) ==");
  const label = tracker.issueLabel(url, project);
  console.log(`  ${url} -> ${label}`);
}

// ---- branchName ----------------------------------------------------------
console.log("\n== branchName(issue) ==");
const branch = tracker.branchName(sampleKey, project);
console.log(`  ${branch}`);

// ---- lazy credential check (regression test for PR fix) ------------------
console.log("\n== regression: lazy credentials ==");
{
  // Wipe creds, create a fresh tracker, then restore creds and call it
  const savedEmail = process.env.JIRA_EMAIL;
  const savedToken = process.env.JIRA_API_TOKEN;
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_API_TOKEN;
  const lazyTracker = plugin.create();
  console.log("  created tracker without creds set ✓");
  process.env.JIRA_EMAIL = savedEmail;
  process.env.JIRA_API_TOKEN = savedToken;
  const issue = await lazyTracker.getIssue(sampleKey, project);
  console.log(`  fetched ${sampleKey} after restoring creds: ${issue ? "✓" : "FAIL"}`);
}

console.log("\n✅ All smoke tests passed");
