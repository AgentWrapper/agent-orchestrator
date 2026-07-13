import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guardScript = path.join(repoRoot, "ops", "release-latest-guard.sh");

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

// The guard exists to stop a draft/prerelease from taking over /releases/latest
// and breaking electron-updater's stable channel. But THIS repo deliberately
// carries no stable GitHub release: it deploys from source via ops/deploy.sh to a
// local self-hosted daemon, and there is no updater feed. So on main the guard's
// `gh release view` hit "release not found", exited 1, and left main permanently
// red — which trains everyone to ignore a red main (#293/D3, from #297).
//
// A missing stable latest release must therefore SKIP cleanly. Everything else
// the guard checks must keep failing, so the day a release IS cut it still works.
describe("release latest guard", () => {
	it("is valid bash", async () => {
		const result = await run("bash", ["-n", guardScript]);
		assert.equal(result.code, 0, result.stderr);
	});

	it("skips cleanly when the repo has no stable latest release", async () => {
		const bin = await stubGh({ latestStatus: 404 });

		const result = await runGuard(bin);

		assert.equal(result.code, 0, `a repo with no stable release must not fail the guard\n${result.stderr}`);
		assert.match(result.stdout, /::notice::/, "the skip must be reported as a neutral notice, not a silent pass");
		assert.match(result.stdout, /no stable GitHub release/i);
		assert.doesNotMatch(result.stdout, /::error::/);
	});

	it("still fails a latest release that is missing its updater feed assets", async () => {
		const bin = await stubGh({
			latest: { tag_name: "v0.10.2", draft: false, prerelease: false, assets: [{ name: "ao.AppImage" }] },
		});

		const result = await runGuard(bin);

		assert.notEqual(result.code, 0, "a real stable release still has to carry the updater feed");
		assert.match(result.stdout, /missing updater feed asset 'latest\.yml'/);
	});

	it("still fails a latest release whose tag is not stable semver", async () => {
		const bin = await stubGh({
			latest: {
				tag_name: "v0.10.2-rc1",
				draft: false,
				prerelease: false,
				assets: [{ name: "latest.yml" }, { name: "latest-mac.yml" }, { name: "latest-linux.yml" }],
			},
		});

		const result = await runGuard(bin);

		assert.notEqual(result.code, 0);
		assert.match(result.stdout, /expected a stable semver tag/);
	});

	it("passes a well-formed stable latest release", async () => {
		const bin = await stubGh({
			latest: {
				tag_name: "v0.10.2",
				draft: false,
				prerelease: false,
				assets: [{ name: "latest.yml" }, { name: "latest-mac.yml" }, { name: "latest-linux.yml" }],
			},
		});

		const result = await runGuard(bin);

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		assert.doesNotMatch(result.stdout, /::error::/);
	});

	it("does NOT mask a real API failure as 'no release'", async () => {
		// A 403/rate-limit must stay red. Silently skipping on any gh failure would
		// turn the guard into decoration.
		const bin = await stubGh({ latestStatus: 403 });

		const result = await runGuard(bin);

		assert.notEqual(result.code, 0, "an auth/rate-limit failure must not be reported as 'no stable release'");
		assert.match(result.stdout, /::error::/);
	});
});

async function stubGh({ latest = null, latestStatus = 200 } = {}) {
	const bin = await mkdtemp(path.join(os.tmpdir(), "ao-guard-bin-"));
	cleanup.push(() => rm(bin, { recursive: true, force: true }));
	await mkdir(bin, { recursive: true });

	// Mirrors `gh api`: a non-2xx exits non-zero and prints `gh: ... (HTTP NNN)`
	// on stderr. GitHub's /releases/latest returns 404 when the repo has no
	// published, non-prerelease release.
	const body = latest ? JSON.stringify(latest) : "";
	const gh = `#!/usr/bin/env bash
if [[ "\${1}" = "api" ]]; then
  status=${latestStatus}
  if [[ "\$status" = "404" ]]; then
    printf 'gh: Not Found (HTTP 404)\\n' >&2
    exit 1
  fi
  if [[ "\$status" != "200" ]]; then
    # A 403 body can also say "Not Found" — the guard must key on the STATUS.
    printf 'gh: Not Found (HTTP %s)\\n' "\$status" >&2
    exit 1
  fi
  cat <<'JSON'
${body}
JSON
  exit 0
fi
exit 1
`;
	const file = path.join(bin, "gh");
	await writeFile(file, gh);
	await chmod(file, 0o755);
	return bin;
}

function runGuard(stubBin) {
	return run("bash", [guardScript], {
		env: {
			...process.env,
			PATH: `${stubBin}${path.delimiter}${process.env.PATH}`,
			REPO: "polymath-ventures/agent-orchestrator",
			GH_TOKEN: "stub",
		},
	});
}

async function run(command, args, options = {}) {
	const child = spawn(command, args, {
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
