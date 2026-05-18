#!/usr/bin/env node
/**
 * Smoke test: load TravelTales3's agent-orchestrator.yaml through the full
 * AO config loader (which auto-loads the sibling .env), then exercise the
 * jira tracker plugin against real Jira using the project's own config.
 */
import { loadConfig } from "../packages/core/dist/index.js";
import plugin from "../packages/plugins/tracker-jira/dist/index.js";

const configPath = "/Users/simongrinberg/dev/TravelTales3/agent-orchestrator.yaml";
console.log(`Loading: ${configPath}`);

const config = loadConfig(configPath);

console.log(`\nJIRA_BASE_URL = ${process.env.JIRA_BASE_URL ? "(set)" : "(missing)"}`);
console.log(`JIRA_EMAIL    = ${process.env.JIRA_EMAIL ? "(set)" : "(missing)"}`);
console.log(`JIRA_API_TOKEN= ${process.env.JIRA_API_TOKEN ? "(set)" : "(missing)"}`);

const projectEntry = Object.entries(config.projects)[0];
const [projectId, project] = projectEntry;
console.log(`\nProject: ${projectId}`);
console.log(`  repo: ${project.repo}`);
console.log(`  tracker.plugin: ${project.tracker?.plugin}`);
console.log(`  tracker.baseUrl: ${project.tracker?.baseUrl}`);
console.log(`  tracker.projectKey: ${project.tracker?.projectKey}`);
console.log(`  tracker.branchPrefix: ${project.tracker?.branchPrefix}`);
console.log(`  tracker.jql: ${project.tracker?.jql}`);

console.log(`\n== detect() ==  ${plugin.detect?.()}`);

const tracker = plugin.create();

// Match ProjectConfig shape expected by the tracker (needs `id`)
const projectConfig = { id: projectId, ...project };

console.log("\n== listIssues({ limit: 3 }) — using project's custom JQL ==");
const issues = await tracker.listIssues({ limit: 3 }, projectConfig);
console.log(`  got ${issues.length} issues`);
for (const i of issues) {
  console.log(`  ${i.id}  [${i.state}]  ${i.title.slice(0, 55)}`);
}

if (issues.length === 0) {
  console.log("  (no To Do issues matching JQL — that's OK)");
  // Still try a fetch with a known issue
  console.log("\n== getIssue(TT-1640) ==");
  const issue = await tracker.getIssue("TT-1640", projectConfig);
  console.log(`  ${issue.id}  [${issue.state}]  ${issue.title.slice(0, 55)}`);
  console.log(`  branchName: ${tracker.branchName(issue.id, projectConfig)}`);
} else {
  const key = issues[0].id;
  console.log(`\n== getIssue(${key}) ==`);
  const issue = await tracker.getIssue(key, projectConfig);
  console.log(`  title: ${issue.title}`);
  console.log(`  state: ${issue.state}`);
  console.log(`  assignee: ${issue.assignee ?? "(unassigned)"}`);
  console.log(`  branchName: ${tracker.branchName(key, projectConfig)}`);
  console.log(`  issueUrl: ${tracker.issueUrl(key, projectConfig)}`);
}

console.log("\n✅ TravelTales3 → jira tracker smoke test passed");
