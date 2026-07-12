import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

const SCRIPT = resolve("scripts/check-migration-versions.sh");
const GO_WORKFLOW = resolve(".github/workflows/go.yml");
const MIGRATIONS_DIR = "backend/internal/storage/sqlite/migrations";

function run(cmd, args, cwd) {
	const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`${cmd} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	}
	return result;
}

function check(args, cwd) {
	return spawnSync(SCRIPT, args, { cwd, encoding: "utf8" });
}

function writeMigration(repo, name) {
	const path = join(repo, MIGRATIONS_DIR, name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `-- +goose Up\nSELECT '${name}';\n-- +goose Down\nSELECT '${name}';\n`);
}

function initRepo() {
	const repo = mkdtempSync(join(tmpdir(), "ao-migration-check-"));
	run("git", ["init", "-b", "main"], repo);
	run("git", ["config", "user.email", "test@example.com"], repo);
	run("git", ["config", "user.name", "Test User"], repo);
	writeMigration(repo, "0001_init.sql");
	run("git", ["add", MIGRATIONS_DIR], repo);
	run("git", ["commit", "-m", "base"], repo);
	return repo;
}

describe("check-migration-versions", () => {
	it("has one dedicated CI owner instead of a weaker build-test duplicate", () => {
		const workflow = readFileSync(GO_WORKFLOW, "utf8");
		const buildTest = workflow.split("\n  build-test:", 2)[1]?.split("\n  boot-daemon-smoke:", 1)[0] ?? "";

		assert.doesNotMatch(buildTest, /check-migration-versions\.sh/);
		assert.match(workflow, /migration-version-guard:/);
		assert.match(workflow, /check-migration-versions\.sh --require-current-base/);
	});

	it("passes when a branch adds a fresh migration and is based on the current base ref", () => {
		const repo = initRepo();

		run("git", ["checkout", "-b", "topic"], repo);
		writeMigration(repo, "0002_topic.sql");
		run("git", ["add", join(MIGRATIONS_DIR, "0002_topic.sql")], repo);
		run("git", ["commit", "-m", "topic migration"], repo);

		const result = check(["--require-current-base", "main"], repo);

		assert.equal(result.status, 0, result.stderr);
	});

	it("passes when a base ref is supplied but the branch adds no migrations", () => {
		const repo = initRepo();

		run("git", ["checkout", "-b", "topic"], repo);
		writeFileSync(join(repo, "README.md"), "no migration here\n");
		run("git", ["add", "README.md"], repo);
		run("git", ["commit", "-m", "docs"], repo);

		const result = check(["--require-current-base", "main"], repo);

		assert.equal(result.status, 0, result.stderr);
	});

	it("fails closed when current-base enforcement has no base ref", () => {
		const repo = initRepo();
		const result = check(["--require-current-base"], repo);

		assert.equal(result.status, 2);
		assert.match(result.stderr, /requires a base ref/);
	});

	it("fails closed when the base ref does not resolve", () => {
		const repo = initRepo();
		const result = check(["missing-base"], repo);

		assert.equal(result.status, 2);
		assert.match(result.stderr, /does not resolve to a commit/);
	});

	it("fails when a branch migration version already exists on the base ref", () => {
		const repo = initRepo();

		run("git", ["checkout", "-b", "topic"], repo);
		writeMigration(repo, "0002_topic.sql");
		run("git", ["add", join(MIGRATIONS_DIR, "0002_topic.sql")], repo);
		run("git", ["commit", "-m", "topic migration"], repo);

		run("git", ["checkout", "main"], repo);
		writeMigration(repo, "0002_main.sql");
		run("git", ["add", join(MIGRATIONS_DIR, "0002_main.sql")], repo);
		run("git", ["commit", "-m", "main migration"], repo);

		run("git", ["checkout", "topic"], repo);
		const result = check(["main"], repo);

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /migration version 2 .* already exists on main/);
	});

	it("fails when a branch adds a migration but is not based on the current base ref", () => {
		const repo = initRepo();

		run("git", ["checkout", "-b", "topic"], repo);
		writeMigration(repo, "0003_topic.sql");
		run("git", ["add", join(MIGRATIONS_DIR, "0003_topic.sql")], repo);
		run("git", ["commit", "-m", "topic migration"], repo);

		run("git", ["checkout", "main"], repo);
		writeMigration(repo, "0002_main.sql");
		run("git", ["add", join(MIGRATIONS_DIR, "0002_main.sql")], repo);
		run("git", ["commit", "-m", "main migration"], repo);

		run("git", ["checkout", "topic"], repo);
		const result = check(["--require-current-base", "main"], repo);

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /not based on current main/);
	});
});
