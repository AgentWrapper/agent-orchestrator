import assert from "node:assert/strict";
import {
	access,
	chmod,
	lstat,
	mkdtemp,
	mkdir,
	readdir,
	readFile,
	readlink,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployScript = path.join(repoRoot, "ops", "deploy.sh");

// A systemd setting that hands the daemon prime activation. Leading whitespace is
// significant: systemd accepts an indented directive, so the guards must too.
const PRIME_ACTIVATION_LINE = /^[ \t]*Environment(?:File)?=.*AO_PRIME_/m;

// Fold a unit into systemd's *logical* lines: a trailing backslash continues the
// directive, and systemd skips blank/comment lines inside that continuation. Guards
// must match what systemd reads, not how the file happens to be typed — otherwise
// `Environment=FOO=1 \` + `# comment` + `AO_PRIME_...=x` activates prime unseen.
const asLogicalLines = (unitBody) => {
	const logical = [];
	let pending = null;
	// Strip CR first: on a CRLF unit the continuation backslash is followed by \r, so
	// without this the directive never folds and the guard misses what systemd reads.
	for (const raw of unitBody.replace(/\r\n/g, "\n").split("\n")) {
		if (pending !== null && (/^[ \t]*$/.test(raw) || /^[ \t]*[#;]/.test(raw))) {
			continue;
		}
		const line = pending === null ? raw : `${pending} ${raw.replace(/^[ \t]+/, "")}`;
		if (/\\$/.test(line)) {
			pending = line.replace(/[ \t]*\\$/, "");
			continue;
		}
		pending = null;
		logical.push(line);
	}
	if (pending !== null) {
		logical.push(pending);
	}
	return logical.join("\n");
};

// One `journalctl -o json` record, as deploy.sh's sudo classifier reads them.
const journalEntry = (cmdline, message) => JSON.stringify({ _COMM: "sudo", _CMDLINE: cmdline, MESSAGE: message });

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

	it("stages a release, installs stable units, and restarts every local service", async () => {
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
		assert.match(result.stdout, /DRY-RUN: git clone --no-checkout /);
		assert.match(result.stdout, /DRY-RUN: cd .*\/source\/backend && go build -o .*\/bin\/ao \.\/cmd\/ao/);
		assert.match(result.stdout, /DRY-RUN: render .*\/ops\/ao\.service -> .*\/systemd\/ao\.service/);
		assert.match(result.stdout, /DRY-RUN: atomically point .*\/\.ao\/deploy\/current at .*\/releases\//);
		assert.match(result.stdout, /DRY-RUN: ln -sfn .*\/\.ao\/deploy\/current\/bin\/ao .*\/\.local\/bin\/ao\.tmp/);
		assert.match(result.stdout, /DRY-RUN: mv -Tf .*\/\.local\/bin\/ao\.tmp .*\/\.local\/bin\/ao/);
		assert.match(
			result.stdout,
			/DRY-RUN: cp .*\/\.ao\/deploy\/current\/systemd\/ao\.service .*\/\.config\/systemd\/user\/ao\.service/,
		);
		assert.match(result.stdout, /DRY-RUN: systemctl --user daemon-reload/);
		assert.match(
			result.stdout,
			/DRY-RUN: systemctl --user enable ao\.service ao-tmux\.service ao-tmux-claim\.timer ao-web\.service ao-slack-notifier\.service ao-attention-reply\.service/,
		);
		assert.match(result.stdout, /DRY-RUN: systemctl --user restart ao\.service/);
		assert.match(
			result.stdout,
			/web inputs changed \(frontend\/\); restarting ao-web\.service from the activated release/,
		);
		assert.match(result.stdout, /DRY-RUN: systemctl --user restart ao-web\.service/);
		assert.match(result.stdout, /Restarting ao-slack-notifier\.service from the activated release/);
		assert.match(result.stdout, /DRY-RUN: systemctl --user restart ao-slack-notifier\.service/);
		assert.match(result.stdout, /Restarting ao-attention-reply\.service from the activated release/);
		assert.match(result.stdout, /outbound attention notifier remains retired/);
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

	it("builds a requested non-current ref from an isolated release checkout", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const requested = (await git(fixture.dir, ["rev-parse", "HEAD"])).stdout.trim();

		await writeFile(path.join(fixture.dir, "README.md"), "newer head\n");
		await commitFixture(fixture.dir, "newer head");
		const invokingHead = (await git(fixture.dir, ["rev-parse", "HEAD"])).stdout.trim();
		assert.notEqual(invokingHead, requested, "fixture must have a newer HEAD than the requested deploy ref");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, { AO_DEPLOY_HEAD: requested });

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, new RegExp(`Deploy range: .*\\.\\.${requested}`));
		assert.equal((await readFile(fixture.stateFile, "utf8")).trim(), requested);

		const buildLog = await readFile(fixture.goBuildLog, "utf8");
		assert.match(buildLog, /cwd=.*\/releases\/\.staging-.*\/source\/backend/m);
		assert.doesNotMatch(buildLog, new RegExp(`cwd=${escapeRegExp(path.join(fixture.dir, "backend"))}`));

		const current = await lstat(path.join(fixture.stateDir, "current"));
		assert.equal(current.isSymbolicLink(), true, "current release pointer must be a symlink");
		assert.equal((await readFile(path.join(fixture.stateDir, "current", "REVISION"), "utf8")).trim(), requested);
	});

	it("does not corrupt dry-run head resolution when an origin remote exists", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const head = (await git(fixture.dir, ["rev-parse", "HEAD"])).stdout.trim();
		const remote = await mkdtemp(path.join(fixture.home, "origin-"));
		await git(remote, ["init", "--bare"]);
		await git(fixture.dir, ["remote", "add", "origin", remote]);

		const result = await runDeployDryRun(fixture.dir, fixture.home);

		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stderr, /DRY-RUN: git -C .* fetch --tags --prune origin/);
		assert.match(result.stdout, new RegExp(`Deploy range: .*\\.\\.${head}`));
		assert.doesNotMatch(result.stdout, /Deploy range: .*DRY-RUN: git/);
	});

	it("keeps dirty files in the invoking checkout out of the staged build", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		await writeFile(path.join(fixture.dir, "UNTRACKED_DEPLOY_POISON"), "must not enter release source\n");
		await writeFile(path.join(fixture.dir, "README.md"), "dirty invoking checkout\n");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		const buildLog = await readFile(fixture.goBuildLog, "utf8");
		assert.match(buildLog, /^git-dir=directory$/m, "staged source must have a real .git directory");
		assert.match(buildLog, /^status=$/m, "staged source must be clean when go build starts");
		assert.doesNotMatch(buildLog, /UNTRACKED_DEPLOY_POISON/);
	});

	it("builds from a real git directory even when invoked from a linked worktree", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const linked = path.join(fixture.home, "linked-worktree");
		await git(fixture.dir, ["worktree", "add", linked]);
		await writeFile(path.join(fixture.dir, "UNTRACKED_PARENT_POISON"), "must not affect linked deploy\n");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, { AO_DEPLOY_REPO_ROOT: linked });

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		const buildLog = await readFile(fixture.goBuildLog, "utf8");
		assert.match(buildLog, /^git-dir=directory$/m);
		assert.match(buildLog, /^status=$/m);
		assert.doesNotMatch(buildLog, /UNTRACKED_PARENT_POISON/);
	});

	it("installs stable units whose runtime paths resolve through the current release", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		for (const unit of ["ao.service", "ao-web.service", "ao-slack-notifier.service", "ao-attention-reply.service"]) {
			const body = await readFile(path.join(fixture.home, ".config", "systemd", "user", unit), "utf8");
			assert.match(
				body,
				new RegExp(`${escapeRegExp(fixture.stateDir)}/current`),
				`${unit} should point at the configured current release`,
			);
			assert.doesNotMatch(
				body,
				/%h\/agent-orchestrator\/ops/,
				`${unit} must not execute ops from the mutable checkout`,
			);
		}
		const systemctlLog = await readFile(fixture.systemctlLog, "utf8");
		assert.match(
			systemctlLog,
			/^--user enable ao\.service ao-tmux\.service ao-tmux-claim\.timer ao-web\.service ao-slack-notifier\.service ao-attention-reply\.service$/m,
		);
	});

	it("installs units that leave prime activation to the operator", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		for (const unit of [
			"ao.service",
			"ao-tmux.service",
			"ao-tmux-claim.service",
			"ao-tmux-claim.timer",
			"ao-web.service",
			"ao-slack-notifier.service",
			"ao-attention-reply.service",
		]) {
			const body = await readFile(path.join(fixture.home, ".config", "systemd", "user", unit), "utf8");
			assert.doesNotMatch(
				asLogicalLines(body),
				PRIME_ACTIVATION_LINE,
				`deploy must not install a ${unit} that activates prime; prime is an operator-only runtime toggle`,
			);
		}
	});

	it("strips prime activation split across a systemd line continuation", async () => {
		// systemd folds a trailing-backslash directive into one logical line and skips
		// blank/comment lines inside it, so a per-physical-line strip would install a
		// prime-activating unit that still reads clean. Tab-separated assignments too.
		const fixture = await makeGitFixture();
		const cleanUnit = await readFile(path.join(fixture.dir, "ops", "ao.service"), "utf8");
		await writeFile(
			path.join(fixture.dir, "ops", "ao.service"),
			cleanUnit.replace(
				/^Delegate=yes$/m,
				'Environment=AO_PRIME_PROJECT_ID=agent-orchestrator\t"AO_PRIME_DISPLAY_NAME=AO Prime" \\\n' +
					"# systemd ignores this comment inside the continuation\n" +
					"    AO_PRIME_EXTRA=1\nDelegate=yes",
			),
		);
		await commitFixture(fixture.dir, "release activating prime via a continuation line");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		const installed = await readFile(path.join(fixture.home, ".config", "systemd", "user", "ao.service"), "utf8");
		assert.doesNotMatch(
			asLogicalLines(installed),
			PRIME_ACTIVATION_LINE,
			"a continuation-split directive must not smuggle prime activation past the install-time strip",
		);
		assert.match(installed, /^ExecStart=/m, "the sanitized unit must still be a usable service");
		assert.match(installed, /^Environment=PATH=/m, "unrelated directives must survive");
	});

	it("refuses a daemon unit whose directive mixes prime activation with other variables", async () => {
		// Dropping the whole directive would silently strip AO_KEEP_ME and could turn an
		// emergency rollback into a broken service; rewriting it risks corrupting a value
		// we did not parse correctly. Neither is safe, so refuse and say why.
		const fixture = await makeGitFixture();
		const cleanUnit = await readFile(path.join(fixture.dir, "ops", "ao.service"), "utf8");
		await writeFile(
			path.join(fixture.dir, "ops", "ao.service"),
			cleanUnit.replace(/^Delegate=yes$/m, "Environment=AO_KEEP_ME=1 AO_PRIME_PROJECT_ID=x\nDelegate=yes"),
		);
		await commitFixture(fixture.dir, "release co-assigning prime with a required variable");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.notEqual(result.code, 0, `deploy must refuse this unit\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /mixes prime activation with other variables/);
	});

	it("refuses a daemon unit that hides prime activation behind a backslash escape", async () => {
		// systemd decodes C-style escapes, so `A\x4f_PRIME_PROJECT_ID` IS AO_PRIME_PROJECT_ID
		// while containing no literal match. Rather than reimplement systemd's unescaping,
		// treat an escape in the daemon unit as unverifiable and refuse it.
		const fixture = await makeGitFixture();
		const cleanUnit = await readFile(path.join(fixture.dir, "ops", "ao.service"), "utf8");
		await writeFile(
			path.join(fixture.dir, "ops", "ao.service"),
			cleanUnit.replace(/^Delegate=yes$/m, "Environment=A\\x4f_PRIME_PROJECT_ID=agent-orchestrator\nDelegate=yes"),
		);
		await commitFixture(fixture.dir, "release hiding prime behind an escape");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.notEqual(result.code, 0, `deploy must refuse this unit\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /escaping we cannot verify|backslash escapes we cannot verify/);
	});

	it("installs a daemon unit whose unrelated directive contains a backslash", async () => {
		// A backslash in a Description= cannot activate prime. Refusing it would abort an
		// emergency rollback over nothing, which is the worse failure.
		const fixture = await makeGitFixture();
		const cleanUnit = await readFile(path.join(fixture.dir, "ops", "ao.service"), "utf8");
		await writeFile(
			path.join(fixture.dir, "ops", "ao.service"),
			cleanUnit.replace(/^Description=.*$/m, "Description=Agent Orchestrator daemon \\o/"),
		);
		await commitFixture(fixture.dir, "release with a harmless backslash");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.equal(result.code, 0, `a harmless backslash must not refuse the unit\n${result.stdout}\n${result.stderr}`);
		const installed = await readFile(path.join(fixture.home, ".config", "systemd", "user", "ao.service"), "utf8");
		assert.match(installed, /^ExecStart=/m, "the unit must install unchanged");
	});

	it("still detects prime activation in a unit too large to fit a pipe buffer", async () => {
		// The prime-free check must not be a `grep -v | grep -q` pipeline: the downstream
		// grep exits on match, the upstream dies of SIGPIPE (141), and `set -o pipefail`
		// turns that into "prime-free" for a unit that DOES activate prime. It only shows
		// up once the unit is big enough that the upstream grep is still writing.
		const fixture = await makeGitFixture();
		const cleanUnit = await readFile(path.join(fixture.dir, "ops", "ao.service"), "utf8");
		// The padding must SURVIVE the check's own comment filter and sit AFTER the match,
		// so the upstream grep is still writing when the downstream one exits — comments
		// would be filtered out and never fill the pipe.
		const padding = Array.from(
			{ length: 4000 },
			(_, i) => `Environment=AO_PAD_${i}=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
		).join("\n");
		await writeFile(
			path.join(fixture.dir, "ops", "ao.service"),
			// ExecStart-smuggled prime survives sanitizing, so only the prime-free check
			// can catch it — exactly the check the pipeline bug would have blinded.
			cleanUnit.replace(
				/^ExecStart=.*$/m,
				`ExecStart=/usr/bin/env AO_PRIME_PROJECT_ID=agent-orchestrator %h/.ao/deploy/current/bin/ao daemon\n${padding}`,
			),
		);
		await commitFixture(fixture.dir, "large release smuggling prime through ExecStart");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.notEqual(result.code, 0, `deploy must refuse this unit\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /still activates prime after sanitizing/);
	});

	it("folds CRLF payloads rather than refusing them", async () => {
		// A CRLF unit's continuation backslash is followed by \r. Left unhandled it fails
		// to fold and then reads as an escape, refusing a unit that is merely Windows-eol.
		const fixture = await makeGitFixture();
		const cleanUnit = await readFile(path.join(fixture.dir, "ops", "ao.service"), "utf8");
		const withPrime = cleanUnit.replace(
			/^Delegate=yes$/m,
			"Environment=AO_PRIME_PROJECT_ID=agent-orchestrator\nDelegate=yes",
		);
		await writeFile(path.join(fixture.dir, "ops", "ao.service"), withPrime.replace(/\n/g, "\r\n"));
		await commitFixture(fixture.dir, "CRLF release carrying prime");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.equal(result.code, 0, `a CRLF unit must not be refused\n${result.stdout}\n${result.stderr}`);
		const installed = await readFile(path.join(fixture.home, ".config", "systemd", "user", "ao.service"), "utf8");
		assert.doesNotMatch(asLogicalLines(installed), PRIME_ACTIVATION_LINE, "prime must still be stripped from CRLF");
		assert.match(installed, /^ExecStart=/m, "the sanitized unit must still be a usable service");
	});

	it("leaves every unit untouched when one of them is refused", async () => {
		// Units are validated before any is installed, so a refusal cannot leave the host
		// with a half-updated set (a new daemon unit beside an old web unit, say).
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		let web = await startFakeWeb();
		let result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

		const systemdDir = path.join(fixture.home, ".config", "systemd", "user");
		const webBefore = await readFile(path.join(systemdDir, "ao-web.service"), "utf8");

		const cleanUnit = await readFile(path.join(fixture.dir, "ops", "ao.service"), "utf8");
		await writeFile(
			path.join(fixture.dir, "ops", "ao.service"),
			cleanUnit.replace(/^Delegate=yes$/m, "Environment=AO_KEEP_ME=1 AO_PRIME_PROJECT_ID=x\nDelegate=yes"),
		);
		await writeFile(path.join(fixture.dir, "ops", "ao-web.service"), "[Service]\nExecStart=/new-web\n");
		await commitFixture(fixture.dir, "release whose daemon unit must be refused");

		web = await startFakeWeb();
		result = await runDeployLive(fixture, web);

		assert.notEqual(result.code, 0, `deploy must refuse\n${result.stdout}\n${result.stderr}`);
		assert.equal(
			await readFile(path.join(systemdDir, "ao-web.service"), "utf8"),
			webBefore,
			"a refused deploy must not have installed the other units",
		);
		// Stray mktemp staging files look like `<unit>.service.XXXXXX`. A
		// `<unit>.service.d` drop-in DIR is a legitimate installed artifact (#293
		// H4), not a leftover, so it is not a stranded temp file.
		const leftovers = (await readdir(systemdDir)).filter((f) => f.includes(".service.") && !f.endsWith(".service.d"));
		assert.deepEqual(leftovers, [], `refusal must not strand staged temp files: ${leftovers}`);
	});

	it("does not replay prime when restoring units after a failed install", async () => {
		// The restore path is an install path. A host that has not taken this fix yet has a
		// PRIME-BAKED ao.service installed, so putting the snapshot back verbatim after a
		// failed commit would replay the exact activation this code exists to stop.
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const unitDir = path.join(fixture.home, ".config", "systemd", "user");
		await mkdir(unitDir, { recursive: true });
		// The prime-baked unit this host is currently running.
		await writeFile(
			path.join(unitDir, "ao.service"),
			"[Service]\nExecStart=%h/.local/bin/ao daemon\nEnvironment=AO_PRIME_PROJECT_ID=agent-orchestrator\n",
		);
		// Make one later unit's destination un-mv-able so the commit fails part-way and
		// the restore path runs for real.
		await mkdir(path.join(unitDir, "ao-web.service"), { recursive: true });

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.notEqual(result.code, 0, `the failed commit must fail the deploy\n${result.stdout}\n${result.stderr}`);
		const restored = await readFile(path.join(unitDir, "ao.service"), "utf8");
		assert.doesNotMatch(
			asLogicalLines(restored),
			PRIME_ACTIVATION_LINE,
			"restoring the previous units must not put prime activation back",
		);
		const leftovers = (await readdir(unitDir)).filter((f) => f.includes(".service."));
		assert.deepEqual(leftovers, [], `a failed commit must strand no temp files: ${leftovers}`);
	});

	it("restores a masked unit as a mask rather than deleting it", async () => {
		// A masked unit is a symlink to /dev/null, and `-f` follows the link to a character
		// device — so a naive existence check reports it absent and the restore deletes it,
		// silently unmasking a unit the operator masked on purpose.
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const unitDir = path.join(fixture.home, ".config", "systemd", "user");
		await mkdir(unitDir, { recursive: true });
		await symlink("/dev/null", path.join(unitDir, "ao-slack-notifier.service"));
		// Force the commit to fail part-way so the restore path runs.
		await mkdir(path.join(unitDir, "ao-attention-reply.service"), { recursive: true });

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.notEqual(result.code, 0, `the failed commit must fail the deploy\n${result.stdout}\n${result.stderr}`);
		const notifier = path.join(unitDir, "ao-slack-notifier.service");
		assert.equal((await lstat(notifier)).isSymbolicLink(), true, "the mask must be restored as a symlink");
		assert.equal(await readlink(notifier), "/dev/null", "the mask must still point at /dev/null");
	});

	it("installs a daemon unit that explicitly unsets prime rather than refusing it", async () => {
		// The fail-closed check must not fire on a unit that REMOVES prime. A false
		// positive here bricks an emergency rollback, which is the likelier harm.
		const fixture = await makeGitFixture();
		const cleanUnit = await readFile(path.join(fixture.dir, "ops", "ao.service"), "utf8");
		await writeFile(
			path.join(fixture.dir, "ops", "ao.service"),
			cleanUnit.replace(/^Delegate=yes$/m, "UnsetEnvironment=AO_PRIME_PROJECT_ID\nDelegate=yes"),
		);
		await commitFixture(fixture.dir, "release explicitly unsetting prime");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.equal(result.code, 0, `an explicit unset must not be refused\n${result.stdout}\n${result.stderr}`);
		const installed = await readFile(path.join(fixture.home, ".config", "systemd", "user", "ao.service"), "utf8");
		assert.match(installed, /^UnsetEnvironment=AO_PRIME_PROJECT_ID$/m, "the unset directive must survive");
	});

	it("strips an EnvironmentFile from the daemon unit, whose contents it cannot see", async () => {
		// Only the daemon reads AO_PRIME_*, and its shipped unit has no EnvironmentFile.
		// An older release could point one at a file outside this repo that sets prime,
		// so the daemon unit gets every EnvironmentFile dropped. The notifier and
		// attention-reply units legitimately use theirs and must keep them.
		const fixture = await makeGitFixture();
		const cleanUnit = await readFile(path.join(fixture.dir, "ops", "ao.service"), "utf8");
		await writeFile(
			path.join(fixture.dir, "ops", "ao.service"),
			cleanUnit.replace(/^Delegate=yes$/m, "EnvironmentFile=-%h/agent-orchestrator/.env\nDelegate=yes"),
		);
		await commitFixture(fixture.dir, "release pointing the daemon at an external env file");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		const systemdDir = path.join(fixture.home, ".config", "systemd", "user");
		const daemon = await readFile(path.join(systemdDir, "ao.service"), "utf8");
		assert.doesNotMatch(daemon, /^[ \t]*EnvironmentFile=/m, "the daemon unit must take no external env file");
		assert.match(daemon, /^ExecStart=/m, "the sanitized unit must still be a usable service");

		const notifier = await readFile(path.join(systemdDir, "ao-slack-notifier.service"), "utf8");
		assert.match(notifier, /^EnvironmentFile=/m, "non-daemon units must keep their legitimate EnvironmentFile");
	});

	it("refuses to install a daemon unit that activates prime through syntax it cannot sanitize", async () => {
		// Fail closed. Enumerating every way systemd can be told to set a variable is a
		// losing game (here: ExecStart via `env`), so anything still naming AO_PRIME_
		// after sanitizing stops the deploy loudly rather than quietly booting prime-on.
		const fixture = await makeGitFixture();
		const cleanUnit = await readFile(path.join(fixture.dir, "ops", "ao.service"), "utf8");
		await writeFile(
			path.join(fixture.dir, "ops", "ao.service"),
			cleanUnit.replace(
				/^ExecStart=.*$/m,
				"ExecStart=/usr/bin/env AO_PRIME_PROJECT_ID=agent-orchestrator %h/.ao/deploy/current/bin/ao daemon",
			),
		);
		await commitFixture(fixture.dir, "release smuggling prime through ExecStart");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.notEqual(result.code, 0, `deploy must refuse this unit\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /still activates prime after sanitizing/);
	});

	it("strips prime activation when rolling back to a release whose unit still carries it", async () => {
		// Every release built before prime activation left the unit template still
		// has AO_PRIME_* in its rendered unit. Rollback reinstalls that release's
		// unit verbatim, so without install-time sanitizing an unrelated rollback
		// silently switches prime back on.
		const fixture = await makeGitFixture();
		const cleanUnit = await readFile(path.join(fixture.dir, "ops", "ao.service"), "utf8");
		await writeFile(
			path.join(fixture.dir, "ops", "ao.service"),
			cleanUnit.replace(
				/^Delegate=yes$/m,
				'Environment=AO_PRIME_PROJECT_ID=agent-orchestrator\nEnvironment="AO_PRIME_DISPLAY_NAME=AO Prime"\nDelegate=yes',
			),
		);
		await commitFixture(fixture.dir, "release whose template still activates prime");
		const primeBaked = (await git(fixture.dir, ["rev-parse", "HEAD"])).stdout.trim();

		let web = await startFakeWeb();
		let result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

		await writeFile(path.join(fixture.dir, "ops", "ao.service"), cleanUnit);
		await commitFixture(fixture.dir, "prime activation removed from the template");
		web = await startFakeWeb();
		result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

		web = await startFakeWeb();
		web.setVersionRevision(primeBaked);
		result = await runDeployLive(fixture, web, {}, { args: ["--rollback"], daemonRevision: primeBaked });
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

		const installed = await readFile(path.join(fixture.home, ".config", "systemd", "user", "ao.service"), "utf8");
		assert.doesNotMatch(
			asLogicalLines(installed),
			PRIME_ACTIVATION_LINE,
			"rolling back to a prime-baked release must not reinstate prime activation",
		);
		assert.match(installed, /^ExecStart=/m, "the rolled-back unit must still be a usable service");
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
		assert.match(result.stdout, /Installing frontend dependencies with npm ci for staged web build/);
		assert.match(result.stdout, /DRY-RUN: cd .*\/frontend && npm ci --cache .*\/npm-cache --prefer-offline/);
		assertFrontendDependencyInstallBeforeWebRestart(result.stdout);
	});

	it("rejects output that restarts web before the frontend dependency install", () => {
		// This guards the test assertion itself: the backend dry-run cd line must
		// never count as evidence that frontend dependencies were installed first.
		const stdout = [
			"DRY-RUN: cd /repo/backend && go build -o /home/user/.local/bin/ao ./cmd/ao",
			"DRY-RUN: systemctl --user restart ao-web.service",
			"DRY-RUN: cd /repo/frontend && npm ci --cache /repo-cache --prefer-offline",
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

		const systemctlLog = await readFile(fixture.systemctlLog, "utf8").catch(() => "");
		assert.doesNotMatch(systemctlLog, /^--user restart ao-web\.service$/m);
		await assert.rejects(access(fixture.stateFile), "a failed dependency install must not record the deployed ref");
	});

	it("restarts web and notifier units even when directories are unchanged so they follow current", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "README.md"), "readme changed\n");
		await commitFixture(fixture.dir, "docs only");

		const result = await runDeployDryRun(fixture.dir, fixture.home, { AO_DEPLOY_BASE: base.stdout.trim() });

		assert.equal(result.code, 0, result.stderr);
		assert.match(
			result.stdout,
			/no web inputs changed; restarting ao-web\.service so it follows the activated release pointer/,
		);
		assert.match(result.stdout, /DRY-RUN: systemctl --user restart ao-web\.service/);
		assert.match(result.stdout, /Restarting ao-slack-notifier\.service from the activated release/);
		assert.match(result.stdout, /DRY-RUN: systemctl --user restart ao-slack-notifier\.service/);
		assert.match(result.stdout, /Restarting ao-attention-reply\.service from the activated release/);
	});

	it("rolls back by switching the release pointer and restarting all services without rebuilding", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		const result = await runDeployDryRun(fixture.dir, fixture.home, {}, ["--rollback"]);

		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /Rolling back ao release/);
		assert.match(result.stdout, /DRY-RUN: atomically point .*\/\.ao\/deploy\/current at previous release/);
		assert.match(result.stdout, /DRY-RUN: ln -sfn .*\/\.ao\/deploy\/current\/bin\/ao .*\/\.local\/bin\/ao\.tmp/);
		assert.match(result.stdout, /DRY-RUN: mv -Tf .*\/\.local\/bin\/ao\.tmp .*\/\.local\/bin\/ao/);
		assert.match(
			result.stdout,
			/DRY-RUN: cp .*\/\.ao\/deploy\/current\/systemd\/ao\.service .*\/\.config\/systemd\/user\/ao\.service/,
		);
		assert.match(result.stdout, /DRY-RUN: systemctl --user daemon-reload/);
		assert.match(result.stdout, /DRY-RUN: systemctl --user restart ao\.service/);
		assert.match(result.stdout, /DRY-RUN: systemctl --user restart ao-web\.service/);
		assert.match(result.stdout, /DRY-RUN: systemctl --user restart ao-slack-notifier\.service/);
		assert.match(result.stdout, /DRY-RUN: systemctl --user restart ao-attention-reply\.service/);
		assert.doesNotMatch(result.stdout, /go build/);
	});

	it("leaves the prior release active when a new build fails before activation", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const first = (await git(fixture.dir, ["rev-parse", "HEAD"])).stdout.trim();
		let web = await startFakeWeb();
		let result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		const activeBefore = await readlinkReal(path.join(fixture.stateDir, "current"));

		await writeFile(path.join(fixture.dir, "ops", "ao-slack-notifier.mjs"), "console.log('new ops');\n");
		await commitFixture(fixture.dir, "ops change");
		await writeFile(fixture.systemctlLog, "");
		web = await startFakeWeb();
		result = await runDeployLive(fixture, web, { AO_TEST_VCS_MODIFIED: "true" });

		assert.notEqual(result.code, 0, "dirty build must fail before activation");
		assert.equal(await readlinkReal(path.join(fixture.stateDir, "current")), activeBefore);
		assert.equal((await readFile(path.join(fixture.stateDir, "current", "REVISION"), "utf8")).trim(), first);
		assert.equal((await readFile(fixture.stateFile, "utf8")).trim(), first);
		const systemctlLog = await readFile(fixture.systemctlLog, "utf8").catch(() => "");
		assert.equal(systemctlLog, "", "pre-activation failure must not restart services");
	});

	it("cleans stale staging directories and strips build-only payload from activated releases", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const stale = path.join(fixture.stateDir, "releases", ".staging-stale");
		await mkdir(stale, { recursive: true });
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
		await utimes(stale, old, old);

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		await assert.rejects(access(stale), "stale staging dirs should be pruned");
		await assert.rejects(access(path.join(fixture.stateDir, "current", "source", ".git")));
		await assert.rejects(access(path.join(fixture.stateDir, "current", "source", "frontend", "node_modules")));
		await assert.doesNotReject(access(path.join(fixture.stateDir, "current", "FRONTEND_TREE")));
		await assert.doesNotReject(
			access(path.join(fixture.stateDir, "current", "source", "frontend", "dist", "index.html")),
		);
	});

	it("captures the pre-restart session count immediately before restarting the daemon", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		let web = await startFakeWeb();
		let result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		await writeFile(fixture.orderLog, "");

		await writeFile(path.join(fixture.dir, "frontend", "app.js"), "console.log('force web build');\n");
		await commitFixture(fixture.dir, "frontend change");

		web = await startFakeWeb();
		result = await runDeployLive(fixture, web);

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		const order = (await readFile(fixture.orderLog, "utf8")).trim().split("\n");
		const goBuild = order.indexOf("go build");
		const npmBuild = order.indexOf("npm run build:web");
		const preRestartSessionCount = order.indexOf("session count");
		const daemonRestart = order.indexOf("systemctl restart ao.service");
		assert(goBuild !== -1, order.join("\n"));
		assert(npmBuild !== -1, order.join("\n"));
		assert(preRestartSessionCount !== -1, order.join("\n"));
		assert(daemonRestart !== -1, order.join("\n"));
		assert(preRestartSessionCount > goBuild, "pre-restart count should not include staging/build time");
		assert(preRestartSessionCount > npmBuild, "pre-restart count should not include web build time");
		assert(preRestartSessionCount < daemonRestart, "pre-restart count should be captured just before daemon restart");
	});

	it("refuses concurrent deploys while another deploy lock is held", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		await mkdir(fixture.stateDir, { recursive: true });
		const lockPath = path.join(fixture.stateDir, "deploy.lock");
		const holder = spawn("bash", ["-c", `exec 9>${JSON.stringify(lockPath)}; flock -n 9; printf ready; sleep 30`]);
		cleanup.push(() => {
			holder.kill("SIGTERM");
			return Promise.resolve();
		});
		await waitForStdout(holder, "ready");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /Another ao deploy or rollback already holds/);
	});

	it("fails before service restarts when Slack sink config is missing", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		await writeFile(fixture.slackEnvFile, "SLACK_MEMBER_ID=U1\nSLACK_SIGNING_SECRET=sec\n");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /has no usable sink/);
		const systemctlLog = await readFile(fixture.systemctlLog, "utf8").catch(() => "");
		assert.equal(systemctlLog, "", "Slack precondition failure must not restart services");
	});

	it("fails before service restarts when Slack member or signing config is missing", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		await writeFile(fixture.slackEnvFile, "SLACK_WEBHOOK_URL=http://hook\n");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /missing SLACK_MEMBER_ID or SLACK_SIGNING_SECRET/);
		const systemctlLog = await readFile(fixture.systemctlLog, "utf8").catch(() => "");
		assert.equal(systemctlLog, "", "Slack precondition failure must not restart services");
	});

	it("rejects quoted-empty Slack sinks before service restarts", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		await writeFile(
			fixture.slackEnvFile,
			'SLACK_MEMBER_ID=U1\nSLACK_SIGNING_SECRET=sec\nSLACK_WEBHOOK_URL=""\nSLACK_BOT_TOKEN=""\nSLACK_CHANNEL=""\n',
		);

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /has no usable sink/);
		const systemctlLog = await readFile(fixture.systemctlLog, "utf8").catch(() => "");
		assert.equal(systemctlLog, "", "Slack precondition failure must not restart services");
	});

	it("accepts bot-token Slack sinks with modern per-channel config", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		await writeFile(
			fixture.slackEnvFile,
			"SLACK_MEMBER_ID=U1\nSLACK_SIGNING_SECRET=sec\nSLACK_BOT_TOKEN=xoxb\nSLACK_CHANNEL_NOTIFY=C-notify\nSLACK_CHANNEL_NEEDS_RESPONSE=C-needs\n",
		);

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /Slack notifier and reply config verified/);
	});

	it("retires the legacy outbound attention notifier during deploy", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const legacyState = path.join(fixture.home, ".ao", "attention-state.json");
		await mkdir(path.dirname(legacyState), { recursive: true });
		await writeFile(legacyState, '{"tracker":{"open":[["old",{}]]}}\n');

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, { AO_DEPLOY_ATTENTION_LEGACY_STATE: legacyState });

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		const systemctlLog = await readFile(fixture.systemctlLog, "utf8");
		assert.match(systemctlLog, /^--user disable --now ao-attention-notifier\.service$/m);
		await assert.rejects(access(legacyState));
		assert.match(result.stdout, /Removed retired outbound attention state/);
	});

	it("rolls back the whole release pointer to matching backend, web, and ops artifacts", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const first = (await git(fixture.dir, ["rev-parse", "HEAD"])).stdout.trim();
		let web = await startFakeWeb();
		let result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

		await writeFile(path.join(fixture.dir, "frontend", "app.js"), "console.log('second frontend');\n");
		await writeFile(path.join(fixture.dir, "ops", "ao-slack-notifier.mjs"), "console.log('second ops');\n");
		await commitFixture(fixture.dir, "second release");
		const second = (await git(fixture.dir, ["rev-parse", "HEAD"])).stdout.trim();
		web = await startFakeWeb();
		result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		assert.equal((await readFile(path.join(fixture.stateDir, "current", "REVISION"), "utf8")).trim(), second);

		await writeFile(fixture.systemctlLog, "");
		web = await startFakeWeb();
		web.setVersionRevision(first);
		result = await runDeployLive(fixture, web, {}, { args: ["--rollback"], daemonRevision: first });

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		assert.equal((await readFile(path.join(fixture.stateDir, "current", "REVISION"), "utf8")).trim(), first);
		assert.equal((await readFile(fixture.stateFile, "utf8")).trim(), first);
		const unit = await readFile(path.join(fixture.home, ".config", "systemd", "user", "ao-web.service"), "utf8");
		assert.match(unit, new RegExp(`${escapeRegExp(fixture.stateDir)}/current/source/frontend/dist`));
		const systemctlLog = await readFile(fixture.systemctlLog, "utf8");
		assert.match(systemctlLog, /^--user restart ao\.service$/m);
		assert.match(systemctlLog, /^--user restart ao-web\.service$/m);
		assert.match(systemctlLog, /^--user restart ao-slack-notifier\.service$/m);
		assert.match(systemctlLog, /^--user restart ao-attention-reply\.service$/m);

		web = await startFakeWeb();
		web.setVersionRevision(first);
		result = await runDeployLive(fixture, web, {}, { args: ["--rollback"], daemonRevision: first });
		assert.notEqual(result.code, 0, `second rollback should refuse a no-op\n${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /Already on rollback target/);
		assert.equal((await readFile(path.join(fixture.stateDir, "current", "REVISION"), "utf8")).trim(), first);
	});

	it("refuses release rollback before pointer flip when Slack config is invalid", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		let web = await startFakeWeb();
		let result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

		await writeFile(path.join(fixture.dir, "README.md"), "second\n");
		await commitFixture(fixture.dir, "second release");
		const second = (await git(fixture.dir, ["rev-parse", "HEAD"])).stdout.trim();
		web = await startFakeWeb();
		result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		await writeFile(fixture.slackEnvFile, "SLACK_MEMBER_ID=U1\nSLACK_SIGNING_SECRET=sec\n");
		await writeFile(fixture.systemctlLog, "");

		web = await startFakeWeb();
		result = await runDeployLive(fixture, web, {}, { args: ["--rollback"] });

		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /has no usable sink/);
		assert.equal((await readFile(path.join(fixture.stateDir, "current", "REVISION"), "utf8")).trim(), second);
		const systemctlLog = await readFile(fixture.systemctlLog, "utf8").catch(() => "");
		assert.equal(systemctlLog, "", "Slack precondition failure must not restart rollback services");
	});

	it("rolls back even when the old daemon cannot list sessions before the pointer flip", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const first = (await git(fixture.dir, ["rev-parse", "HEAD"])).stdout.trim();
		let web = await startFakeWeb();
		let result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

		await writeFile(path.join(fixture.dir, "README.md"), "second\n");
		await commitFixture(fixture.dir, "second release");
		web = await startFakeWeb();
		result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

		web = await startFakeWeb();
		web.setVersionRevision(first);
		result = await runDeployLive(
			fixture,
			web,
			{ AO_STUB_SESSION_FAIL: "1" },
			{ args: ["--rollback"], daemonRevision: first },
		);

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(
			result.stdout,
			/Pre-rollback session count unavailable \(old daemon may be down\); skipping session re-adoption count comparison/,
		);
		assert.equal((await readFile(path.join(fixture.stateDir, "current", "REVISION"), "utf8")).trim(), first);
		assert.equal((await readFile(fixture.stateFile, "utf8")).trim(), first);
	});

	it("refuses to deploy when an old daemon is ready but sessions cannot be counted", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, { AO_STUB_SESSION_FAIL: "1" });

		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /could not capture pre-restart session count/);
		await assert.rejects(access(path.join(fixture.stateDir, "current")));
	});

	it("backs up and restores the pre-hermetic binary and units when no previous release exists", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const unitDir = path.join(fixture.home, ".config", "systemd", "user");
		await mkdir(unitDir, { recursive: true });
		await writeFile(path.join(unitDir, "ao.service"), "[Service]\nExecStart=%h/.local/bin/ao daemon\n");
		await writeFile(path.join(unitDir, "ao-web.service"), "[Service]\nExecStart=/old-web\n");

		let web = await startFakeWeb();
		let result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		await assert.doesNotReject(access(path.join(fixture.stateDir, "pre-hermetic", "ao")));
		await assert.doesNotReject(access(path.join(fixture.stateDir, "pre-hermetic", "systemd", "ao.service")));

		await writeFile(fixture.systemctlLog, "");
		web = await startFakeWeb();
		result = await runDeployLive(fixture, web, {}, { args: ["--rollback"] });

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		const aoBin = path.join(fixture.home, ".local", "bin", "ao");
		assert.equal((await lstat(aoBin)).isSymbolicLink(), false);
		assert.equal(await readFile(aoBin, "utf8"), "current ao\n");
		assert.match(await readFile(path.join(unitDir, "ao.service"), "utf8"), /%h\/\.local\/bin\/ao daemon/);
		assert.match(await readFile(path.join(unitDir, "ao-web.service"), "utf8"), /ExecStart=\/old-web/);
		await assert.rejects(access(path.join(unitDir, "ao-slack-notifier.service")));
		await assert.rejects(access(path.join(unitDir, "ao-attention-reply.service")));
		await assert.rejects(access(path.join(fixture.stateDir, "current")));
		await assert.rejects(access(fixture.stateFile));
		const systemctlLog = await readFile(fixture.systemctlLog, "utf8");
		assert.match(systemctlLog, /^--user restart ao\.service$/m);
		assert.match(systemctlLog, /^--user restart ao-web\.service$/m);
		assert.match(systemctlLog, /^--user disable --now ao-slack-notifier\.service$/m);
		assert.match(systemctlLog, /^--user disable --now ao-attention-reply\.service$/m);
	});

	it("strips prime activation when restoring the pre-hermetic backup", async () => {
		// rollback_pre_hermetic restores the host's ORIGINAL unit, which on the real host
		// is prime-baked. It is a different code path from the release rollback, so it
		// needs its own guard: reverting its chokepoint call must fail a test.
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const unitDir = path.join(fixture.home, ".config", "systemd", "user");
		await mkdir(unitDir, { recursive: true });
		await writeFile(
			path.join(unitDir, "ao.service"),
			"[Service]\nExecStart=%h/.local/bin/ao daemon\nEnvironment=AO_PRIME_PROJECT_ID=agent-orchestrator\n" +
				'Environment="AO_PRIME_DISPLAY_NAME=AO Prime"\n',
		);

		let web = await startFakeWeb();
		let result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		const backup = await readFile(path.join(fixture.stateDir, "pre-hermetic", "systemd", "ao.service"), "utf8");
		assert.match(backup, PRIME_ACTIVATION_LINE, "the backup is a verbatim snapshot and still carries prime");

		web = await startFakeWeb();
		result = await runDeployLive(fixture, web, {}, { args: ["--rollback"] });

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		const restored = await readFile(path.join(unitDir, "ao.service"), "utf8");
		assert.doesNotMatch(
			asLogicalLines(restored),
			PRIME_ACTIVATION_LINE,
			"restoring the pre-hermetic backup must not reinstate prime activation",
		);
		assert.match(restored, /%h\/\.local\/bin\/ao daemon/, "the restored unit must still be the pre-hermetic daemon");
	});

	it("refuses pre-hermetic rollback when no ao.service was backed up", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		let web = await startFakeWeb();
		let result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		const deployed = (await readFile(path.join(fixture.stateDir, "current", "REVISION"), "utf8")).trim();

		await writeFile(fixture.systemctlLog, "");
		web = await startFakeWeb();
		result = await runDeployLive(fixture, web, {}, { args: ["--rollback"] });

		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /no backed-up ao\.service/);
		assert.equal((await readFile(path.join(fixture.stateDir, "current", "REVISION"), "utf8")).trim(), deployed);
		assert.equal(
			await readFile(path.join(fixture.stateDir, "agent-orchestrator.last-deployed"), "utf8"),
			`${deployed}\n`,
		);
		const systemctlLog = await readFile(fixture.systemctlLog, "utf8").catch(() => "");
		assert.equal(systemctlLog, "", "failed rollback must not restart or disable services");
	});

	it("rebuilds web when previous bundle provenance does not match the requested frontend tree", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		let web = await startFakeWeb();
		let result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

		await writeFile(path.join(fixture.stateDir, "current", "FRONTEND_TREE"), "not-the-current-tree\n");
		await writeFile(path.join(fixture.dir, "README.md"), "docs only\n");
		await commitFixture(fixture.dir, "docs only");
		web = await startFakeWeb();
		result = await runDeployLive(fixture, web);

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(
			result.stdout,
			/Previous web bundle provenance does not match this release; rebuilding from staged source/,
		);
		const npmLog = await readFile(fixture.npmLog, "utf8");
		assert.match(npmLog, /^ci --cache .*\/deploy-state\/npm-cache --prefer-offline$/m);
		assert.match(npmLog, /^run build:web$/m);
	});

	it("reuses the previous web bundle when frontend provenance matches", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		let web = await startFakeWeb();
		let result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

		await writeFile(fixture.npmLog, "");
		await writeFile(path.join(fixture.dir, "README.md"), "docs only\n");
		await commitFixture(fixture.dir, "docs only");
		web = await startFakeWeb();
		result = await runDeployLive(fixture, web);

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		const npmLog = await readFile(fixture.npmLog, "utf8");
		assert.doesNotMatch(npmLog, /^ci /m);
		assert.doesNotMatch(npmLog, /^run build:web$/m);
		await assert.doesNotReject(
			access(path.join(fixture.stateDir, "current", "source", "frontend", "dist", "index.html")),
		);
	});

	it("allows a first deploy before the stable ao symlink exists", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		await rm(path.join(fixture.home, ".local", "bin", "ao"));

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		await assert.doesNotReject(access(path.join(fixture.home, ".local", "bin", "ao")));
	});

	it("continues from local refs when origin fetch fails", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		await git(fixture.dir, ["remote", "add", "origin", path.join(fixture.home, "missing-origin.git")]);

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stderr, /WARNING: origin fetch failed; deploying from local refs/);
	});

	it("fails when a requested remote-tracking deploy ref cannot be refreshed", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const head = (await git(fixture.dir, ["rev-parse", "HEAD"])).stdout.trim();
		await git(fixture.dir, ["update-ref", "refs/remotes/origin/main", head]);
		await git(fixture.dir, ["remote", "add", "origin", path.join(fixture.home, "missing-origin.git")]);

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, { AO_DEPLOY_HEAD: "origin/main" });

		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /requested remote-tracking ref may be stale/);
	});

	it("prunes old inactive releases while retaining current and previous", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		for (let i = 0; i < 3; i += 1) {
			if (i > 0) {
				await writeFile(path.join(fixture.dir, "README.md"), `release ${i}\n`);
				await commitFixture(fixture.dir, `release ${i}`);
			}
			const web = await startFakeWeb();
			const result = await runDeployLive(fixture, web, { AO_DEPLOY_RELEASE_RETENTION: "0" });
			assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		}

		const releaseDirs = await listReleaseDirs(fixture.stateDir);
		assert.equal(releaseDirs.length, 2, `expected current + previous releases only, got ${releaseDirs.join(", ")}`);
		const current = await readlinkReal(path.join(fixture.stateDir, "current"));
		const previous = await readlinkReal(path.join(fixture.stateDir, "previous"));
		assert.deepEqual(new Set(releaseDirs), new Set([current, previous]));
	});

	it("ships an ao.service unit that does not signal agent tmux sessions on restart", async () => {
		const unit = await readFile(path.join(repoRoot, "ops", "ao.service"), "utf8");

		assert.match(unit, /^ExecStart=%h\/\.ao\/deploy\/current\/bin\/ao daemon$/m);
		assert.match(unit, /^Restart=always$/m);
		assert.match(unit, /^StartLimitIntervalSec=60s$/m);
		assert.match(unit, /^StartLimitBurst=5$/m);
		assert.match(unit, /^Delegate=yes$/m);
		assert.match(unit, /^KillMode=process$/m);
		assert.match(unit, /^TimeoutStopSec=60s$/m);
	});

	it("ships unit templates that never bake prime activation into the service environment", async () => {
		// Prime activation must stay an operator-only runtime toggle. A committed
		// template that sets AO_PRIME_* is re-installed by every deploy, so the
		// daemon silently boots prime-on with nobody having asked for it.
		// Globbed, not a fixed list: a newly added unit or drop-in must be covered
		// the day it lands, without anyone remembering to extend this test.
		const opsDir = path.join(repoRoot, "ops");
		const entries = await readdir(opsDir, { withFileTypes: true });
		const templates = [];
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith(".service")) {
				templates.push(path.join(opsDir, entry.name));
				continue;
			}
			// Drop-in dirs (`<unit>.service.d/*.conf`) can set Environment= too.
			if (entry.isDirectory() && entry.name.endsWith(".service.d")) {
				for (const dropIn of await readdir(path.join(opsDir, entry.name))) {
					if (dropIn.endsWith(".conf")) {
						templates.push(path.join(opsDir, entry.name, dropIn));
					}
				}
			}
		}

		assert.ok(templates.length >= 4, `expected to find the shipped unit templates, got ${templates.length}`);
		for (const template of templates) {
			const body = await readFile(template, "utf8");
			assert.doesNotMatch(
				asLogicalLines(body),
				PRIME_ACTIVATION_LINE,
				`${path.relative(repoRoot, template)} must not set AO_PRIME_*; deploy would re-inject it on every release`,
			);
		}
	});

	// --- H4 (#293): the web surface's real inputs are frontend/ AND the ops-side
	// server source + unit definition. Keying restart/classification only on
	// `frontend/` let an ops-only web change deploy "successfully" while the old
	// process kept serving, and unit DROP-INS were never installed at all.
	it("treats an ops-only web-server source change as a web input and restarts ao-web.service", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		// Production executes ops/ao-web-server.mjs — nothing under frontend/.
		await writeFile(path.join(fixture.dir, "ops", "ao-web-server.mjs"), "console.log('web server changed');\n");
		await commitFixture(fixture.dir, "web-server-only change");

		const result = await runDeployDryRun(fixture.dir, fixture.home, { AO_DEPLOY_BASE: base.stdout.trim() });

		assert.equal(result.code, 0, result.stderr);
		assert.match(
			result.stdout,
			/web inputs changed \(ops\/ao-web-server\.mjs\); restarting ao-web\.service/,
			"an ops/ao-web-server.mjs change must be classified as a web input, not 'frontend/ unchanged'",
		);
		assert.doesNotMatch(
			result.stdout,
			/frontend\/ unchanged; leaving ao-web\.service running/,
			"the stale-process path must not be reachable for a web-server source change",
		);
		assert.match(result.stdout, /DRY-RUN: systemctl --user restart ao-web\.service/);
	});

	it("installs tracked unit drop-ins, so a web-unit drop-in change reaches the host", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		await writeFile(
			path.join(fixture.dir, "ops", "ao-web.service.d", "override.conf"),
			"[Service]\nEnvironment=AO_WEB_PUBLIC_URL=https://changed.example/\n",
		);
		await commitFixture(fixture.dir, "web drop-in change");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		const installed = await readFile(
			path.join(fixture.home, ".config", "systemd", "user", "ao-web.service.d", "override.conf"),
			"utf8",
		);
		assert.match(
			installed,
			/AO_WEB_PUBLIC_URL=https:\/\/changed\.example\//,
			"the tracked drop-in must be installed; otherwise the host silently keeps a hand-placed one forever",
		);
	});

	it("installs a changed ao-web.service before the web unit is restarted", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		await writeFile(
			path.join(fixture.dir, "ops", "ao-web.service"),
			"[Service]\nExecStart=/usr/bin/node /new-web-server.mjs\n\n[Install]\nWantedBy=default.target\n",
		);
		await commitFixture(fixture.dir, "web unit change");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		const unit = await readFile(path.join(fixture.home, ".config", "systemd", "user", "ao-web.service"), "utf8");
		assert.match(unit, /ExecStart=\/usr\/bin\/node \/new-web-server\.mjs/, "the new web unit must be installed");

		const log = await readFile(fixture.systemctlLog, "utf8");
		const reloaded = log.indexOf("--user daemon-reload");
		const restarted = log.indexOf("--user restart ao-web.service");
		assert.notEqual(restarted, -1, "ao-web.service must be restarted");
		assert(reloaded !== -1 && reloaded < restarted, "the unit must be installed + reloaded BEFORE the web restart");
	});

	// --- D1 (#293, from #296): the agent fleet must not live in ao.service's
	// cgroup. tmux daemonizes its SERVER from whichever client first touches the
	// socket, so a server spawned lazily by the daemon inherits ao.service's
	// cgroup — and with it every pane, agent, and `npm test` child. A daemon
	// restart (i.e. EVERY deploy) could then signal the whole fleet. Owning the
	// server in its own unit is what makes the escape structural.
	it("ships an ao-tmux.service that owns the tmux server in its own cgroup", async () => {
		const unit = await readFile(path.join(repoRoot, "ops", "ao-tmux.service"), "utf8");

		assert.match(unit, /^Type=forking$/m, "tmux daemonizes the server; systemd must adopt it as the main PID");
		assert.match(
			unit,
			/^ExecStart=\/usr\/bin\/tmux start-server ";" set-option -g exit-empty off$/m,
			"exit-empty MUST be pinned off: a server that exits when its last session closes hands the next lazily-spawned server straight back into ao.service's cgroup",
		);
		assert.match(unit, /^Before=ao\.service$/m, "the daemon must never be the first client to touch the socket");
		assert.match(
			unit,
			/^KillMode=process$/m,
			"the fleet lives in this cgroup; a cgroup-wide kill here is a fleet kill",
		);
		assert.match(unit, /^Delegate=yes$/m);
	});

	it("ships an ao.service that orders itself after the tmux server unit", async () => {
		const unit = await readFile(path.join(repoRoot, "ops", "ao.service"), "utf8");

		assert.match(
			unit,
			/^After=.*\bao-tmux\.service\b/m,
			"the daemon must start after the tmux server it will attach to",
		);
		assert.match(unit, /^Wants=.*\bao-tmux\.service\b/m, "the daemon must pull the tmux server unit in");
	});

	it("installs and enables ao-tmux.service, but never restarts it (a restart kills the fleet)", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

		const installed = await readFile(path.join(fixture.home, ".config", "systemd", "user", "ao-tmux.service"), "utf8");
		assert.match(installed, /ExecStart=\/usr\/bin\/tmux start-server/, "ao-tmux.service must be installed on the host");

		const log = await readFile(fixture.systemctlLog, "utf8");
		assert.match(
			log,
			/^--user enable .*\bao-tmux\.service\b/m,
			"ao-tmux.service must be enabled so it owns the socket at boot",
		);
		assert.doesNotMatch(
			log,
			/^--user restart ao-tmux\.service$/m,
			"restarting ao-tmux.service runs ExecStop=kill-server — it would kill every in-flight agent session",
		);
	});

	it("warns instead of failing when a legacy tmux server still sits in the ao.service cgroup", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		const web = await startFakeWeb();
		// A pre-existing server owns the socket (the live-host migration state).
		// deploy must NOT start ao-tmux.service into a `activating` hang, and must
		// NOT fail — it reports that the escape lands at the next reboot.
		const result = await runDeployLive(fixture, web, { AO_TEST_TMUX_SERVER_RUNNING: "1" });

		assert.equal(result.code, 0, `a legacy tmux server must not fail the deploy\n${result.stderr}`);
		assert.match(
			result.stdout,
			/tmux server is already running; not starting ao-tmux\.service over it/,
			"deploy must never restart a live tmux server out from under the fleet",
		);
		const log = await readFile(fixture.systemctlLog, "utf8");
		assert.doesNotMatch(
			log,
			/^--user start .*ao-tmux\.service$/m,
			"starting it would hang: the socket is already owned",
		);
	});

	// --- D2 (#293, from #295): the sudo PAM warnings under ao.service.
	//
	// Forensics (journalctl _COMM=sudo, 14 days, this host): ao's own code contains
	// no sudo at all. The emitters are AGENT processes that were mis-parented into
	// ao.service's cgroup by the D1 bug:
	//   * 722x `sudo -n true` — a NON-interactive capability probe run by the agent
	//     harnesses. `-n` refuses to prompt, which is exactly why pam_unix logs
	//     "conversation failed". It cannot hang. It is noise, and it is expected.
	//   * a handful of genuinely INTERACTIVE ones — Playwright browser-dep installs
	//     (`sudo -- sh -c "apt-get update && apt-get install ... xvfb ..."`,
	//     `reinstall_chrome_stable_linux.sh`). THOSE are the latent hang, and after
	//     D1 they can no longer be attributed to (or block) the daemon service.
	it("classifies non-interactive sudo probes as expected and never fails the deploy", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, {
			AO_TEST_JOURNAL_SUDO: [
				journalEntry("sudo -n true", "pam_unix(sudo:auth): conversation failed"),
				journalEntry("sudo -n true", "pam_unix(sudo:auth): auth could not identify password for [orchestrator]"),
				journalEntry("sudo -n true", "pam_unix(sudo:auth): conversation failed"),
			].join("\n"),
		});

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(
			result.stdout,
			/3 non-interactive sudo probe warning\(s\).*cannot prompt and cannot hang/s,
			"a `sudo -n` probe is non-interactive by construction; report it as a documented, bounded count",
		);
		assert.doesNotMatch(
			result.stdout,
			/WARN:.*interactive sudo/i,
			"probes alone must not raise an interactive warning",
		);
	});

	it("names the interactive sudo emitter instead of whitelisting the PAM message away", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, {
			AO_TEST_JOURNAL_SUDO: [
				journalEntry("sudo -n true", "pam_unix(sudo:auth): conversation failed"),
				journalEntry(
					'sudo -- sh -c "apt-get update && apt-get install -y --no-install-recommends libasound2t64 xvfb"',
					"pam_unix(sudo:auth): conversation failed",
				),
			].join("\n"),
		});

		assert.equal(result.code, 0, "an agent-side interactive sudo must not break the deploy");
		// The whole point: the deploy must say WHAT ran sudo, not merely that a
		// known-looking PAM line appeared. A count-matching whitelist would have
		// reported this as "expected" and told the operator nothing.
		assert.match(result.stdout, /WARN:.*interactive sudo/i);
		assert.match(result.stdout, /apt-get install/, "the deploy must name the actual emitting command line");
		assert.match(result.stdout, /1 non-interactive sudo probe warning\(s\)/);
	});

	it("ships no sudo invocation of its own", async () => {
		// The premise of #295 was that "something is shelling out to an interactive
		// sudo". It is NOT ao: the repo's own deploy surface invokes sudo nowhere.
		// Lock that in, so a future ad-hoc `sudo` inside a non-interactive service
		// cannot reintroduce the latent hang. Comments (which discuss sudo at length)
		// and journal field selectors (`_COMM=sudo`) are not invocations, so match
		// only `sudo` in COMMAND position.
		const deployBody = await readFile(deployScript, "utf8");
		const invocations = deployBody
			.split("\n")
			.map((line) => line.replace(/#.*$/, ""))
			.filter((line) => /(^|[;&|(]\s*|\brun(?:_best_effort|_in)?\s+)sudo(\s|$)/.test(line));

		assert.deepEqual(invocations, [], "ops/deploy.sh must never shell out to sudo");
	});

	it("ships an ao.service that cannot be handed prime activation through an env file", async () => {
		// Activation is env-only, so an EnvironmentFile= on the daemon unit is an
		// injection vector whose contents this repo cannot see or guard.
		const unit = await readFile(path.join(repoRoot, "ops", "ao.service"), "utf8");

		assert.doesNotMatch(unit, /^[ \t]*EnvironmentFile=/m, "ops/ao.service must not read an external env file");
	});

	it("waits out the transient web 502 after ao-web.service restarts instead of failing the deploy", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "frontend", "app.js"), "console.log('frontend changed');\n");
		await writeFile(path.join(fixture.dir, "ops", "ao-slack-notifier.mjs"), "console.log('ops changed');\n");
		await commitFixture(fixture.dir, "deploy-relevant changes");

		// ao-web.service starts a prebuilt bundle from the active release, and
		// the node server takes a moment to bind, so the tailnet URL serves 502 briefly.
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

	// #262: a deploy that produces a binary with no VCS provenance, a dirty
	// stamp, or a revision that does not match what is running must fail loudly
	// rather than complete with an "unknown" revision.
	it("fails the deploy when the built binary carries no VCS revision stamp", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "ops", "ao-slack-notifier.mjs"), "console.log('ops changed');\n");
		await commitFixture(fixture.dir, "ops-only change");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_BASE: base.stdout.trim(),
			// An unstamped binary (built with -buildvcs=false or outside a
			// checkout): the go stub prints no vcs.revision line.
			AO_TEST_VCS_REVISION: "",
		});

		assert.notEqual(result.code, 0, "an unstamped binary must fail the deploy");
		assert.match(result.stderr, /no VCS revision stamp/);
		const systemctlLog = await readFile(fixture.systemctlLog, "utf8").catch(() => "");
		assert.doesNotMatch(
			systemctlLog,
			/^--user restart ao\.service$/m,
			"the ao.service restart must be gated behind the built-revision provenance check",
		);
		await assert.rejects(access(fixture.stateFile), "a failed deploy must not record the deployed ref");
	});

	it("fails the deploy when the built binary is stamped dirty", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "ops", "ao-slack-notifier.mjs"), "console.log('ops changed');\n");
		await commitFixture(fixture.dir, "ops-only change");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_BASE: base.stdout.trim(),
			AO_TEST_VCS_MODIFIED: "true",
		});

		assert.notEqual(result.code, 0, "a dirty binary must fail the deploy");
		assert.match(result.stderr, /stamped dirty \(vcs\.modified=true\)/);
		const systemctlLog = await readFile(fixture.systemctlLog, "utf8").catch(() => "");
		assert.doesNotMatch(
			systemctlLog,
			/^--user restart ao\.service$/m,
			"a dirty build must be refused before the ao.service restart",
		);
		await assert.rejects(access(fixture.stateFile), "a failed deploy must not record the deployed ref");
		await assert.rejects(
			access(path.join(fixture.stateDir, "current")),
			"a pre-activation rejection must leave the current release pointer untouched",
		);
	});

	it("fails the deploy when the built binary's clean flag is unreadable (vcs.modified absent)", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "ops", "ao-slack-notifier.mjs"), "console.log('ops changed');\n");
		await commitFixture(fixture.dir, "ops-only change");

		const web = await startFakeWeb();
		// vcs.revision is present but vcs.modified is omitted: the deploy cannot
		// prove the binary is clean, so it must refuse rather than assume clean.
		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_BASE: base.stdout.trim(),
			AO_TEST_VCS_MODIFIED_OMIT: "1",
		});

		assert.notEqual(result.code, 0, "an unreadable clean flag must fail the deploy");
		assert.match(result.stderr, /could not confirm built ao binary is clean/);
		const systemctlLog = await readFile(fixture.systemctlLog, "utf8").catch(() => "");
		assert.doesNotMatch(systemctlLog, /^--user restart ao\.service$/m);
		await assert.rejects(access(fixture.stateFile), "a failed deploy must not record the deployed ref");
	});

	it("fails the deploy when go cannot read the built binary's provenance", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "ops", "ao-slack-notifier.mjs"), "console.log('ops changed');\n");
		await commitFixture(fixture.dir, "ops-only change");

		const web = await startFakeWeb();
		// `go version -m` exits non-zero: no revision can be read, so the gate
		// must treat it as unstamped and refuse.
		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_BASE: base.stdout.trim(),
			AO_TEST_GO_VERSION_FAIL: "1",
		});

		assert.notEqual(result.code, 0, "an unreadable binary must fail the deploy");
		assert.match(result.stderr, /no VCS revision stamp/);
		const systemctlLog = await readFile(fixture.systemctlLog, "utf8").catch(() => "");
		assert.doesNotMatch(systemctlLog, /^--user restart ao\.service$/m);
		await assert.rejects(access(fixture.stateFile), "a failed deploy must not record the deployed ref");
	});

	it("fails the deploy when the built binary revision does not match the deploy source ref", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "ops", "ao-slack-notifier.mjs"), "console.log('ops changed');\n");
		await commitFixture(fixture.dir, "ops-only change");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_BASE: base.stdout.trim(),
			AO_TEST_VCS_REVISION: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		});

		assert.notEqual(result.code, 0, "a revision that differs from the shipped ref must fail the deploy");
		assert.match(result.stderr, /does not match the deploy source ref/);
		const systemctlLog = await readFile(fixture.systemctlLog, "utf8").catch(() => "");
		assert.doesNotMatch(systemctlLog, /^--user restart ao\.service$/m);
		await assert.rejects(access(fixture.stateFile), "a failed deploy must not record the deployed ref");
	});

	it("fails the deploy when the running daemon reports no revision after restart", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "ops", "ao-slack-notifier.mjs"), "console.log('ops changed');\n");
		await commitFixture(fixture.dir, "ops-only change");

		const web = await startFakeWeb();
		// The binary is stamped correctly, but the restarted daemon reports an
		// empty revision (e.g. it did not pick up the new binary): unverifiable
		// provenance must fail, not be skipped with a warning.
		const result = await runDeployLive(fixture, web, { AO_DEPLOY_BASE: base.stdout.trim() }, { daemonRevision: "" });

		assert.notEqual(result.code, 0, "an empty daemon revision must fail the deploy");
		assert.match(result.stderr, /running daemon did not report a revision/);
		await assert.rejects(access(fixture.stateFile), "a failed deploy must not record the deployed ref");
	});

	it("fails the deploy when the running daemon revision does not match the built binary", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "ops", "ao-slack-notifier.mjs"), "console.log('ops changed');\n");
		await commitFixture(fixture.dir, "ops-only change");

		const web = await startFakeWeb();
		const result = await runDeployLive(
			fixture,
			web,
			{ AO_DEPLOY_BASE: base.stdout.trim() },
			{ daemonRevision: "0000000000000000000000000000000000000000" },
		);

		assert.notEqual(result.code, 0, "a stale running daemon must fail the deploy");
		assert.match(result.stderr, /Revision mismatch: built .* but running daemon reports/);
		await assert.rejects(access(fixture.stateFile), "a failed deploy must not record the deployed ref");
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

	it("ignores a scheduled release-guard failure that pollutes main's combined status", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const base = await git(fixture.dir, ["rev-parse", "HEAD"]);

		await writeFile(path.join(fixture.dir, "ops", "ao-slack-notifier.mjs"), "console.log('ops changed');\n");
		await commitFixture(fixture.dir, "ops-only change");

		// Real merge CI (push/merge_group) is green; only the hourly
		// release-latest-guard (event=schedule) failed, and its latest-release
		// job attached a failure check-run to this commit via check_suite 999.
		await writeFile(
			fixture.ghStatusFile,
			JSON.stringify({
				check_runs: [
					{ name: "build-test", status: "completed", conclusion: "success", check_suite: { id: 111 } },
					{ name: "test", status: "completed", conclusion: "success", check_suite: { id: 111 } },
					{ name: "latest-release", status: "completed", conclusion: "failure", check_suite: { id: 999 } },
				],
			}),
		);
		await writeFile(
			fixture.ghRunsFile,
			JSON.stringify({
				total_count: 2,
				workflow_runs: [
					{ name: "CI", event: "push", conclusion: "success", check_suite_id: 111 },
					{ name: "Release latest guard", event: "schedule", conclusion: "failure", check_suite_id: 999 },
				],
			}),
		);

		const web = await startFakeWeb({ webFailuresBeforeReady: 1 });
		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_BASE: base.stdout.trim(),
			AO_DEPLOY_GITHUB_REPO: "polymath-ventures/agent-orchestrator",
		});

		assert.equal(
			result.code,
			0,
			`a scheduled release-guard failure must not block the deploy\n${result.stdout}\n${result.stderr}`,
		);
		assert.doesNotMatch(
			result.stderr,
			/main CI is/,
			"the scheduled guard failure must not surface as a CI-red refusal",
		);
		await assert.doesNotReject(access(fixture.stateFile), "the deploy should complete and record the deployed ref");
	});

	it("still refuses when a non-scheduled merge check fails alongside a scheduled guard failure", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		// The release guard (schedule) is excluded, but a genuine push-event CI
		// failure must still block: exclusion must not mask real red.
		await writeFile(
			fixture.ghStatusFile,
			JSON.stringify({
				check_runs: [
					{ name: "build-test", status: "completed", conclusion: "failure", check_suite: { id: 111 } },
					{ name: "latest-release", status: "completed", conclusion: "failure", check_suite: { id: 999 } },
				],
			}),
		);
		await writeFile(
			fixture.ghRunsFile,
			JSON.stringify({
				total_count: 2,
				workflow_runs: [
					{ name: "CI", event: "push", conclusion: "failure", check_suite_id: 111 },
					{ name: "Release latest guard", event: "schedule", conclusion: "failure", check_suite_id: 999 },
				],
			}),
		);

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_GITHUB_REPO: "polymath-ventures/agent-orchestrator",
		});

		assert.notEqual(result.code, 0, "a real push-event CI failure must still block the deploy");
		assert.match(result.stderr, /main CI is failure: build-test/);
		assert.doesNotMatch(
			result.stderr,
			/latest-release/,
			"the excluded scheduled guard must not appear in the failure list",
		);
	});

	it("fails closed when excluding scheduled guards leaves zero check runs to judge", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		// Every check run belongs to an excluded scheduled/release suite: after
		// exclusion there is no real CI evidence, so the gate must NOT green — a
		// genuinely unproven main must fail closed, not slip through as success.
		await writeFile(
			fixture.ghStatusFile,
			JSON.stringify({
				check_runs: [{ name: "latest-release", status: "completed", conclusion: "failure", check_suite: { id: 999 } }],
			}),
		);
		await writeFile(
			fixture.ghRunsFile,
			JSON.stringify({
				total_count: 1,
				workflow_runs: [
					{ name: "Release latest guard", event: "schedule", conclusion: "failure", check_suite_id: 999 },
				],
			}),
		);

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_GITHUB_REPO: "polymath-ventures/agent-orchestrator",
		});

		assert.notEqual(result.code, 0, "no real CI after exclusion must fail closed, not green");
		assert.match(result.stderr, /main CI is not green \(unknown: no check runs\)/);
	});

	it("does not exclude a scheduled guard when the workflow-runs listing is truncated", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		// total_count exceeds the returned page, so the exclusion set can't be
		// trusted — the guard we need to drop might be on an unfetched page. Fall
		// back to counting every check run (fail closed), keeping the guard's red.
		await writeFile(
			fixture.ghStatusFile,
			JSON.stringify({
				check_runs: [
					{ name: "build-test", status: "completed", conclusion: "success", check_suite: { id: 111 } },
					{ name: "latest-release", status: "completed", conclusion: "failure", check_suite: { id: 999 } },
				],
			}),
		);
		await writeFile(
			fixture.ghRunsFile,
			JSON.stringify({
				total_count: 200,
				workflow_runs: [
					{ name: "Release latest guard", event: "schedule", conclusion: "failure", check_suite_id: 999 },
				],
			}),
		);

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_GITHUB_REPO: "polymath-ventures/agent-orchestrator",
		});

		assert.notEqual(result.code, 0, "a truncated workflow-runs listing must not enable exclusion");
		assert.match(result.stderr, /main CI is failure: latest-release/);
	});

	it("keeps a check suite that also has a non-scheduled event, even if a scheduled run shares its suite id", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		// Suite 111 is referenced by both a push run and a scheduled run. A real
		// push-event failure lives in that suite, so it must NOT be excluded just
		// because a scheduled run happens to report the same check_suite_id.
		await writeFile(
			fixture.ghStatusFile,
			JSON.stringify({
				check_runs: [{ name: "build-test", status: "completed", conclusion: "failure", check_suite: { id: 111 } }],
			}),
		);
		await writeFile(
			fixture.ghRunsFile,
			JSON.stringify({
				total_count: 2,
				workflow_runs: [
					{ name: "CI", event: "push", conclusion: "failure", check_suite_id: 111 },
					{ name: "Release latest guard", event: "schedule", conclusion: "failure", check_suite_id: 111 },
				],
			}),
		);

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_GITHUB_REPO: "polymath-ventures/agent-orchestrator",
		});

		assert.notEqual(result.code, 0, "a suite shared with a non-scheduled event must not be excluded");
		assert.match(result.stderr, /main CI is failure: build-test/);
	});

	it("does not exclude scheduled guards when the workflow-runs metadata is empty", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		// Empty metadata (the `{}` fallback shape): no runs to classify suites, so
		// nothing can be proven scheduled/release and the guard's red still blocks.
		await writeFile(
			fixture.ghStatusFile,
			JSON.stringify({
				check_runs: [{ name: "latest-release", status: "completed", conclusion: "failure", check_suite: { id: 999 } }],
			}),
		);
		await writeFile(fixture.ghRunsFile, "{}");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_GITHUB_REPO: "polymath-ventures/agent-orchestrator",
		});

		assert.notEqual(result.code, 0, "empty workflow-runs metadata must not enable exclusion");
		assert.match(result.stderr, /main CI is failure: latest-release/);
	});

	it("does not exclude scheduled guards when the workflow-runs metadata is malformed JSON", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		// Malformed JSON: node's JSON.parse throws, the catch leaves the exclusion
		// set empty, and every check run is counted (fail closed).
		await writeFile(
			fixture.ghStatusFile,
			JSON.stringify({
				check_runs: [{ name: "latest-release", status: "completed", conclusion: "failure", check_suite: { id: 999 } }],
			}),
		);
		await writeFile(fixture.ghRunsFile, "{ this is not json ");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_GITHUB_REPO: "polymath-ventures/agent-orchestrator",
		});

		assert.notEqual(result.code, 0, "malformed workflow-runs metadata must not enable exclusion");
		assert.match(result.stderr, /main CI is failure: latest-release/);
	});

	it("warns and fails closed when the workflow-runs fetch itself fails", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		// gh api for /actions/runs exits non-zero (auth/rate-limit/network). The
		// gate must warn WHY exclusion was skipped and still block on the guard.
		await writeFile(
			fixture.ghStatusFile,
			JSON.stringify({
				check_runs: [{ name: "latest-release", status: "completed", conclusion: "failure", check_suite: { id: 999 } }],
			}),
		);

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, {
			AO_DEPLOY_GITHUB_REPO: "polymath-ventures/agent-orchestrator",
			GH_RUNS_FAIL: "1",
		});

		assert.notEqual(result.code, 0, "a failed workflow-runs fetch must not enable exclusion");
		assert.match(result.stderr, /could not fetch workflow runs for .*; scheduled\/release guards will NOT be excluded/);
		assert.match(result.stderr, /main CI is failure: latest-release/);
	});

	// --- 1a (#293, codex review of #309): NOTHING deploy runs may stop, restart,
	// or `disable --now` ao-tmux.service. Its ExecStop is `tmux kill-server`: the
	// tmux server, every pane, every agent process, the whole fleet. The guard is
	// a chokepoint in run()/run_best_effort so a future edit that adds such a call
	// fails the DEPLOY instead of the fleet.
	it("refuses, at the run() chokepoint, any systemctl verb that could stop the tmux server", async () => {
		const fatal = [
			"systemctl --user restart ao-tmux.service",
			"systemctl --user stop ao-tmux.service",
			"systemctl --user disable --now ao-tmux.service",
			"systemctl --user kill ao-tmux.service",
			"systemctl --user try-restart ao-tmux.service",
		];

		for (const command of fatal) {
			for (const wrapper of ["run", "run_best_effort"]) {
				const result = await sourceDeploy(`${wrapper} ${command}`);
				assert.notEqual(result.code, 0, `${wrapper} ${command} must abort, not run\n${result.stdout}${result.stderr}`);
				assert.match(
					result.stderr,
					/would stop the tmux server/,
					`${wrapper} ${command} must be refused loudly\n${result.stderr}`,
				);
				assert.doesNotMatch(
					result.stdout,
					/DRY-RUN/,
					"a fleet-fatal command must be refused before it is even printed",
				);
			}
		}

		// The verbs deploy legitimately needs on that unit stay allowed.
		for (const command of [
			"systemctl --user enable ao-tmux.service",
			"systemctl --user disable ao-tmux.service",
			"systemctl --user start --no-block ao-tmux.service",
			"systemctl --user restart ao.service",
			"systemctl --user restart ao-web.service",
		]) {
			const result = await sourceDeploy(`run ${command}`);
			assert.equal(result.code, 0, `${command} must remain allowed\n${result.stderr}`);
		}
	});

	it("never stops or disables the tmux unit when rolling back to a pre-hermetic host that predates it", async () => {
		// The real migration host: a pre-hermetic install whose backup CANNOT contain
		// ao-tmux.service (the unit did not exist yet). The old code hit the generic
		// "not in the backup -> disable --now + remove" branch, which runs
		// ExecStop=`tmux kill-server` and takes the fleet down with it.
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const unitDir = path.join(fixture.home, ".config", "systemd", "user");
		await mkdir(unitDir, { recursive: true });
		await writeFile(path.join(unitDir, "ao.service"), "[Service]\nExecStart=%h/.local/bin/ao daemon\n");
		await writeFile(path.join(unitDir, "ao-web.service"), "[Service]\nExecStart=/old-web\n");

		let web = await startFakeWeb();
		let result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		await assert.rejects(
			access(path.join(fixture.stateDir, "pre-hermetic", "systemd", "ao-tmux.service")),
			"the pre-hermetic backup cannot contain a unit that did not exist yet",
		);

		await writeFile(fixture.systemctlLog, "");
		web = await startFakeWeb();
		result = await runDeployLive(fixture, web, { AO_TEST_TMUX_SERVER_RUNNING: "1" }, { args: ["--rollback"] });

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		const systemctlLog = await readFile(fixture.systemctlLog, "utf8");
		assert.doesNotMatch(
			systemctlLog,
			/^--user disable --now ao-tmux\.service$/m,
			"`disable --now` runs ExecStop=`tmux kill-server` — it would kill every agent pane in the fleet",
		);
		assert.doesNotMatch(systemctlLog, /^--user (stop|restart|kill|try-restart) ao-tmux\.service$/m);
		// And the unit survives the rollback: it is release-independent (it execs
		// /usr/bin/tmux), so tearing it out would only re-expose the fleet.
		await assert.doesNotReject(access(path.join(unitDir, "ao-tmux.service")));
	});

	// --- 1b (#293, codex review of #309): deploy skips STARTING ao-tmux.service
	// when a legacy server owns the socket — but ao.service `Wants=` it, so
	// restarting ao.service makes systemd pull the skipped unit into the same
	// transaction anyway. The unit itself must therefore be safe to start on that
	// host: ExecCondition must skip it cleanly (exit 1-254 => "skipped", not
	// "failed", no Restart=) rather than letting ExecStart attach to the foreign
	// server and hang the Type=forking unit in `activating`.
	it("ships an ao-tmux.service whose ExecCondition skips cleanly when a server already owns the socket", async () => {
		const unit = await readFile(path.join(repoRoot, "ops", "ao-tmux.service"), "utf8");
		const condition = execShellCommand(unit, "ExecCondition");
		assert.ok(condition, "ao-tmux.service must carry an ExecCondition guard");

		const fixture = await makeGitFixture();

		// systemd pulls the unit in via Wants= while a legacy/foreign server owns the
		// socket: the condition must SKIP (1-254), never run ExecStart.
		const skipped = await runShell(condition, fixture.stubBin, { AO_TEST_TMUX_SERVER_RUNNING: "1" });
		assert.ok(
			skipped.code >= 1 && skipped.code <= 254,
			`a foreign tmux server must skip the unit cleanly (exit 1-254), got ${skipped.code}`,
		);

		// Socket free: the condition passes and ExecStart creates the server here.
		const proceed = await runShell(condition, fixture.stubBin, {});
		assert.equal(proceed.code, 0, "with no server on the socket the unit must start and own it");
	});

	// --- 1b-drain (#293, codex review cycle 3 of #309): CLOSE the reacquisition
	// window instead of racing to fill it.
	//
	// The legacy server (the one running on this host right now, and on any host
	// mid-migration) carries tmux's DEFAULT `exit-empty on`: it exits the moment its
	// last session closes. When it does, the socket goes free — and the ao daemon,
	// which is already running and issuing tmux commands, can win the race to the
	// free socket and lazily spawn a replacement server inside ao.service's cgroup.
	// That is D1, silently recreated, with nobody watching. ao-tmux-claim.timer
	// bounds that window; it cannot eliminate it.
	//
	// So do not race the daemon: prevent the drain. Pinning `exit-empty off` on the
	// legacy server means it never exits when it empties, so the socket NEVER goes
	// free while the fleet is alive, so there is no window to race. The migration
	// then happens at the next reboot, where ao-tmux.service (Before=ao.service)
	// creates the server first and owns it from the start.
	//
	// `set-option` is the only tmux verb allowed here, and it is a pure server-option
	// write. Verified against tmux 3.5a on a scratch socket:
	//   * sessions, windows, panes and the server PID are untouched;
	//   * `exit-empty` lives in the SERVER option table and `-g` resolves into it;
	//   * with it off, killing the last session leaves the server alive (same PID)
	//     and a later `new-session` re-attaches to it instead of spawning a new one;
	//   * against a socket with NO server it exits 1 — unlike `new-session` /
	//     `start-server` it cannot itself create the server we are trying to avoid.
	it("pins exit-empty off on a legacy tmux server so it cannot drain and hand the socket to the daemon", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const web = await startFakeWeb();

		const result = await runDeployLive(fixture, web, { AO_TEST_TMUX_SERVER_RUNNING: "1" });
		assert.equal(result.code, 0, `a legacy tmux server must not fail the deploy\n${result.stderr}`);

		const tmuxLog = await readFile(fixture.tmuxLog, "utf8");
		assert.match(
			tmuxLog,
			/^set-option -g exit-empty off$/m,
			"deploy must pin the legacy server's exit-empty off: a server that cannot drain cannot hand the socket to ao.service",
		);

		// The other half of the contract, and the more important one: deploy touched
		// the fleet's server with NOTHING destructive. Any tmux verb that can end a
		// server, a session, a window or a pane is 49 dead agents.
		for (const line of tmuxLog.split("\n").filter(Boolean)) {
			assert.doesNotMatch(
				line,
				/^(kill-server|kill-session|kill-window|kill-pane|respawn-pane|respawn-window|send-keys|new-session|start-server|source-file|run-shell)\b/,
				`deploy issued a destructive tmux verb against the live fleet server: \`tmux ${line}\``,
			);
		}
	});

	// The pin is for a server we did NOT create. When the socket is free, deploy
	// starts ao-tmux.service, whose own ExecStart sets exit-empty off on the server
	// it creates — deploy must not also poke the socket itself. And when the probe
	// CANNOT be classified, deploy must not touch the socket at all: it does not
	// know what is on the other end.
	it("issues no tmux option write when the socket is free or the ownership probe failed", async () => {
		for (const state of ["free", "broken"]) {
			const fixture = await makeGitFixture();
			await commitFixture(fixture.dir, "initial");
			const web = await startFakeWeb();

			const result = await runDeployLive(fixture, web, { AO_TEST_TMUX_STATE: state });
			assert.equal(result.code, 0, `${state}: deploy must not fail\n${result.stderr}`);

			const tmuxLog = await readFile(fixture.tmuxLog, "utf8").catch(() => "");
			assert.doesNotMatch(
				tmuxLog,
				/^set-option\b/m,
				`${state}: deploy must only pin exit-empty on a server it has positively identified as already owning the socket`,
			);
		}
	});

	// --- 1a (#293, codex review cycle 4 of #309): A FAILED PIN MUST NOT REPORT
	// SUCCESS.
	//
	// The pin is the whole of cycle 3's fix, and the deploy log is the only place a
	// human ever learns whether it took. `run_best_effort` logs a warning on failure
	// and then returns 0 REGARDLESS — so a caller that branches on its status always
	// takes the success branch, and the failure branch is unreachable dead code. That
	// turned a failed `set-option` (a transient socket error, a read-only socket, an
	// option error) into a deploy that printed "Pinned exit-empty=off" while
	// exit-empty was still ON: the legacy server can still drain, the daemon can still
	// recreate the server inside ao.service's cgroup, and the deploy said it was fixed.
	// A fix that silently stops working is the exact failure mode #293 exists to
	// prevent, so the pin's status must be the REAL status of the `set-option`.
	//
	// The pin is advisory, not fatal — a failed pin leaves the host exactly where it
	// was before the deploy (unpinned, as it has been all along), so aborting removes
	// no risk while making an emergency ROLLBACK unrunnable on a transient tmux error.
	// It must therefore be loud, specific, and repeated at the end of the run, and it
	// must never print the success line.
	it("reports a FAILED exit-empty pin as a failure instead of claiming the race is closed", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const web = await startFakeWeb();

		const result = await runDeployLive(fixture, web, {
			AO_TEST_TMUX_SERVER_RUNNING: "1",
			AO_TEST_TMUX_SET_OPTION_FAIL: "1",
		});
		const output = `${result.stdout}\n${result.stderr}`;

		assert.doesNotMatch(
			output,
			/Pinned exit-empty=off/,
			"deploy claimed it pinned exit-empty off when the `set-option` actually FAILED: the legacy server can still drain into ao.service's cgroup",
		);
		assert.match(
			output,
			/could NOT be pinned/,
			"a failed pin must say so, in the failure's own words — it is the only signal a human gets",
		);
		assert.match(
			output,
			/cgroup check/i,
			"a failed pin must name the manual pre-deploy cgroup check that is still required (#293/D1)",
		);

		// Advisory, deliberately: the failure does not abort the deploy (the host is no
		// worse off than before it ran), but it must survive to the END of the run
		// rather than scrolling away behind twenty restart lines.
		assert.equal(result.code, 0, `a failed pin is advisory, not fatal\n${result.stderr}`);
		const tail = output.slice(output.indexOf("ao deploy complete."));
		assert.match(
			tail,
			/could NOT be pinned/,
			"the unresolved fleet-safety warning must be re-stated at the end of the deploy, not buried mid-run",
		);
	});

	// The class of bug, not just the instance. `run_best_effort` swallows failure BY
	// DESIGN (that is what "best effort" means here), so its exit status carries no
	// information — and any `if run_best_effort …` / `run_best_effort … ||` writes a
	// branch that can never be taken. Nothing in this script may branch on it.
	it("never branches on run_best_effort's exit status, which is always success", async () => {
		const swallowed = await sourceDeploy('run_best_effort false && echo ALWAYS_SUCCEEDS || echo "reported failure"');
		assert.match(
			swallowed.stdout,
			/ALWAYS_SUCCEEDS/,
			"run_best_effort is expected to swallow failure; if it ever propagates one, this guard can be relaxed",
		);

		const script = await readFile(deployScript, "utf8");
		for (const line of script.split("\n")) {
			if (!line.includes("run_best_effort")) continue;
			if (line.trimStart().startsWith("#")) continue;
			assert.doesNotMatch(
				line,
				/(\bif\b|\bwhile\b|\buntil\b|!|&&|\|\|)\s*.*run_best_effort|run_best_effort\b.*(&&|\|\|)/,
				`branching on run_best_effort's status is dead code — it always returns 0: ${line.trim()}`,
			);
		}
	});

	// The script-level backstop, mirroring guard_fleet_fatal's systemctl arm: a
	// future edit that reaches for a destructive tmux verb fails the DEPLOY, loudly,
	// before it can touch the host. This is the second layer, not the invariant —
	// the invariant is that ao-tmux.service owns no command that can kill the server.
	it("refuses, at the run() chokepoint, any tmux verb that could kill the fleet's server", async () => {
		for (const command of [
			"tmux kill-server",
			"tmux kill-session -t ao-1",
			"tmux kill-window -t ao-1",
			"tmux kill-pane -t ao-1",
		]) {
			const result = await sourceDeploy(`run ${command}`);
			assert.notEqual(result.code, 0, `deploy must refuse \`${command}\``);
			assert.match(result.stderr, /would kill|fleet/i, `\`${command}\` must be refused with a fleet-kill reason`);
		}

		// Read-only probes and the option write stay allowed — they are how deploy
		// identifies the server and pins it.
		for (const command of ["tmux list-sessions", "tmux set-option -g exit-empty off"]) {
			const result = await sourceDeploy(`run ${command}`);
			assert.equal(result.code, 0, `deploy must allow \`${command}\`: ${result.stderr}`);
		}
	});

	// --- 1c (#293, codex review of #309): After=/Wants= fails OPEN. If
	// ao-tmux.service is masked, fails, or never establishes a server, systemd
	// still starts ao.service — whose first `tmux new-session` then spawns the
	// server inside ao.service's cgroup and silently recreates D1. The daemon unit
	// must assert the invariant and fail LOUDLY instead.
	it("ships an ao.service that refuses to start when no tmux server owns the socket", async () => {
		const unit = await readFile(path.join(repoRoot, "ops", "ao.service"), "utf8");
		const assertion = execShellCommand(unit, "ExecStartPre");
		assert.ok(assertion, "ao.service must assert the D1 ownership invariant before the daemon starts");

		const fixture = await makeGitFixture();

		const noServer = await runShell(assertion, fixture.stubBin, {});
		assert.notEqual(noServer.code, 0, "no tmux server => the daemon would create one in its own cgroup => refuse");
		assert.match(noServer.stderr, /ao-tmux\.service/, "the failure must name the unit an operator has to start");

		// The migration window (1b): a legacy server owns the socket. It is NOT in
		// ao-tmux.service's cgroup, but it is not in ao.service's either — killing it
		// is worse than grandfathering it, so the daemon is allowed to start.
		const legacyServer = await runShell(assertion, fixture.stubBin, { AO_TEST_TMUX_SERVER_RUNNING: "1" });
		assert.equal(legacyServer.code, 0, "a live tmux server (legacy or ao-tmux-owned) satisfies the invariant");
	});

	// --- 1d (#293, codex review of #309): rollback flips `current` FIRST, then
	// installs units from it. A release that predates ao-tmux.service has no such
	// unit file — which used to abort the install AFTER the pointer had already
	// moved, i.e. it broke the emergency recovery path itself.
	it("rolls back to a release payload that predates ao-tmux.service without aborting half-switched", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		let web = await startFakeWeb();
		let result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		const first = (await readFile(path.join(fixture.stateDir, "current", "REVISION"), "utf8")).trim();
		const firstRelease = await readlinkReal(path.join(fixture.stateDir, "current"));

		await writeFile(path.join(fixture.dir, "README.md"), "second\n");
		await commitFixture(fixture.dir, "second");
		web = await startFakeWeb();
		result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

		// Age the previous release into a pre-#293 payload: no ao-tmux.service in it.
		await rm(path.join(firstRelease, "systemd", "ao-tmux.service"));

		await writeFile(fixture.systemctlLog, "");
		web = await startFakeWeb();
		result = await runDeployLive(fixture, web, {}, { args: ["--rollback"], daemonRevision: first });

		assert.equal(
			result.code,
			0,
			`rollback to a pre-tmux-unit release must succeed\n${result.stdout}\n${result.stderr}`,
		);
		assert.equal((await readFile(path.join(fixture.stateDir, "current", "REVISION"), "utf8")).trim(), first);
		const unitDir = path.join(fixture.home, ".config", "systemd", "user");
		// The already-installed tmux unit is kept: it is release-independent, and
		// removing it would hand the fleet's cgroup back to ao.service.
		await assert.doesNotReject(access(path.join(unitDir, "ao-tmux.service")));
		const systemctlLog = await readFile(fixture.systemctlLog, "utf8");
		assert.match(systemctlLog, /^--user restart ao\.service$/m, "the rollback must still restart the daemon");
		assert.doesNotMatch(systemctlLog, /^--user (stop|restart|kill|try-restart|disable --now) ao-tmux\.service$/m);
	});

	// --- 1e (#293, codex review of #309): drop-in convergence used to `rm -f
	// <unit>.d/*.conf` — deleting drop-ins deploy never created. An operator's
	// local port/limit override vanished on the next deploy, and the unconditional
	// web restart applied that silently.
	it("removes only the drop-ins it installed and leaves operator drop-ins alone", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const dropinDir = path.join(fixture.home, ".config", "systemd", "user", "ao-web.service.d");

		let web = await startFakeWeb();
		let result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		await assert.doesNotReject(access(path.join(dropinDir, "override.conf")), "deploy ships its own drop-in");

		// An operator adds a host-local override that deploy has never heard of.
		await writeFile(path.join(dropinDir, "10-local-port.conf"), "[Service]\nEnvironment=AO_WEB_PORT=6173\n");

		// The release then RETIRES its own drop-in.
		await rm(path.join(fixture.dir, "ops", "ao-web.service.d", "override.conf"));
		await commitFixture(fixture.dir, "drop the shipped web drop-in");
		web = await startFakeWeb();
		result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

		await assert.rejects(
			access(path.join(dropinDir, "override.conf")),
			"a drop-in this deploy owned and the release retired must be removed",
		);
		assert.equal(
			await readFile(path.join(dropinDir, "10-local-port.conf"), "utf8"),
			"[Service]\nEnvironment=AO_WEB_PORT=6173\n",
			"an operator drop-in deploy never created must survive the deploy",
		);
	});

	// --- 1f (#293, codex review of #309): the D2 sudo classifier piped journalctl
	// into node under `set -o pipefail` with a trailing `|| true`, so a journal
	// permission/DB failure reported as "no warnings" — silently clean.
	it("reports that the sudo classification is unavailable when the journal query fails", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, { AO_TEST_JOURNAL_FAIL: "1" });

		assert.equal(result.code, 0, "an unreadable journal is advisory, never fatal");
		assert.match(
			result.stdout,
			/WARN: .*sudo warning classification unavailable/,
			"a failing journal query must never be reported as zero warnings",
		);
	});

	// --- 2a (#293, codex review cycle 2 of #309): THE FLEET-KILL INVARIANT IS A
	// UNIT-FILE CONTRACT, NOT A deploy.sh CONTRACT.
	//
	// guard_fleet_fatal() can only refuse the spellings deploy.sh itself issues. It
	// cannot reach `systemctl --user stop ao-tmux.service` typed by a human, a
	// `mask --now`, an `isolate`, or a user-manager shutdown — all of which used to
	// reach ExecStop=`tmux kill-server` and destroy every agent pane. The hazard IS
	// the ExecStop. This asserts the unit itself carries no command and no signal
	// that can kill the tmux server.
	it("ships an ao-tmux.service that no systemd stop path can turn into a fleet kill", async () => {
		const unit = await readFile(path.join(repoRoot, "ops", "ao-tmux.service"), "utf8");
		const lines = asLogicalLines(unit);

		// 1. No ExecStop at all. A "tidy teardown" of this unit IS a fleet kill, so
		//    the unit must have no teardown: a stray stop orphans a still-ALIVE tmux
		//    server instead of killing it.
		assert.doesNotMatch(
			lines,
			/^[ \t]*ExecStop=/m,
			"ExecStop is the hazard: it runs on stop, restart, mask --now, isolate AND user-manager shutdown — none of which deploy.sh can intercept",
		);
		// 2. No directive anywhere may invoke a tmux teardown.
		for (const line of lines.split("\n")) {
			if (/^[ \t]*(?:#|;)/.test(line)) continue;
			assert.doesNotMatch(
				line,
				/kill-server|kill-session/,
				`no directive in ao-tmux.service may tear the server down: ${line}`,
			);
		}
		// 3. A manual stop/restart/try-restart/mask --now is refused by systemd itself
		//    — and the directive must sit in the section systemd actually reads it
		//    from. RefuseManualStop is a [Unit] key: in [Service] systemd logs
		//    "Unknown key ..., ignoring" and the guard silently protects NOTHING.
		//    A safety directive that parses but is ignored is worse than none.
		assert.match(
			lines,
			/^RefuseManualStop=yes$/m,
			"systemctl stop/restart/try-restart/mask --now must be refused by systemd, not merely avoided by deploy.sh",
		);
		assert.equal(
			unitSection(unit, "RefuseManualStop"),
			"Unit",
			"RefuseManualStop is a [Unit] key; systemd silently IGNORES it in [Service]",
		);
		// 4. The stop JOBS systemd can still run (dependency stop, isolate, the stop
		//    phase of a user-manager shutdown) are NOT refusable. Those jobs must be
		//    made non-fatal instead: with no ExecStop, systemd falls back to
		//    signalling the unit — so the signal it sends must not be fatal to the
		//    tmux server, and it must never escalate to SIGKILL.
		//
		//    Scope of the claim (#293, review cycles 3 and 4 — each corrected the one
		//    before): these directives neutralize the unit's own stop SEQUENCE. They
		//    do not make the fleet unkillable, and no unit directive could. A signal
		//    delivered straight to the processes still kills it: `systemctl --user
		//    kill`, a `kill` by PID, systemd-oomd, the kernel OOM killer, and the
		//    enclosing user-slice/session teardown that FOLLOWS the stop job at
		//    user-manager shutdown or host shutdown (whether an SSH logout triggers
		//    that at all is a linger/logind config question, not a unit-file one). Nor
		//    do they keep alive a tmux server that CRASHES: the panes are its children
		//    and die with it, and Restart=always then creates an empty replacement —
		//    valuable only because that replacement lands in this cgroup rather than
		//    ao.service's. So "ordinary systemd FAILURE paths can no longer kill the
		//    fleet" (cycle 3) is too broad and is narrowed here. What is bought is
		//    exactly: the deploy path and systemd stop/restart JOBS on this unit can
		//    no longer kill the fleet, and the unit being left `failed` no longer
		//    takes the server down with it.
		assert.match(lines, /^KillMode=process$/m, "a cgroup-wide signal here is a fleet kill");
		assert.match(
			lines,
			/^KillSignal=SIGCONT$/m,
			"the stop signal reaches the tmux server itself; it must be a no-op signal, not SIGTERM",
		);
		assert.match(
			lines,
			/^SendSIGKILL=no$/m,
			"after TimeoutStopSec systemd escalates to SIGKILL by default — that alone would kill the server",
		);
		assert.match(
			lines,
			/^OOMPolicy=continue$/m,
			"an OOM-killed agent process must not make systemd stop the unit that owns the fleet",
		);
	});

	// The section check above is one instance of a general hazard, so ask systemd
	// itself: a key in the wrong section, or a value it cannot parse, is IGNORED
	// with a single log line. Every safety directive in these units is exactly the
	// kind of thing that fails that way — silently, while still reading as a guard.
	// (`RefuseManualStop` in [Service] shipped in this very PR before this ran.)
	it("ships units that real systemd parses with no silently-ignored directives", async (t) => {
		const probe = await run("systemd-analyze", ["--version"]).catch(() => null);
		if (!probe || probe.code !== 0) {
			t.skip("systemd-analyze unavailable");
			return;
		}

		const units = ["ao.service", "ao-tmux.service", "ao-tmux-claim.service", "ao-tmux-claim.timer"].map((unit) =>
			path.join(repoRoot, "ops", unit),
		);
		const result = await run("systemd-analyze", ["--user", "verify", ...units], { cwd: repoRoot });
		const ignored = `${result.stdout}${result.stderr}`
			.split("\n")
			.filter((line) => /Unknown key|Unknown lvalue|Failed to parse|Ignoring/i.test(line));

		assert.deepEqual(ignored, [], `systemd would silently ignore these directives:\n${ignored.join("\n")}`);
	});

	// --- 2b (#293, codex review cycle 2 of #309): a SKIPPED unit is never retried.
	//
	// Restart= only reacts to a STARTED process exiting. When ExecCondition skips
	// ao-tmux.service (a legacy server owns the socket), nothing ever starts it
	// again — so if that legacy server ever stops owning the socket, the daemon's
	// next `tmux new-session` lazily spawns a server inside ao.service's cgroup and
	// D1 silently returns. The unit needs a real path back to the socket.
	//
	// Cycle 3 narrows WHEN that can happen, and therefore what this timer is for.
	// The legacy server can no longer DRAIN (deploy pins its `exit-empty off`), so
	// the only way the socket goes free is the server DYING: crash, OOM, an outright
	// kill. The timer still earns its keep for exactly that — not to rescue a live
	// fleet (if the server died, the fleet died with it) but to make sure the NEXT
	// server is created in ao-tmux.service's cgroup rather than the daemon's,
	// without a human and without a reboot.
	it("ships a claim timer that reacquires the tmux socket without a human when the legacy server dies", async () => {
		const timer = await readFile(path.join(repoRoot, "ops", "ao-tmux-claim.timer"), "utf8");
		const claim = await readFile(path.join(repoRoot, "ops", "ao-tmux-claim.service"), "utf8");

		assert.match(
			asLogicalLines(timer),
			/^On(?:UnitInactiveSec|UnitActiveSec|Calendar)=/m,
			"the timer must retry on a recurring schedule; a one-shot trigger cannot catch a server death that happens later",
		);
		assert.match(asLogicalLines(timer), /^Unit=ao-tmux-claim\.service$/m);
		assert.match(asLogicalLines(timer), /^WantedBy=timers\.target$/m, "the timer must be enableable");

		// The claim only ever STARTS the unit. `start` is a no-op when it is already
		// active, and its ExecCondition skips cleanly while a foreign server owns the
		// socket — so this can retry forever without ever touching a live server.
		const exec = unitDirective(claim, "ExecStart");
		assert.match(exec, /systemctl .*--user .*\bstart\b.* ao-tmux\.service$/, `claim must START the unit, got: ${exec}`);
		assert.doesNotMatch(
			exec,
			/\b(stop|restart|try-restart|kill)\b/,
			"the claim must never stop or restart the unit — that is the fleet kill",
		);

		// And the false claim must be gone from the unit's own documentation.
		const tmuxUnit = await readFile(path.join(repoRoot, "ops", "ao-tmux.service"), "utf8");
		assert.doesNotMatch(
			tmuxUnit,
			/Restart=always then takes the socket/,
			"Restart= does NOT retry a unit that ExecCondition skipped; that comment was wrong",
		);
	});

	it("drives the server-death -> reacquire transition end to end", async () => {
		const fixture = await makeGitFixture();
		const claim = await readFile(path.join(repoRoot, "ops", "ao-tmux-claim.service"), "utf8");
		const condition = execShellCommand(
			await readFile(path.join(repoRoot, "ops", "ao-tmux.service"), "utf8"),
			"ExecCondition",
		);

		// Step 1 — the legacy server still owns the socket: the timer fires, the claim
		// service asks systemd to start the unit, and the unit's condition SKIPS. No
		// server is touched, and nothing loops hot (the timer just fires again later).
		assert.equal(
			(await runShell(condition, fixture.stubBin, { AO_TEST_TMUX_STATE: "running" })).code,
			1,
			"while a server owns the socket the unit must skip (1-254 = skipped, not failed)",
		);

		// Step 2 — the legacy server DIES (crash, OOM, an outright kill; it can no
		// longer drain) and its socket is gone. The next timer tick runs the same
		// claim command...
		//
		// systemd requires an ABSOLUTE ExecStart, so the unit names /usr/bin/systemctl
		// — which would bypass the stub and drive this machine's REAL user manager.
		// Rebind it to the stub explicitly; the test asserts the arguments, never the
		// binary. A test must not be able to touch the live fleet.
		const log = path.join(fixture.home, "claim-systemctl.log");
		const claimCommand = unitDirective(claim, "ExecStart").replace(
			/^\/\S*\/systemctl\b/,
			path.join(fixture.stubBin, "systemctl"),
		);
		assert.notEqual(claimCommand, unitDirective(claim, "ExecStart"), "the real systemctl must have been stubbed out");
		const claimRun = await runShell(claimCommand, fixture.stubBin, { SYSTEMCTL_LOG: log });
		assert.equal(claimRun.code, 0, `the claim must not fail: ${claimRun.stderr}`);
		assert.match(
			await readFile(log, "utf8"),
			/^--user start .*ao-tmux\.service$/m,
			"the claim service must ask systemd to start the tmux unit",
		);

		// ...and this time the condition PASSES, so ExecStart creates the server inside
		// ao-tmux.service's cgroup. The socket is reacquired with no human involved.
		assert.equal(
			(await runShell(condition, fixture.stubBin, { AO_TEST_TMUX_STATE: "free" })).code,
			0,
			"once the socket is free the condition must pass so ExecStart owns the new server",
		);
	});

	it("does not try to enable a unit that has no [Install] section", async () => {
		// ao-tmux-claim.service is started BY ITS TIMER, so it has no [Install] — and
		// `systemctl enable` on such a unit does nothing but print a five-line "the
		// unit files have no installation config" complaint (verified against systemd
		// 257: it exits 0, so nothing catches it; it just becomes deploy noise forever).
		// The rule is general, not a special case for this unit: enable only what is
		// enableable.
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, { AO_TEST_TMUX_SERVER_RUNNING: "1" });
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

		const enableLine = (await readFile(fixture.systemctlLog, "utf8"))
			.split("\n")
			.find((line) => line.startsWith("--user enable "));
		assert.ok(enableLine, "deploy must still enable the installable units");
		assert.doesNotMatch(
			enableLine,
			/\bao-tmux-claim\.service\b/,
			"ao-tmux-claim.service has no [Install]; systemd cannot enable it",
		);
		assert.match(enableLine, /\bao-tmux-claim\.timer\b/, "the TIMER is the thing with an [Install] section");
		assert.match(enableLine, /\bao\.service\b/);
	});

	it("installs, enables and starts the tmux claim timer", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, { AO_TEST_TMUX_SERVER_RUNNING: "1" });

		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
		const unitDir = path.join(fixture.home, ".config", "systemd", "user");
		await assert.doesNotReject(access(path.join(unitDir, "ao-tmux-claim.service")));
		await assert.doesNotReject(access(path.join(unitDir, "ao-tmux-claim.timer")));

		const log = await readFile(fixture.systemctlLog, "utf8");
		assert.match(log, /^--user enable .*\bao-tmux-claim\.timer\b/m, "the timer must be enabled for the next boot");
		assert.match(
			log,
			/^--user (?:restart|start) ao-tmux-claim\.timer$/m,
			"the timer must also be running NOW — the server death it covers can happen at any moment of THIS boot, and `enable` alone only arms it for the next one",
		);
	});

	// --- 2c (#293, codex review cycle 2 of #309): the probes inferred "a server
	// exists" from ANY error they did not recognize. `tmux: command not found`, a
	// socket permission error, or any unrecognized diagnostic made the tmux unit
	// skip AND the daemon's assertion pass — so the daemon started, lazily spawned
	// the server in its own cgroup, and D1 was back. That is not an assertion.
	//
	// The probe is now `tmux list-sessions`, whose EXIT CODE is a positive test:
	// measured against tmux 3.5a it exits 0 for a live server with zero sessions
	// (has-session does not), exits 1 for no-server/stale-socket, and never creates
	// a server. English is used only to classify the FAILURE, and anything
	// unrecognized is a third, distinct, loud state.
	it("classifies the tmux probe into three states and never reads an unknown error as 'a server exists'", async () => {
		const fixture = await makeGitFixture();
		const condition = execShellCommand(
			await readFile(path.join(repoRoot, "ops", "ao-tmux.service"), "utf8"),
			"ExecCondition",
		);
		const assertion = execShellCommand(
			await readFile(path.join(repoRoot, "ops", "ao.service"), "utf8"),
			"ExecStartPre",
		);
		assert.ok(condition && assertion, "both units must carry a probe");

		// (i) A server owns the socket — including the ZERO-SESSION case, which is what
		// ao-tmux.service's own freshly-started server looks like when the fleet is
		// empty. Reading that as "no server" would refuse to start the daemon at boot.
		for (const state of ["running", "running-empty"]) {
			assert.equal(
				(await runShell(condition, fixture.stubBin, { AO_TEST_TMUX_STATE: state })).code,
				1,
				`${state}: skip`,
			);
			assert.equal(
				(await runShell(assertion, fixture.stubBin, { AO_TEST_TMUX_STATE: state })).code,
				0,
				`${state}: a live server satisfies the daemon's invariant`,
			);
		}

		// (ii) No server owns the socket — the one state that must be refused.
		for (const state of ["free", "stale"]) {
			assert.equal(
				(await runShell(condition, fixture.stubBin, { AO_TEST_TMUX_STATE: state })).code,
				0,
				`${state}: the socket is free, so the unit must take it`,
			);
			const refused = await runShell(assertion, fixture.stubBin, { AO_TEST_TMUX_STATE: state });
			assert.equal(refused.code, 1, `${state}: the daemon must refuse to become the tmux owner`);
			assert.match(refused.stderr, /ao-tmux\.service/, "the refusal must name the unit an operator has to start");
		}

		// (iii) The probe itself failed. NOT "a server exists" — a distinct, loud
		// refusal. `missing` is `tmux: command not found` (exit 127); `denied` is a
		// socket permission error; `broken` is any diagnostic we do not model.
		for (const state of ["missing", "denied", "broken"]) {
			const skipped = await runShell(condition, fixture.stubBin, { AO_TEST_TMUX_STATE: state });
			assert.equal(skipped.code, 2, `${state}: an unclassifiable probe must skip DISTINCTLY, not silently`);
			assert.match(skipped.stderr, /probe/i, `${state}: the skip must say why`);

			const refused = await runShell(assertion, fixture.stubBin, { AO_TEST_TMUX_STATE: state });
			assert.equal(refused.code, 2, `${state}: the daemon must refuse DISTINCTLY from "no server", never proceed`);
			assert.match(
				refused.stderr,
				/probe/i,
				`${state}: "I could not tell" must be actionable, not silently accepted as proof a server exists`,
			);
		}
	});

	it("refuses to guess about the tmux socket when its own probe fails", async () => {
		// deploy.sh made the same mistake the units did: any tmux failure it did not
		// recognize was read as "a server is running, leave it alone" — the
		// safe-SOUNDING answer that silently skips the entire D1 fix. A probe that
		// failed is a third state: touch nothing, and say so.
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web, { AO_TEST_TMUX_STATE: "broken" });

		assert.equal(result.code, 0, `an unclassifiable probe is not a reason to fail a deploy\n${result.stderr}`);
		assert.match(
			result.stdout,
			/WARN: the tmux ownership probe FAILED/,
			"an unrecognized tmux error must never be reported as 'a server is already running'",
		);
		assert.doesNotMatch(
			result.stdout,
			/tmux server is already running/,
			"deploy must not claim a server exists when it could not tell",
		);
		assert.doesNotMatch(
			await readFile(fixture.systemctlLog, "utf8"),
			/^--user start .*ao-tmux\.service$/m,
			"starting the unit blind could create a SECOND server",
		);
	});

	// --- 2d (#293, codex review cycle 2 of #309): the drop-in ledger tracked
	// ownership by FILENAME only. On the first deploy an operator's pre-existing
	// `override.conf` was silently overwritten and then RECORDED AS DEPLOY-OWNED —
	// so a later release that retired that name deleted the operator's file.
	// Ownership is now content-addressed: deploy owns a name only while the bytes
	// on disk are still the bytes it installed.
	it("never silently claims a pre-existing operator file at a managed drop-in name", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const dropinDir = path.join(fixture.home, ".config", "systemd", "user", "ao-web.service.d");
		await mkdir(dropinDir, { recursive: true });

		// The operator hand-placed a file at the very name the release also ships.
		const operatorBody = "[Service]\nEnvironment=AO_WEB_PUBLIC_URL=https://operator.example/\n";
		await writeFile(path.join(dropinDir, "override.conf"), operatorBody);

		const web = await startFakeWeb();
		const result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

		// Deploy still installs its own drop-in (the release's definition must reach
		// the host) — but it must not destroy what it found.
		assert.match(await readFile(path.join(dropinDir, "override.conf"), "utf8"), /fixture\.example/);
		const backups = (await readdir(dropinDir)).filter((name) => name.startsWith("override.conf."));
		assert.equal(backups.length, 1, `the pre-existing operator file must be preserved, found: ${backups}`);
		assert.equal(await readFile(path.join(dropinDir, backups[0]), "utf8"), operatorBody);
		assert.doesNotMatch(backups[0], /\.conf$/, "the backup must not itself be loaded by systemd");
		assert.match(result.stdout, /WARN: .*override\.conf/, "silently overwriting an operator file is the bug");
	});

	it("backs up an operator-modified managed drop-in instead of deleting it when the release retires it", async () => {
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const dropinDir = path.join(fixture.home, ".config", "systemd", "user", "ao-web.service.d");

		let web = await startFakeWeb();
		let result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

		// The operator EDITS the file at the managed name. Deploy installed it, so it
		// is in the ledger — but these are no longer deploy's bytes.
		const edited = "[Service]\nEnvironment=AO_WEB_PUBLIC_URL=https://edited.example/\n";
		await writeFile(path.join(dropinDir, "override.conf"), edited);

		// A later release retires the drop-in.
		await rm(path.join(fixture.dir, "ops", "ao-web.service.d", "override.conf"));
		await commitFixture(fixture.dir, "retire the shipped web drop-in");
		web = await startFakeWeb();
		result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

		// The retired drop-in stops being active (that is H4) — but the operator's
		// edits are not destroyed on the way out.
		await assert.rejects(
			access(path.join(dropinDir, "override.conf")),
			"a retired managed drop-in must not stay active",
		);
		const backups = (await readdir(dropinDir)).filter((name) => name.startsWith("override.conf."));
		assert.equal(backups.length, 1, `the operator's edits must be preserved, found: ${backups}`);
		assert.equal(await readFile(path.join(dropinDir, backups[0]), "utf8"), edited);
		assert.match(result.stdout, /WARN: .*override\.conf/, "deleting an operator's edited file must be announced");
	});

	it("still retires its own untouched drop-in without leaving a backup behind", async () => {
		// The control case for 2d: content-addressed ownership must not turn every
		// ordinary retirement into a backup — deploy owns bytes it wrote and nobody
		// touched, and removes them cleanly.
		const fixture = await makeGitFixture();
		await commitFixture(fixture.dir, "initial");
		const dropinDir = path.join(fixture.home, ".config", "systemd", "user", "ao-web.service.d");

		let web = await startFakeWeb();
		let result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

		await rm(path.join(fixture.dir, "ops", "ao-web.service.d", "override.conf"));
		await commitFixture(fixture.dir, "retire the shipped web drop-in");
		web = await startFakeWeb();
		result = await runDeployLive(fixture, web);
		assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

		const left = await readdir(dropinDir).catch(() => []);
		assert.deepEqual(
			left.filter((name) => name.startsWith("override.conf")),
			[],
			"deploy's own untouched drop-in is deploy's to remove, with no backup noise",
		);
	});
});

async function makeGitFixture() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "ao-deploy-repo-"));
	const home = await mkdtemp(path.join(os.tmpdir(), "ao-deploy-home-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	cleanup.push(() => rm(home, { recursive: true, force: true }));

	await mkdir(path.join(dir, "backend", "cmd", "ao"), { recursive: true });
	await mkdir(path.join(dir, "frontend"), { recursive: true });
	await mkdir(path.join(dir, "ops", "ao-web.service.d"), { recursive: true });
	await mkdir(path.join(home, ".local", "bin"), { recursive: true });

	await writeFile(path.join(dir, "backend", "cmd", "ao", "main.go"), "package main\nfunc main() {}\n");
	await writeFile(path.join(dir, "backend", "go.mod"), "module example.com/ao-fixture\n\ngo 1.22\n");
	await writeFile(path.join(dir, "frontend", "app.js"), "console.log('frontend');\n");
	await writeFile(path.join(dir, "frontend", "package.json"), '{"scripts":{"build:web":"echo build"}}\n');
	await writeFile(path.join(dir, "frontend", "package-lock.json"), '{"lockfileVersion":3}\n');
	await writeFile(path.join(dir, "ops", "ao-slack-notifier.mjs"), "console.log('ops');\n");
	// Production's web process IS this file — deploy must treat it as a web input.
	await writeFile(path.join(dir, "ops", "ao-web-server.mjs"), "console.log('web server');\n");
	await writeFile(
		path.join(dir, "ops", "ao-web.service.d", "override.conf"),
		"[Service]\nEnvironment=AO_WEB_PUBLIC_URL=https://fixture.example/\n",
	);
	await writeFile(
		path.join(dir, "ops", "ao.service"),
		await readFile(path.join(repoRoot, "ops", "ao.service"), "utf8"),
	);
	await writeFile(
		path.join(dir, "ops", "ao-tmux.service"),
		await readFile(path.join(repoRoot, "ops", "ao-tmux.service"), "utf8"),
	);
	await writeFile(
		path.join(dir, "ops", "ao-tmux-claim.service"),
		await readFile(path.join(repoRoot, "ops", "ao-tmux-claim.service"), "utf8"),
	);
	await writeFile(
		path.join(dir, "ops", "ao-tmux-claim.timer"),
		await readFile(path.join(repoRoot, "ops", "ao-tmux-claim.timer"), "utf8"),
	);
	await writeFile(
		path.join(dir, "ops", "ao-web.service"),
		await readFile(path.join(repoRoot, "ops", "ao-web.service"), "utf8"),
	);
	await writeFile(
		path.join(dir, "ops", "ao-slack-notifier.service"),
		await readFile(path.join(repoRoot, "ops", "ao-slack-notifier.service"), "utf8"),
	);
	await writeFile(
		path.join(dir, "ops", "ao-attention-reply.service"),
		await readFile(path.join(repoRoot, "ops", "ao-attention-reply.service"), "utf8"),
	);
	await writeFile(path.join(dir, "ops", "install-attention.sh"), "#!/usr/bin/env bash\nexit 0\n");
	await writeFile(path.join(dir, "README.md"), "fixture\n");
	await writeFile(path.join(home, ".local", "bin", "ao"), "current ao\n");
	await chmod(path.join(home, ".local", "bin", "ao"), 0o755);

	await git(dir, ["init", "-b", "main"]);
	await git(dir, ["config", "user.email", "test@example.com"]);
	await git(dir, ["config", "user.name", "Test User"]);

	const stubBin = path.join(home, "stub-bin");
	const systemctlLog = path.join(home, "systemctl.log");
	// Every tmux verb deploy issues, in order. The fleet lives inside the tmux
	// server, so "which tmux commands did the deploy run against it" is a safety
	// property, not a detail: one `kill-session` here is 49 dead agents.
	const tmuxLog = path.join(home, "tmux.log");
	const goBuildLog = path.join(home, "go-build.log");
	const npmLog = path.join(home, "npm.log");
	const orderLog = path.join(home, "deploy-order.log");
	const slackEnvFile = path.join(home, "agent-orchestrator", ".env");
	const ghStatusFile = path.join(home, "gh-status.json");
	const ghRunsFile = path.join(home, "gh-runs.json");
	const stateDir = path.join(home, "deploy-state");
	const stateFile = path.join(stateDir, "agent-orchestrator.last-deployed");
	await writeFile(ghStatusFile, JSON.stringify({ state: "success", failedJobs: [] }));
	await mkdir(path.dirname(slackEnvFile), { recursive: true });
	await writeFile(slackEnvFile, "SLACK_MEMBER_ID=U1\nSLACK_SIGNING_SECRET=sec\nSLACK_WEBHOOK_URL=http://hook\n");
	// Default: no scheduled/release workflow runs to exclude. Tests that exercise
	// the schedule/release-guard exclusion overwrite this with a workflow_runs list.
	await writeFile(ghRunsFile, JSON.stringify({ total_count: 0, workflow_runs: [] }));
	await makeStubBin(stubBin);

	return {
		dir,
		home,
		stubBin,
		systemctlLog,
		tmuxLog,
		goBuildLog,
		npmLog,
		orderLog,
		slackEnvFile,
		ghStatusFile,
		ghRunsFile,
		stateDir,
		stateFile,
	};
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
  session)
    if [[ "\${AO_STUB_SESSION_FAIL:-0}" = "1" ]]; then
      printf 'session list unavailable\\n' >&2
      exit 42
    fi
    if [[ -n "\${AO_TEST_ORDER_LOG:-}" ]]; then printf 'session count\\n' >> "\${AO_TEST_ORDER_LOG}"; fi
    echo "[]"
    ;;
  *) exit 1 ;;
esac
`,
		systemctl: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${SYSTEMCTL_LOG}"
if [[ -n "\${AO_TEST_ORDER_LOG:-}" && "$*" = "--user restart ao.service" ]]; then
  printf 'systemctl restart ao.service\\n' >> "\${AO_TEST_ORDER_LOG}"
fi
exit 0
`,
		go: `#!/usr/bin/env bash
if [[ "$1" = "version" && "$2" = "-m" ]]; then
  # AO_TEST_GO_VERSION_FAIL simulates \`go version -m\` failing to read the
  # binary (unreadable provenance): exit non-zero with no output.
  if [[ -n "\${AO_TEST_GO_VERSION_FAIL:-}" ]]; then
    exit 1
  fi
  # Emulate the toolchain-embedded VCS provenance the deploy gate reads via
  # \`go version -m\`. The test controls what gets stamped through env vars so a
  # single stub can exercise stamped, unstamped, and dirty builds. An unset
  # AO_TEST_VCS_REVISION prints no vcs.revision line at all — exactly the
  # -buildvcs=false / unstamped binary #262 must refuse.
  printf '%s: go1.26.4\\n' "\$3"
  if [[ -n "\${AO_TEST_VCS_REVISION:-}" ]]; then
    printf '\\tbuild\\tvcs.revision=%s\\n' "\${AO_TEST_VCS_REVISION}"
  fi
  # AO_TEST_VCS_MODIFIED_OMIT drops the vcs.modified line entirely, mirroring a
  # binary whose clean/dirty flag cannot be read.
  if [[ -z "\${AO_TEST_VCS_MODIFIED_OMIT:-}" ]]; then
    printf '\\tbuild\\tvcs.modified=%s\\n' "\${AO_TEST_VCS_MODIFIED:-false}"
  fi
  exit 0
fi
out=""
while (( $# > 0 )); do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ -n "\${GO_BUILD_LOG:-}" ]]; then
  {
    printf 'cwd=%s\\n' "\$PWD"
    if [[ -d ../.git ]]; then printf 'git-dir=directory\\n'; else printf 'git-dir=not-directory\\n'; fi
    printf 'status=%s\\n' "\$(git -C .. status --porcelain | tr '\\n' ' ')"
  } >> "\${GO_BUILD_LOG}"
fi
if [[ -n "\${AO_TEST_ORDER_LOG:-}" ]]; then printf 'go build\\n' >> "\${AO_TEST_ORDER_LOG}"; fi
if [[ -n "\${out}" ]]; then printf 'rebuilt ao\\n' > "\${out}"; chmod +x "\${out}"; fi
`,
		gh: `#!/usr/bin/env bash
if [[ "$1" = "api" ]]; then
  # deploy.sh queries two endpoints: the commit's check-runs (pass/fail state)
  # and the sha's workflow runs (to classify scheduled/release-guard suites).
  if [[ "$2" == *"actions/runs"* ]]; then
    # GH_RUNS_FAIL simulates an auth/rate-limit/network failure of the
    # workflow-runs fetch: emit to stderr and exit non-zero, as gh does.
    if [[ "\${GH_RUNS_FAIL:-0}" = "1" ]]; then
      printf 'gh: HTTP 403 rate limit exceeded\\n' >&2
      exit 1
    fi
    cat "\${GH_RUNS_FILE:-/dev/null}" 2>/dev/null || printf '{}'
  else
    cat "\${GH_STATUS_FILE}"
  fi
  exit 0
fi
exit 1
`,
		// Mirrors real tmux's probe semantics, measured on the host:
		//   no server at all      -> stderr "error connecting to <socket>", exit 1
		//   server, zero sessions -> stderr "no current target",            exit 1
		//   server, >=1 session   -> exit 0
		// Only the FIRST case means "the socket is free for ao-tmux.service".
		// AO_TEST_JOURNAL_FAIL mirrors a journal the deploy user cannot read (missing
		// systemd-journal group, corrupt journal DB): journalctl writes to stderr and
		// exits non-zero, emitting NO entries. That must never read as "zero warnings".
		journalctl: `#!/usr/bin/env bash
if [[ "\${AO_TEST_JOURNAL_FAIL:-0}" = "1" ]]; then
  printf 'Failed to open journal: Permission denied\\n' >&2
  exit 1
fi
printf '%s' "\${AO_TEST_JOURNAL_SUDO:-}"
exit 0
`,
		// tmux 3.5a's probe semantics, MEASURED on the deploy host. Neither
		// list-sessions nor has-session ever CREATES a server, so a probe can never
		// itself spawn the ao.service-parented server we are avoiding.
		//
		//   state           list-sessions                          has-session
		//   server+sessions exit 0                                 exit 0
		//   server+0 sess.  exit 0                                 exit 1 "no current target"
		//   no server       exit 1 "error connecting to <socket>"  same
		//   stale socket    exit 1 "no server running on <socket>" same
		//
		// The zero-session divergence is the whole reason the probe uses
		// list-sessions: an EXIT CODE of 0 positively proves a server owns the
		// socket, with no English involved. `denied`/`broken`/`missing` are the
		// probe-FAILED states the classifier must refuse to read as "a server exists".
		tmux: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${TMUX_LOG:-/dev/null}"
state="\${AO_TEST_TMUX_STATE:-}"
if [[ -z "\${state}" ]]; then
  if [[ "\${AO_TEST_TMUX_SERVER_RUNNING:-0}" = "1" ]]; then state=running; else state=free; fi
fi
if [[ "$1" = "set-option" && "\${AO_TEST_TMUX_SET_OPTION_FAIL:-0}" = "1" ]]; then
  printf 'no server running on /tmp/tmux-1007/default\\n' >&2
  exit 1
fi
if [[ "$1" != "list-sessions" && "$1" != "has-session" ]]; then exit 0; fi
case "\${state}" in
  running)
    exit 0 ;;
  running-empty)
    [[ "$1" = "has-session" ]] && { printf 'no current target\\n' >&2; exit 1; }
    exit 0 ;;
  free)
    printf 'error connecting to /tmp/tmux-1007/default (No such file or directory)\\n' >&2
    exit 1 ;;
  stale)
    printf 'no server running on /tmp/tmux-1007/default\\n' >&2
    exit 1 ;;
  denied)
    printf 'error connecting to /tmp/tmux-1007/default (Permission denied)\\n' >&2
    exit 1 ;;
  broken)
    printf 'lost server\\n' >&2
    exit 1 ;;
  missing)
    printf 'tmux: command not found\\n' >&2
    exit 127 ;;
esac
exit 0
`,
		npm: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${NPM_LOG:-/dev/null}"
if [[ -n "\${AO_TEST_ORDER_LOG:-}" ]]; then printf 'npm %s\\n' "$*" >> "\${AO_TEST_ORDER_LOG}"; fi
if [[ "\${NPM_STUB_FAIL:-0}" = "1" ]]; then
  printf 'npm ci failed in stub\\n' >&2
  exit 42
fi
if [[ "$*" = "run build:web" ]]; then
  mkdir -p dist
  printf 'built web\\n' > dist/index.html
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
	versionRevision = "",
} = {}) {
	let webHits = 0;
	let currentVersionRevision = versionRevision;

	const apiServer = http.createServer((req, res) => {
		if (req.url.startsWith("/api/v1/version")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ version: "dev", revision: currentVersionRevision, modified: false }));
			return;
		}
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

	return {
		apiPort,
		webUrl: `http://127.0.0.1:${webPort}/`,
		webHits: () => webHits,
		setVersionRevision: (rev) => {
			currentVersionRevision = rev;
		},
	};
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
		"backend/go.mod",
		"backend/cmd/ao/main.go",
		"frontend/app.js",
		"frontend/package.json",
		"frontend/package-lock.json",
		"ops/ao-slack-notifier.mjs",
		"ops/ao-web-server.mjs",
		"ops/ao.service",
		"ops/ao-tmux.service",
		"ops/ao-tmux-claim.service",
		"ops/ao-tmux-claim.timer",
		"ops/ao-web.service",
		"ops/ao-web.service.d/override.conf",
		"ops/ao-slack-notifier.service",
		"ops/ao-attention-reply.service",
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

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Runs deploy.sh for real (no AO_DEPLOY_DRY_RUN), with the host-mutating
// commands stubbed on PATH but curl and the HTTP probes genuinely exercised.
async function runDeployLive(fixture, web, env = {}, opts = {}) {
	// By default a live deploy must clear the #262 provenance gate: the built
	// binary is stamped with the fixture's HEAD sha and the running daemon
	// reports that same sha. Tests exercising the gate's failure paths override
	// AO_TEST_VCS_REVISION / AO_TEST_VCS_MODIFIED (what the built binary is
	// stamped with) and/or opts.daemonRevision (what /api/v1/version reports).
	const requestedRef = env.AO_DEPLOY_HEAD ?? "HEAD";
	const head = (await git(fixture.dir, ["rev-parse", `${requestedRef}^{commit}`])).stdout.trim();
	const stampedRevision = env.AO_TEST_VCS_REVISION ?? head;
	web.setVersionRevision?.(opts.daemonRevision ?? stampedRevision);
	return run("bash", [deployScript, ...(opts.args ?? [])], {
		cwd: repoRoot,
		env: {
			...process.env,
			AO_TEST_VCS_REVISION: head,
			AO_TEST_VCS_MODIFIED: "false",
			PATH: `${fixture.stubBin}${path.delimiter}${process.env.PATH}`,
			HOME: fixture.home,
			SYSTEMCTL_LOG: fixture.systemctlLog,
			TMUX_LOG: fixture.tmuxLog,
			GO_BUILD_LOG: fixture.goBuildLog,
			NPM_LOG: fixture.npmLog,
			AO_TEST_ORDER_LOG: fixture.orderLog,
			GH_STATUS_FILE: fixture.ghStatusFile,
			GH_RUNS_FILE: fixture.ghRunsFile,
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

// Source deploy.sh as a library (AO_DEPLOY_LIB_ONLY skips the deploy/rollback
// dispatch) and evaluate one snippet against its real functions. Runs with
// AO_DEPLOY_DRY_RUN=1 so a snippet that IS allowed through only prints its
// command — the test host is never mutated.
async function sourceDeploy(snippet, env = {}) {
	return run("bash", ["-c", `source "${deployScript}"\n${snippet}`], {
		cwd: repoRoot,
		env: { ...process.env, AO_DEPLOY_LIB_ONLY: "1", AO_DEPLOY_DRY_RUN: "1", ...env },
	});
}

// Which [Section] a directive is written under. systemd silently IGNORES a key in
// the wrong section (it logs "Unknown key ..., ignoring" once at load and carries
// on), so a misplaced safety directive parses, reads as protection, and does
// nothing. Section placement is part of the contract, not a style question.
function unitSection(unitBody, directive) {
	let section = null;
	for (const raw of asLogicalLines(unitBody).split("\n")) {
		const line = raw.trim();
		const header = /^\[(.+)\]$/.exec(line);
		if (header) {
			section = header[1];
			continue;
		}
		if (line.startsWith(`${directive}=`)) return section;
	}
	return null;
}

// The raw value of a unit directive, as systemd's logical line reader sees it.
function unitDirective(unitBody, directive) {
	const line = asLogicalLines(unitBody)
		.split("\n")
		.find((candidate) => candidate.startsWith(`${directive}=`));
	assert.ok(line, `unit has no ${directive}=`);
	return line.slice(directive.length + 1).trim();
}

// Pull the shell script out of a `<Directive>=/bin/sh -c '<script>'` unit line so
// a test can execute exactly what systemd would execute.
function execShellCommand(unitBody, directive) {
	const line = asLogicalLines(unitBody)
		.split("\n")
		.find((candidate) => candidate.startsWith(`${directive}=`));
	if (!line) return null;
	const match = /^[^=]+=\/bin\/sh -c '(.*)'$/.exec(line.trim());
	assert.ok(match, `${directive} must be a single /bin/sh -c '…' command, got: ${line}`);
	return match[1];
}

async function runShell(script, stubBin, env = {}) {
	return run("/bin/sh", ["-c", script], {
		cwd: repoRoot,
		env: { ...process.env, PATH: `${stubBin}${path.delimiter}${process.env.PATH}`, ...env },
	});
}

async function readlinkReal(linkPath) {
	const target = await readlink(linkPath);
	return path.resolve(path.dirname(linkPath), target);
}

function waitForStdout(child, expected) {
	return new Promise((resolve, reject) => {
		let stdout = "";
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${expected}`)), 5000);
		child.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
			if (stdout.includes(expected)) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.once("exit", (code) => {
			if (!stdout.includes(expected)) {
				clearTimeout(timer);
				reject(new Error(`lock holder exited before ${expected}: ${code}`));
			}
		});
	});
}

async function listReleaseDirs(stateDir) {
	const releasesDir = path.join(stateDir, "releases");
	const names = await readdir(releasesDir);
	return names
		.filter((name) => !name.startsWith(".staging-"))
		.map((name) => path.join(releasesDir, name))
		.sort();
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
