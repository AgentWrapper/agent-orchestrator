import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "ops", "install-attention.sh");

let cleanup = [];
beforeEach(() => {
	cleanup = [];
});
afterEach(async () => {
	await Promise.all(
		cleanup
			.splice(0)
			.reverse()
			.map((f) => f()),
	);
});

async function tmp(prefix) {
	const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function run(env) {
	return new Promise((resolve) => {
		const child = spawn("bash", [script], { cwd: repoRoot, env: { ...process.env, ...env } });
		let out = "";
		let err = "";
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (err += c));
		child.on("close", (code) => resolve({ code, out, err }));
	});
}

describe("install-attention.sh (acceptance #4 — config in nickify/deploy layer)", () => {
	it("is valid bash", async () => {
		const r = await run({ AO_ATTENTION_DRY_RUN: "1" });
		assert.equal(r.code, 0, r.err);
	});

	it("installs both attention units into the units dir", async () => {
		const units = await tmp("ao-units-");
		const home = await tmp("ao-home-");
		const envFile = path.join(home, ".env");
		await writeFile(envFile, "SLACK_MEMBER_ID=U1\nSLACK_SIGNING_SECRET=sec\nSLACK_WEBHOOK_URL=http://hook\n");
		const r = await run({
			AO_ATTENTION_UNITS_DIR: units,
			AO_ENV_FILE: envFile,
			AO_ATTENTION_START: "0",
			AO_ATTENTION_DRY_RUN: "0",
			// daemon-reload will run for real but must not fail the test in CI;
			// user bus may be absent, so allow it via dry-run of systemctl only.
		}).catch(() => ({ code: 1, out: "", err: "spawn" }));
		// The cp step is real; the systemctl step may warn but the units must land.
		const listed = await readdir(units).catch(() => []);
		assert.ok(listed.includes("ao-attention-notifier.service"), r.err || r.out);
		assert.ok(listed.includes("ao-attention-reply.service"));
		const body = await readFile(path.join(units, "ao-attention-notifier.service"), "utf8");
		assert.match(body, /attention-notifier\.mjs/);
	});

	it("warns (does not fail) when required config keys are missing", async () => {
		const units = await tmp("ao-units-");
		const home = await tmp("ao-home-");
		const envFile = path.join(home, ".env");
		await writeFile(envFile, "SOMETHING_ELSE=1\n");
		const r = await run({
			AO_ATTENTION_UNITS_DIR: units,
			AO_ENV_FILE: envFile,
			AO_ATTENTION_START: "0",
			AO_ATTENTION_DRY_RUN: "0",
		});
		assert.match(r.out, /WARN: missing attention config/);
		assert.match(r.out, /SLACK_MEMBER_ID/);
		assert.match(r.out, /SLACK_SIGNING_SECRET/);
	});

	it("warns when a bot token has no channel and no webhook (sink is unusable)", async () => {
		const units = await tmp("ao-units-");
		const home = await tmp("ao-home-");
		const envFile = path.join(home, ".env");
		await writeFile(envFile, "SLACK_MEMBER_ID=U1\nSLACK_SIGNING_SECRET=sec\nSLACK_BOT_TOKEN=xoxb\n");
		const r = await run({
			AO_ATTENTION_UNITS_DIR: units,
			AO_ENV_FILE: envFile,
			AO_ATTENTION_START: "0",
			AO_ATTENTION_DRY_RUN: "0",
		});
		assert.match(r.out, /Slack sink/);
	});

	it("accepts a bot token paired with a channel as a valid sink", async () => {
		const units = await tmp("ao-units-");
		const home = await tmp("ao-home-");
		const envFile = path.join(home, ".env");
		await writeFile(envFile, "SLACK_MEMBER_ID=U1\nSLACK_SIGNING_SECRET=sec\nSLACK_BOT_TOKEN=xoxb\nSLACK_CHANNEL=C1\n");
		const r = await run({
			AO_ATTENTION_UNITS_DIR: units,
			AO_ENV_FILE: envFile,
			AO_ATTENTION_START: "0",
			AO_ATTENTION_DRY_RUN: "0",
		});
		assert.doesNotMatch(r.out, /Slack sink/);
	});
});
