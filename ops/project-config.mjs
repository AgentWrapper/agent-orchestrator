#!/usr/bin/env node
// Config-as-code CLI (#250). The committed specs under ops/project-config/ are
// the source of truth for each project's clean-boot config; this wraps the
// EXISTING `ao` CLI to apply and drift-check them. No daemon change — per the
// vanilla rule, the whole loop lives in the ops layer:
//
//   apply   <project>   restore a project's config from its committed spec
//                       (`ao project set-config --config-json`) — THE recovery
//                       path after any wipe/incident.
//   check   [<project>] diff live config (`ao project get --json`) against the
//   check   --all       spec and exit non-zero on drift — the scheduled-compare
//                       ingredient that turns a wiped field into a red check.
//   capture <project>   overwrite a project's spec file from its live config
//                       (used to backfill / refresh the committed baseline).
//   list                list projects that have a committed spec.
//
// Overridable for tests: AO_BIN (default "ao"), AO_PROJECT_CONFIG_DIR
// (default ops/project-config/ next to this file).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
	assertNoSecretEnv,
	assertValidProjectId,
	diffConfig,
	extractLiveConfig,
	formatDiff,
	hasDrift,
	serializeSpec,
	validateSpec,
} from "./project-config-core.mjs";

const AO_BIN = process.env.AO_BIN || "ao";
const SPEC_DIR = process.env.AO_PROJECT_CONFIG_DIR || join(dirname(fileURLToPath(import.meta.url)), "project-config");
const ALLOW_ENV_KEYS = (process.env.AO_PROJECT_CONFIG_ALLOW_ENV_KEYS || "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

// Signals "print usage and exit with this code" without a hard process.exit(),
// so buffered stdout still drains (a killed process can truncate drift output).
class UsageError extends Error {
	constructor(code = 1) {
		super("usage");
		this.code = code;
	}
}

const USAGE = `Usage:
  node ops/project-config.mjs apply <project> [--dry-run]
  node ops/project-config.mjs check [<project> | --all]
  node ops/project-config.mjs capture <project>
  node ops/project-config.mjs list

Specs live in ${SPEC_DIR} (one <project>.json per project).
`;

function specPath(project) {
	return join(SPEC_DIR, `${assertValidProjectId(project)}.json`);
}

function knownProjects() {
	if (!existsSync(SPEC_DIR)) return [];
	return readdirSync(SPEC_DIR)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.slice(0, -".json".length))
		.sort();
}

function readSpec(project) {
	const path = specPath(project);
	if (!existsSync(path)) {
		throw new Error(`no committed spec for "${project}" at ${path}`);
	}
	return validateSpec(JSON.parse(readFileSync(path, "utf8")));
}

function getLiveConfig(project) {
	assertValidProjectId(project);
	const stdout = execFileSync(AO_BIN, ["project", "get", project, "--json"], { encoding: "utf8" });
	return extractLiveConfig(JSON.parse(stdout));
}

function cmdApply(project, { dryRun }) {
	if (!project) throw new UsageError(1);
	const spec = readSpec(project);
	const json = JSON.stringify(spec);
	if (dryRun) {
		process.stdout.write(`[dry-run] would apply spec for ${project} (${json.length} bytes)\n`);
		return 0;
	}
	execFileSync(AO_BIN, ["project", "set-config", project, "--config-json", json], {
		stdio: ["ignore", "ignore", "inherit"],
	});
	process.stdout.write(`✓ applied committed spec for ${project}\n`);
	return 0;
}

function checkOne(project) {
	const spec = readSpec(project);
	const live = getLiveConfig(project);
	const diffs = diffConfig(spec, live);
	process.stdout.write(`${formatDiff(project, diffs)}\n`);
	return hasDrift(diffs);
}

function cmdCheck(project, { all }) {
	const projects = all ? knownProjects() : project ? [project] : null;
	if (!projects || projects.length === 0) throw new UsageError(1);
	let drifted = false;
	for (const p of projects) {
		if (checkOne(p)) drifted = true;
	}
	if (drifted) {
		process.stderr.write(
			"\nconfig drift detected — run `node ops/project-config.mjs apply <project>` to restore from spec\n",
		);
		return 1;
	}
	return 0;
}

function cmdCapture(project) {
	if (!project) throw new UsageError(1);
	const live = getLiveConfig(project);
	validateSpec(live);
	assertNoSecretEnv(live, { allowKeys: ALLOW_ENV_KEYS });
	writeFileSync(specPath(project), serializeSpec(live));
	process.stdout.write(`✓ captured live config of ${project} to ${specPath(project)}\n`);
	return 0;
}

function cmdList() {
	const projects = knownProjects();
	if (projects.length === 0) {
		process.stdout.write(`no specs in ${SPEC_DIR}\n`);
		return 0;
	}
	for (const p of projects) process.stdout.write(`${p}\n`);
	return 0;
}

function main(argv) {
	const [command, ...rest] = argv;
	if (!command || command === "-h" || command === "--help") throw new UsageError(command ? 0 : 1);

	const flags = new Set(rest.filter((a) => a.startsWith("--")));
	const positional = rest.filter((a) => !a.startsWith("--"));

	switch (command) {
		case "apply":
			return cmdApply(positional[0], { dryRun: flags.has("--dry-run") });
		case "check":
			return cmdCheck(positional[0], { all: flags.has("--all") });
		case "capture":
			return cmdCapture(positional[0]);
		case "list":
			return cmdList();
		default:
			process.stderr.write(`unknown command: ${command}\n`);
			throw new UsageError(1);
	}
}

// Set process.exitCode and return rather than calling process.exit(): a hard
// exit can truncate buffered stdout (the drift report the journal depends on).
try {
	process.exitCode = main(process.argv.slice(2));
} catch (err) {
	if (err instanceof UsageError) {
		(err.code === 0 ? process.stdout : process.stderr).write(USAGE);
		process.exitCode = err.code;
	} else {
		process.stderr.write(`error: ${err.message}\n`);
		process.exitCode = 2;
	}
}
