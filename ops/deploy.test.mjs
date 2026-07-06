import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
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
		assert.match(result.stdout, /DRY-RUN: cp .*\/\.local\/bin\/ao .*\/\.local\/bin\/ao\.prev/);
		assert.match(result.stdout, /DRY-RUN: cd .*\/backend && go build -o .*\/\.local\/bin\/ao \.\/cmd\/ao/);
		assert.match(result.stdout, /DRY-RUN: systemctl --user restart ao\.service/);
		assert.match(result.stdout, /frontend\/ changed; restarting ao-web\.service/);
		assert.match(result.stdout, /DRY-RUN: systemctl --user restart ao-web\.service/);
		assert.match(result.stdout, /ops\/ changed; restarting ao-slack-notifier\.service/);
		assert.match(result.stdout, /DRY-RUN: systemctl --user restart ao-slack-notifier\.service/);
		assert.match(result.stdout, /DRY-RUN: ao status/);
		assert.match(result.stdout, /DRY-RUN: ao doctor/);
		assert.match(result.stdout, /DRY-RUN: curl .*\/api\/v1\/projects/);
		assert(
			result.stdout.indexOf("DRY-RUN: systemctl --user restart ao-web.service") <
				result.stdout.indexOf("https://mirrorborn.tailc1fd9.ts.net/"),
			"tailnet web verification should run after the web unit restart when frontend/ changed",
		);
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
		assert.match(result.stdout, /DRY-RUN: systemctl --user restart ao\.service/);
		assert.doesNotMatch(result.stdout, /go build/);
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
	await writeFile(path.join(dir, "README.md"), "fixture\n");
	await writeFile(path.join(home, ".local", "bin", "ao"), "current ao\n");
	await writeFile(path.join(home, ".local", "bin", "ao.prev"), "previous ao\n");

	await git(dir, ["init", "-b", "main"]);
	await git(dir, ["config", "user.email", "test@example.com"]);
	await git(dir, ["config", "user.name", "Test User"]);

	return { dir, home };
}

async function commitFixture(cwd, message) {
	await git(cwd, ["add", "README.md", "backend/cmd/ao/main.go", "frontend/app.js", "ops/ao-slack-notifier.mjs"]);
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
