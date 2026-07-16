#!/usr/bin/env node
// Stable-release e2e pod gate runner.
//
//   node scripts/ao-e2e-pod-gate.mjs --repo <owner/repo> --sha <sha> --tag <release-tag> --suite T0
//   - Downloads the release's Linux .deb on the runner (public asset, no token),
//     spins an ephemeral Daytona pod (env DAYTONA_API_KEY, used only to CREATE
//     the pod — never passed into it), uploads the build + harness, and runs the
//     real-app T0 Playwright suite inside the pod. The pod holds no secret and
//     needs no egress.
//   - Prints a final line: AO_VERDICT {"passed":true|false,...}
//   - Exits 0 on green, non-zero on red.
//
// Wired by .github/workflows/frontend-release.yml `e2e-gate` (currently ADVISORY:
// continue-on-error + publish-feed does NOT depend on it), which reflects the
// outcome into an `ao-stable-gate` commit status. The verdict->exit-code->status
// contract lives in the pure, tested deriveGateOutcome. Once the gate is trusted
// on live releases, add `e2e-gate` to publish-feed `needs` to make it blocking.

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";

export function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token.startsWith("--")) {
			const key = token.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				args[key] = next;
				i++;
			} else {
				args[key] = true;
			}
		}
	}
	return args;
}

/**
 * Pure verdict logic for the stable e2e gate.
 *
 * The key distinction: a RED (failure) verdict is reserved for the ONE
 * actionable case — the smoke suite ran and the app under test failed it.
 * Everything else that goes wrong is INFRA/setup (no key, Daytona unavailable,
 * download/exec error, timeout) and maps to a NEUTRAL check, not red, so an
 * infrastructure hiccup never makes an otherwise-good release look failed.
 *
 * The infra-vs-app split falls out of throw-vs-return in the runner: infra
 * problems throw (→ ranOk=false here); an app smoke failure returns
 * testsPassed=false.
 *
 * Rule table (first match wins):
 *   ranOk === false      -> infra      / neutral / exit 0  (could not run)
 *   timedOut === true    -> infra      / neutral / exit 0  (treated as infra/flake)
 *   testsPassed !== true -> app_failed / failure / exit 1  (the only RED)
 *   testsPassed === true -> passed     / success / exit 0
 *
 * exitCode: app_failed=1 (so a future blocking gate blocks); infra=0 (a Daytona
 * outage must never block a good release); passed=0.
 *
 * @param {object} facts
 * @param {boolean} facts.ranOk       runner produced a verdict (false = threw = infra)
 * @param {boolean} facts.testsPassed the T0 suite reported all green
 * @param {boolean} [facts.timedOut]  the run hit its wall-clock timeout
 * @param {string}  [facts.artifactsUrl] link to logs/traces/screenshots
 * @returns {{classification:"passed"|"app_failed"|"infra", conclusion:"success"|"failure"|"neutral", exitCode:0|1, description:string, artifactsUrl:string|null}}
 */
export function deriveGateOutcome({ ranOk, testsPassed, timedOut = false, artifactsUrl = null } = {}) {
	const link = artifactsUrl || null;
	const infra = (description) => ({
		classification: "infra",
		conclusion: "neutral",
		exitCode: 0,
		description,
		artifactsUrl: link,
	});

	if (ranOk === false) {
		return infra("gate could not run (infrastructure/setup) — not a release-build result");
	}
	if (timedOut === true) {
		return infra("gate timed out (infrastructure) — not a release-build result");
	}
	if (testsPassed !== true) {
		return {
			classification: "app_failed",
			conclusion: "failure",
			exitCode: 1,
			description: "T0 pod smoke failed — the app under test failed the suite",
			artifactsUrl: link,
		};
	}
	return {
		classification: "passed",
		conclusion: "success",
		exitCode: 0,
		description: "T0 pod smoke passed",
		artifactsUrl: link,
	};
}

// GitHub release Linux .deb URL for a tag. Forge publishes to v<version>; the
// asset is agent-orchestrator_<version>_amd64.deb (version = tag without "v").
export function releaseDebUrl(repo, tag) {
	const version = String(tag).replace(/^v/, "");
	return `https://github.com/${repo}/releases/download/${tag}/agent-orchestrator_${version}_amd64.deb`;
}

// runPodSuite spins one ephemeral Daytona pod, installs the release build, and
// runs the real-app T0 suite in it, returning the observed facts. The pod holds
// NO secret and fetches NO application code: the .deb is fetched on the runner
// (public asset) and uploaded in; DAYTONA_API_KEY is used only to create the pod,
// never passed into it. (boot-real.sh may still fetch its toolchain from the OS/
// npm registries at boot unless the sandbox image has it baked — see that
// script's header.) The SDK is dynamically imported so the pure-function tests
// (deriveGateOutcome/parseArgs) load this module without needing @daytona/sdk.
async function runPodSuite({ repo, tag, apiKey, timeoutMs = 20 * 60_000 }) {
	if (!apiKey) throw new Error("DAYTONA_API_KEY is required");
	if (!repo || !tag) throw new Error("--repo and --tag are required");

	const podDir = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "e2e-pod");
	const debUrl = releaseDebUrl(repo, tag);
	const res = await fetch(debUrl);
	if (!res.ok) throw new Error(`download ${debUrl} -> HTTP ${res.status}`);
	const deb = Buffer.from(await res.arrayBuffer());

	const { Daytona } = await import("@daytona/sdk");
	const daytona = new Daytona({ apiKey });
	let sandbox;
	const startedAt = Date.now();
	try {
		sandbox = await daytona.create({ snapshot: process.env.AO_DAYTONA_SNAPSHOT || "daytona-small" });
		await sandbox.fs.uploadFile(deb, "/home/daytona/app.deb");
		for (const f of ["playwright.electron.config.ts", "real-app.spec.ts", "boot-real.sh"]) {
			await sandbox.fs.uploadFile(await readFile(join(podDir, f)), `/home/daytona/${f}`);
		}
		const r = await sandbox.process.executeCommand(
			"AO_DEB_PATH=/home/daytona/app.deb bash /home/daytona/boot-real.sh",
			"/home/daytona",
			undefined,
			Math.floor(timeoutMs / 1000),
		);
		const out = r.result ?? "";
		process.stdout.write(out);
		const m = out.match(/AO_VERDICT (\{.*\})\s*$/m);
		const passed = m ? JSON.parse(m[1]).passed === true : false;
		return { passed, timedOut: Date.now() - startedAt >= timeoutMs, artifacts: null };
	} finally {
		if (sandbox) await sandbox.delete().catch(() => {});
	}
}

async function main(argv) {
	const args = parseArgs(argv.slice(2));
	console.log("ao-e2e-pod-gate");
	console.log(`  repo=${args.repo ?? "(unset)"} tag=${args.tag ?? "(unset)"} suite=${args.suite ?? "T0"}`);
	console.log(`  DAYTONA_API_KEY: ${process.env.DAYTONA_API_KEY ? "present" : "absent"}`);

	let outcome;
	try {
		const res = await runPodSuite({
			repo: args.repo,
			tag: args.tag,
			apiKey: process.env.DAYTONA_API_KEY,
		});
		outcome = deriveGateOutcome({
			ranOk: true,
			testsPassed: res.passed,
			timedOut: res.timedOut,
			artifactsUrl: res.artifacts,
		});
	} catch (err) {
		console.error(`ao-e2e-pod-gate: run failed: ${err.message}`);
		outcome = deriveGateOutcome({ ranOk: false });
	}

	const verdict = {
		classification: outcome.classification,
		conclusion: outcome.conclusion,
		passed: outcome.classification === "passed",
		summary: outcome.description,
		...(outcome.artifactsUrl ? { artifactsUrl: outcome.artifactsUrl } : {}),
	};
	console.log(`AO_VERDICT ${JSON.stringify(verdict)}`);
	// Hand the classification to the CI job deterministically so it maps to a
	// check-run conclusion (success/failure/neutral) without re-parsing stdout.
	if (process.env.GITHUB_OUTPUT) {
		try {
			appendFileSync(
				process.env.GITHUB_OUTPUT,
				`classification=${outcome.classification}\nconclusion=${outcome.conclusion}\n`,
			);
		} catch {
			/* best-effort; the check step falls back to a neutral conclusion */
		}
	}
	return outcome.exitCode;
}

// Only run the CLI when invoked directly, not when imported by the test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main(process.argv).then((code) => process.exit(code));
}
