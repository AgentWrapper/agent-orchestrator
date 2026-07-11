import assert from "node:assert/strict";
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployScript = path.join(repoRoot, "ops", "deploy.sh");

let cleanup = [];

beforeEach(() => {
	cleanup = [];
});

afterEach(async () => {
	await Promise.all(
		cleanup
			.splice(0)
			.reverse()
			.map((item) => item()),
	);
});

describe("ao self-deploy script", () => {
	it("is valid bash", async () => {
		const result = await run("bash", ["-n", deployScript], { cwd: repoRoot });

		assert.equal(result.code, 0, result.stderr);
	});

	it("backs up and rebuilds ao, restarts ao, and restarts changed frontend/ops units", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "frontend", "app.js"), "console.log('frontend changed');\n");
		await writeFile(path.join(fixture.dir, "ops", "ao-slack-notifier.mjs"), "console.log('ops changed');\n");
		await commitFixture(fixture.dir, "deploy-relevant changes");

		const result = await runDeployDryRun(fixture.dir, fixture.home, { AO_DEPLOY_BASE: base.stdout.trim() });

		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /Deploying ao from /);
		assert.match(result.stdout, /DRY-RUN: mkdir -p .*\/\.config\/systemd\/user/);
		assert.match(result.stdout, /DRY-RUN: cp .*\/ops\/ao\.service .*\/\.config\/systemd\/user\/ao\.service/);
		assert.match(result.stdout, /DRY-RUN: systemctl --user daemon-reload/);
		assert.match(result.stdout, /DRY-RUN: cp .*\/\.local\/bin\/ao .*\/\.local\/bin\/ao\.prev/);
		assert.match(result.stdout, /DRY-RUN: cd .*\/backend && go build -o .*\/\.local\/bin\/ao \.\/cmd\/ao/);
		assert.match(result.stdout, /DRY-RUN: systemctl --user restart ao\.service/);
		assert.match(result.stdout, /frontend\/ changed; restarting ao-web\.service/);
		assert.match(result.stdout, /DRY-RUN: systemctl --user restart ao-web\.service/);
		assert.match(result.stdout, /ops\/ changed; restarting ao-slack-notifier\.service/);
		assert.match(result.stdout, /DRY-RUN: systemctl --user restart ao-slack-notifier\.service/);
		assert.match(result.stdout, /installing \+ restarting attention reply unit/);
		assert.match(result.stdout, /outbound attention notifier is retired/);
		assert.match(result.stdout, /DRY-RUN: cd .* && bash ops\/install-attention\.sh/);
		assert.doesNotMatch(result.stdout, /is-active --quiet ao-attention-notifier\.service/);
		assert.match(result.stdout, /DRY-RUN: systemctl --user is-active --quiet ao-attention-reply\.service/);
		assert.match(result.stdout, /DRY-RUN: ao status/);
		assert.match(result.stdout, /DRY-RUN: ao doctor/);
		assert.match(result.stdout, /DRY-RUN: curl .*\/api\/v1\/projects/);
		assert(
			result.stdout.indexOf("DRY-RUN: systemctl --user restart ao-web.service") <
				result.stdout.indexOf("https://mirrorborn.tailc1fd9.ts.net/"),
			"tailnet web verification should run after the web unit restart when frontend/ changed",
		);
	});

	it("installs frontend dependencies before restarting web when package metadata changes", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "frontend", "package.json"), '{"dependencies":{"qrcode.react":"^4.2.0"}}\n');
		await writeFile(path.join(fixture.dir, "frontend", "package-lock.json"), '{"lockfileVersion":3}\n');
		await git(fixture.dir, ["add", "frontend/package.json", "frontend/package-lock.json"]);
		await git(fixture.dir, ["commit", "-m", "frontend package metadata change"]);

		const result = await runDeployDryRun(fixture.dir, fixture.home, { AO_DEPLOY_BASE: base.stdout.trim() });

		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /frontend package metadata changed; installing dependencies with npm ci/);
		assert.match(result.stdout, /DRY-RUN: cd .*\/frontend && npm ci/);
		assertFrontendDependencyInstallBeforeWebRestart(result.stdout);
	});

	it("rejects output that restarts web before the frontend dependency install", () => {
		// This guards the test assertion itself: the backend dry-run cd line must
		// never count as evidence that frontend dependencies were installed first.
		const stdout = [
			"DRY-RUN: cd /repo/backend && go build -o /home/user/.local/bin/ao ./cmd/ao",
			"DRY-RUN: systemctl --user restart ao-web.service",
			"DRY-RUN: cd /repo/frontend && npm ci",
		].join("\n");

		assert.throws(
			() => assertFrontendDependencyInstallBeforeWebRestart(stdout),
			/npm ci must run before ao-web\.service restart/,
		);
	});

	it("aborts before restarting web when frontend dependency install fails", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "frontend", "package.json"), '{"dependencies":{"qrcode.react":"^4.2.0"}}\n');
		await writeFile(path.join(fixture.dir, "frontend", "package-lock.json"), '{"lockfileVersion":3}\n');
		await git(fixture.dir, ["add", "frontend/package.json", "frontend/package-lock.json"]);
		await git(fixture.dir, ["commit", "-m", "frontend package metadata change"]);

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_BASE: base.stdout.trim(),
			NPM_STUB_FAIL: "1",
		});

		assert.notEqual(result.code, 0, "a failed npm ci must fail the deploy");
		assert.match(
			result.stderr,
			/Frontend dependency install failed; aborting deploy before restarting ao-web\.service/,
		);

		const systemctlLog = await readFile(fixture.systemctlLog, "utf8");
		assert.doesNotMatch(systemctlLog, /^--user restart ao-web\.service$/m);
		await assert.rejects(access(fixture.stateFile), "a failed dependency install must not record the deployed ref");
	});

	it("does not restart web or notifier units when their directories are unchanged", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "README.md"), "readme changed\n");
		await commitFixture(fixture.dir, "docs only");

		const result = await runDeployDryRun(fixture.dir, fixture.home, { AO_DEPLOY_BASE: base.stdout.trim() });

		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /frontend\/ unchanged; leaving ao-web\.service running/);
		assert.match(result.stdout, /ops\/ unchanged; leaving ao-slack-notifier\.service running/);
		assert.match(
			result.stdout,
			/leaving ao-attention-reply\.service running; outbound attention notifier remains retired/,
		);
		assert.doesNotMatch(result.stdout, /restart ao-web\.service/);
		assert.doesNotMatch(result.stdout, /restart ao-slack-notifier\.service/);
	});

	it("rolls back by restoring ao.prev and restarting ao without rebuilding", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		const result = await runDeployDryRun(fixture.dir, fixture.home, {}, ["--rollback"]);

		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /Rolling back ao binary/);
		assert.match(result.stdout, /DRY-RUN: cp .*\/\.local\/bin\/ao\.prev .*\/\.local\/bin\/ao/);
		assert.match(result.stdout, /DRY-RUN: cp .*\/ops\/ao\.service .*\/\.config\/systemd\/user\/ao\.service/);
		assert.match(result.stdout, /DRY-RUN: systemctl --user daemon-reload/);
		assert.match(result.stdout, /DRY-RUN: systemctl --user restart ao\.service/);
		assert.doesNotMatch(result.stdout, /go build/);
	});

	it("ships an ao.service unit that does not signal agent tmux sessions on restart", async () => {
		const unit = await readFile(path.join(repoRoot, "ops", "ao.service"), "utf8");

		assert.match(unit, /^ExecStart=%h\/\.local\/bin\/ao daemon$/m);
		assert.match(unit, /^Restart=always$/m);
		assert.match(unit, /^StartLimitIntervalSec=60s$/m);
		assert.match(unit, /^StartLimitBurst=5$/m);
		assert.match(unit, /^Delegate=yes$/m);
		assert.match(unit, /^KillMode=process$/m);
		assert.match(unit, /^TimeoutStopSec=60s$/m);
	});

	it("waits out the transient web 502 after ao-web.service restarts instead of failing the deploy", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "frontend", "app.js"), "console.log('frontend changed');\n");
		await writeFile(path.join(fixture.dir, "ops", "ao-slack-notifier.mjs"), "console.log('ops changed');\n");
		await commitFixture(fixture.dir, "deploy-relevant changes");

		// ao-web.service's ExecStartPre rebuilds the bundle and the node server
		// takes a moment to bind, so the tailnet URL serves 502 briefly.
		const web = await startFakeWeb({ webFailuresBeforeReady: 2 });
		const result = await runDeployLive(fixture, web, { AO_DEPLOY_BASE: base.stdout.trim() });

		assert.equal(result.code, 0, `deploy should survive a transient 502\n${result.stdout}\n${result.stderr}`);
		assert(web.webHits() > 1, `web URL should be probed more than once, got ${web.webHits()}`);
		assert.match(result.stdout, /returned HTTP 200/);

		const systemctlLog = await readFile(fixture.systemctlLog, "utf8");
		assert.match(
			systemctlLog,
			/^--user restart ao-slack-notifier\.service$/m,
			"a transient web 502 must not abort the deploy before the ops/ notifier restart",
		);
		await assert.doesNotReject(access(fixture.stateFile), "a successful deploy records the deployed ref");
	});

	it("restarts the notifier before web verification, so a genuinely down web still fails the deploy", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "ops", "ao-slack-notifier.mjs"), "console.log('ops changed');\n");
		await commitFixture(fixture.dir, "ops-only change");

		// Never becomes ready: curl gets connection-refused on the web URL.
		const web = await startFakeWeb({ webFailuresBeforeReady: Number.POSITIVE_INFINITY, closeWebPort: true });
		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_BASE: base.stdout.trim(),
			AO_DEPLOY_WAIT_SECONDS: "2",
		});

		assert.notEqual(result.code, 0, "a web URL that never serves 200 must fail the deploy");
		assert.match(result.stderr, /expected 200/);

		const systemctlLog = await readFile(fixture.systemctlLog, "utf8");
		assert.match(
			systemctlLog,
			/^--user restart ao-slack-notifier\.service$/m,
			"the notifier restart must not be gated behind the web check",
		);
		await assert.rejects(access(fixture.stateFile), "a failed deploy must not record the deployed ref");
	});

	it("gives up on the web probe once the readiness budget is spent", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "frontend", "app.js"), "console.log('frontend changed');\n");
		await commitFixture(fixture.dir, "frontend change");

		// Serves 502 forever: the loop must bound itself, not spin.
		const web = await startFakeWeb({ webFailuresBeforeReady: Number.POSITIVE_INFINITY });
		const started = Date.now();
		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_BASE: base.stdout.trim(),
			AO_DEPLOY_WAIT_SECONDS: "3",
		});
		const elapsedSeconds = (Date.now() - started) / 1000;

		assert.notEqual(result.code, 0, "a web URL stuck on 502 must eventually fail the deploy");
		assert.match(result.stderr, /returned HTTP 502, expected 200 \(waited 3s\)/);
		assert(web.webHits() > 1, `should retry rather than probe once, got ${web.webHits()} hit(s)`);
		assert(elapsedSeconds < 30, `should honor the 3s budget, not the 30s default; took ${elapsedSeconds}s`);
	});

	it("follows redirects and accepts the final 200 rather than the interim 3xx", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "frontend", "app.js"), "console.log('frontend changed');\n");
		await commitFixture(fixture.dir, "frontend change");

		// curl is invoked with --location; %{http_code} must report the final 200,
		// not a concatenation of every status in the chain.
		const web = await startFakeWeb({ redirectFirst: true });
		const result = await runDeployLive(fixture, web, { AO_DEPLOY_BASE: base.stdout.trim() });

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /returned HTTP 200/);
	});

	it("bounds each probe so a stalled response cannot hang the deploy past the budget", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "frontend", "app.js"), "console.log('frontend changed');\n");
		await commitFixture(fixture.dir, "frontend change");

		// Connection is accepted but no response ever arrives: --connect-timeout
		// alone does not bound this, only a per-request total timeout does.
		const web = await startFakeWeb({ stall: true });
		const started = Date.now();
		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_BASE: base.stdout.trim(),
			AO_DEPLOY_WAIT_SECONDS: "3",
		});
		const elapsedSeconds = (Date.now() - started) / 1000;

		assert.notEqual(result.code, 0, "a stalled web host must fail the deploy");
		assert.match(result.stderr, /returned HTTP 000, expected 200 \(waited 3s\)/);
		assert(elapsedSeconds < 20, `must honor the 3s budget against a stall; took ${elapsedSeconds}s`);
	});

	it("fails fast on a permanent status instead of burning the whole retry budget", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "frontend", "app.js"), "console.log('frontend changed');\n");
		await commitFixture(fixture.dir, "frontend change");

		// 404 is a misconfiguration, not a restart transient. Retrying cannot clear it.
		const web = await startFakeWeb({ fixedStatus: 404 });
		const started = Date.now();
		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_BASE: base.stdout.trim(),
			AO_DEPLOY_WAIT_SECONDS: "30",
		});
		const elapsedSeconds = (Date.now() - started) / 1000;

		assert.notEqual(result.code, 0, "a permanent 404 must fail the deploy");
		assert.match(result.stderr, /returned HTTP 404, expected 200 \(not a restart transient; not retrying\)/);
		assert.equal(web.webHits(), 1, `must probe once, not retry; got ${web.webHits()} hits`);
		assert(elapsedSeconds < 20, `must not burn the 30s budget on a permanent status; took ${elapsedSeconds}s`);
	});

	it("skips web verification when no web URL is configured", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "ops", "ao-slack-notifier.mjs"), "console.log('ops changed');\n");
		await commitFixture(fixture.dir, "ops-only change");

		const web = await startFakeWeb({ webFailuresBeforeReady: Number.POSITIVE_INFINITY, closeWebPort: true });
		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_BASE: base.stdout.trim(),
			AO_DEPLOY_WEB_URL: "",
			AO_WEB_PUBLIC_URL: "",
		});

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /skipping tailnet web HTTP verification/);
		assert.equal(web.webHits(), 0, "an unconfigured web URL must not be probed at all");
		await assert.doesNotReject(access(fixture.stateFile));
	});

	it("refuses to deploy a commit whose main CI failed", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		await writeFile(
			fixture.ghStatusFile,
			JSON.stringify({
				check_runs: [
					{ name: "go", status: "completed", conclusion: "failure" },
					{ name: "cli-e2e", status: "completed", conclusion: "timed_out" },
				],
			}),
		);
		const web = await startFakeWeb();

		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_GITHUB_REPO: "polymath-ventures/agent-orchestrator",
		});

		assert.notEqual(result.code, 0, "red main CI must fail the deploy");
		assert.match(result.stderr, /Refusing to deploy .* main CI is failure: go, cli-e2e/);
		const systemctlLog = await readFile(fixture.systemctlLog, "utf8").catch(() => "");
		assert.equal(systemctlLog, "", "deploy must stop before service restarts");
		await assert.rejects(access(fixture.stateFile), "failed deploy must not record the deployed ref");
	});

	it("refuses to deploy when GitHub returns no main CI check runs yet", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		await writeFile(fixture.ghStatusFile, JSON.stringify({ check_runs: [] }));
		const web = await startFakeWeb();

		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_GITHUB_REPO: "polymath-ventures/agent-orchestrator",
		});

		assert.notEqual(result.code, 0, "empty check-runs must fail closed");
		assert.match(result.stderr, /main CI is not green \(unknown: no check runs\)/);
		const systemctlLog = await readFile(fixture.systemctlLog, "utf8").catch(() => "");
		assert.equal(systemctlLog, "", "deploy must stop before service restarts");
	});

	it("treats action_required main CI as pending instead of failed", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		await writeFile(
			fixture.ghStatusFile,
			JSON.stringify({ check_runs: [{ name: "manual gate", status: "completed", conclusion: "action_required" }] }),
		);
		const web = await startFakeWeb();

		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_GITHUB_REPO: "polymath-ventures/agent-orchestrator",
		});

		assert.notEqual(result.code, 0, "manual action should still block deploy until green");
		assert.match(result.stderr, /main CI is not green \(pending: manual gate\)/);
	});

	it("refuses to deploy when GitHub truncates main CI check runs", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		await writeFile(
			fixture.ghStatusFile,
			JSON.stringify({
				total_count: 101,
				check_runs: Array.from({ length: 100 }, (_, i) => ({
					name: `job-${i}`,
					status: "completed",
					conclusion: "success",
				})),
			}),
		);
		const web = await startFakeWeb();

		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_GITHUB_REPO: "polymath-ventures/agent-orchestrator",
		});

		assert.notEqual(result.code, 0, "truncated check-runs must fail closed");
		assert.match(result.stderr, /main CI is not green \(unknown: check runs truncated at 100\/101\)/);
	});
});

async function makeGitFixture() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "ao-deploy-repo-"));
	const home = await mkdtemp(path.join(os.tmpdir(), "ao-deploy-home-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	cleanup.push(() => rm(home, { recursive: true, force: true }));

	await mkdir(path.join(dir, "backend", "cmd", "ao"), { recursive: true });
	await mkdir(path.join(dir, "frontend"), { recursive: true });
	await mkdir(path.join(dir, "ops"), { recursive: true });
	await mkdir(path.join(home, ".local", "bin"), { recursive: true });

	await writeFile(path.join(dir, "backend", "cmd", "ao", "main.go"), "package main\nfunc main() {}\n");
	await writeFile(path.join(dir, "frontend", "app.js"), "console.log('frontend');\n");
	await writeFile(path.join(dir, "ops", "ao-slack-notifier.mjs"), "console.log('ops');\n");
	await writeFile(path.join(dir, "ops", "ao.service"), "[Service]\nExecStart=/bin/true\n");
	await writeFile(path.join(dir, "ops", "install-attention.sh"), "#!/usr/bin/env bash\nexit 0\n");
	await writeFile(path.join(dir, "README.md"), "fixture\n");
	await writeFile(path.join(home, ".local", "bin", "ao"), "current ao\n");
	await chmod(path.join(home, ".local", "bin", "ao"), 0o755);
	await writeFile(path.join(home, ".local", "bin", "ao.prev"), "previous ao\n");

	await git(dir, ["init", "-b", "main"]);
	await git(dir, ["config", "user.email", "test@example.com"]);
	await git(dir, ["config", "user.name", "Test User"]);

	const stubBin = path.join(home, "stub-bin");
	const systemctlLog = path.join(home, "systemctl.log");
	const ghStatusFile = path.join(home, "gh-status.json");
	const stateDir = path.join(home, "deploy-state");
	const stateFile = path.join(stateDir, "agent-orchestrator.last-deployed");
	await writeFile(ghStatusFile, JSON.stringify({ state: "success", failedJobs: [] }));
	await makeStubBin(stubBin);

	return { dir, home, stubBin, systemctlLog, ghStatusFile, stateDir, stateFile };
}

// Stubs for the host-mutating commands deploy.sh shells out to. `curl` is
// deliberately NOT stubbed: the web-readiness probe is the behavior under test.
async function makeStubBin(stubBin) {
	await mkdir(stubBin, { recursive: true });

	const stubs = {
		ao: `#!/usr/bin/env bash
case "$1" in
  status) echo "AO daemon: ready" ;;
  doctor) echo "PASS everything" ;;
  session) echo "[]" ;;
  *) exit 1 ;;
esac
`,
		systemctl: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${SYSTEMCTL_LOG}"
exit 0
`,
		go: `#!/usr/bin/env bash
out=""
while (( $# > 0 )); do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ -n "\${out}" ]]; then printf 'rebuilt ao\\n' > "\${out}"; chmod +x "\${out}"; fi
`,
		gh: `#!/usr/bin/env bash
if [[ "$1" = "api" ]]; then
  cat "\${GH_STATUS_FILE}"
  exit 0
fi
exit 1
`,
		npm: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${NPM_LOG:-/dev/null}"
if [[ "\${NPM_STUB_FAIL:-0}" = "1" ]]; then
  printf 'npm ci failed in stub\\n' >&2
  exit 42
fi
exit 0
`,
	};

	for (const [name, body] of Object.entries(stubs)) {
		const file = path.join(stubBin, name);
		await writeFile(file, body);
		await chmod(file, 0o755);
	}
}

async function startFakeWeb({
	webFailuresBeforeReady = 0,
	closeWebPort = false,
	redirectFirst = false,
	fixedStatus = 0,
	stall = false,
} = {}) {
	let webHits = 0;

	const apiServer = http.createServer((req, res) => {
		res.writeHead(req.url.startsWith("/api/v1/projects") ? 200 : 404, { "content-type": "application/json" });
		res.end("[]");
	});
	const webServer = http.createServer((req, res) => {
		webHits += 1;
		// Accepts the TCP connection, then never answers. Without a per-probe
		// total timeout this hangs the deploy forever.
		if (stall) {
			return;
		}
		if (fixedStatus) {
			res.writeHead(fixedStatus);
			res.end("permanent");
			return;
		}
		if (redirectFirst) {
			if (req.url === "/") {
				res.writeHead(302, { location: "/app" });
				res.end();
				return;
			}
			res.writeHead(200);
			res.end("ok");
			return;
		}
		// Mirrors the real race: ao-web.service is up but the node server behind
		// tailscale serve has not bound its port yet, so the proxy returns 502.
		const ready = webHits > webFailuresBeforeReady;
		res.writeHead(ready ? 200 : 502);
		res.end(ready ? "ok" : "bundle still building");
	});

	await listen(apiServer);
	await listen(webServer);
	const apiPort = apiServer.address().port;
	const webPort = webServer.address().port;
	cleanup.push(() => closeServer(apiServer));
	cleanup.push(() => closeServer(webServer));

	if (closeWebPort) {
		await closeServer(webServer);
	}

	return { apiPort, webUrl: `http://127.0.0.1:${webPort}/`, webHits: () => webHits };
}

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
}

function closeServer(server) {
	return new Promise((resolve) => {
		if (!server.listening) {
			resolve();
			return;
		}
		server.closeAllConnections?.();
		server.close(() => resolve());
	});
}

async function commitFixture(cwd, message) {
	await git(cwd, [
		"add",
		"README.md",
		"backend/cmd/ao/main.go",
		"frontend/app.js",
		"ops/ao-slack-notifier.mjs",
		"ops/ao.service",
		"ops/install-attention.sh",
	]);
	await git(cwd, ["commit", "-m", message]);
}

async function git(cwd, args) {
	return run("git", args, { cwd });
}

async function runDeployDryRun(repoDir, home, env = {}, args = []) {
	return run("bash", [deployScript, ...args], {
		cwd: repoRoot,
		env: {
			...process.env,
			...env,
			AO_DEPLOY_DRY_RUN: "1",
			AO_DEPLOY_REPO_ROOT: repoDir,
			AO_DEPLOY_WAIT_SECONDS: "1",
			AO_DEPLOY_WEB_URL: "https://mirrorborn.tailc1fd9.ts.net/",
			HOME: home,
		},
	});
}

function assertFrontendDependencyInstallBeforeWebRestart(stdout) {
	const frontendInstall = stdout.indexOf("/frontend && npm ci");
	const webRestart = stdout.indexOf("DRY-RUN: systemctl --user restart ao-web.service");

	assert.notEqual(frontendInstall, -1, "frontend npm ci dry-run command should be present");
	assert.notEqual(webRestart, -1, "ao-web.service restart dry-run command should be present");
	assert(frontendInstall < webRestart, "npm ci must run before ao-web.service restart triggers the bundle build");
}

// Runs deploy.sh for real (no AO_DEPLOY_DRY_RUN), with the host-mutating
// commands stubbed on PATH but curl and the HTTP probes genuinely exercised.
async function runDeployLive(fixture, web, env = {}) {
	return run("bash", [deployScript], {
		cwd: repoRoot,
		env: {
			...process.env,
			PATH: `${fixture.stubBin}${path.delimiter}${process.env.PATH}`,
			HOME: fixture.home,
			SYSTEMCTL_LOG: fixture.systemctlLog,
			GH_STATUS_FILE: fixture.ghStatusFile,
			AO_PORT: String(web.apiPort),
			AO_DEPLOY_DRY_RUN: "0",
			AO_DEPLOY_REPO_ROOT: fixture.dir,
			AO_DEPLOY_GITHUB_REPO: "polymath-ventures/agent-orchestrator",
			AO_DEPLOY_STATE_DIR: fixture.stateDir,
			AO_DEPLOY_STATE_FILE: fixture.stateFile,
			AO_DEPLOY_WAIT_SECONDS: "15",
			AO_DEPLOY_WEB_URL: web.webUrl,
			...env,
		},
	});
}

async function run(command, args, options = {}) {
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: options.env ?? process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const code = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	return { code, stdout, stderr };
}
