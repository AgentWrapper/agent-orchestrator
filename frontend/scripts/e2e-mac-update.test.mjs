import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "./e2e-mac-update.mjs";

// The harness itself needs a real macOS runner, a real signed N-1 install and a
// real published N feed, so it cannot run here. What IS testable anywhere is the
// flag contract: a typo in the CI job's arguments should fail loudly at parse
// time rather than half-run an update test and report a confusing timeout.

describe("e2e-mac-update parseArgs", () => {
	const required = ["--app", "/Applications/Agent Orchestrator.app", "--expect-version", "0.10.4"];

	it("parses the required flags and defaults the state dir to ~/.ao", () => {
		const opts = parseArgs(required);
		expect(opts.app).toBe("/Applications/Agent Orchestrator.app");
		expect(opts.expectVersion).toBe("0.10.4");
		expect(opts.appName).toBe("Agent Orchestrator");
		// All app state lives under ~/.ao only (see AGENTS.md hard rules).
		expect(opts.stateDir).toBe(join(homedir(), ".ao"));
		expect(opts.runFile).toBe(join(homedir(), ".ao", "running.json"));
		expect(opts.channel).toBe("latest");
	});

	it("requires --app and --expect-version", () => {
		expect(() => parseArgs([])).toThrow(/--app is required/);
		expect(() => parseArgs(["--app", "/x/Foo.app"])).toThrow(/--expect-version is required/);
	});

	it("rejects an --app path that is not a bundle", () => {
		expect(() => parseArgs(["--app", "/Applications/Foo", "--expect-version", "1.0.0"])).toThrow(/\.app bundle/);
	});

	it("rejects an unknown channel", () => {
		expect(() => parseArgs([...required, "--channel", "beta"])).toThrow(/latest or nightly/);
	});

	it("accepts the nightly channel", () => {
		expect(parseArgs([...required, "--channel", "nightly"]).channel).toBe("nightly");
	});

	it("rejects a flag with a missing value", () => {
		expect(() => parseArgs(["--app", "--expect-version", "0.10.4"])).toThrow(/--app needs a value/);
	});

	it("rejects unknown flags", () => {
		expect(() => parseArgs([...required, "--turbo"])).toThrow(/unknown flag: --turbo/);
	});

	it("converts timeout flags from seconds to milliseconds and rejects nonpositive values", () => {
		expect(parseArgs([...required, "--swap-timeout", "90"]).swapTimeoutMs).toBe(90_000);
		expect(() => parseArgs([...required, "--swap-timeout", "0"])).toThrow(/positive number of seconds/);
		expect(() => parseArgs([...required, "--download-timeout", "soon"])).toThrow(/positive number of seconds/);
	});

	it("allows overriding the state dir and run file", () => {
		const opts = parseArgs([...required, "--state-dir", "/tmp/ao-e2e", "--run-file", "/tmp/ao-e2e/run.json"]);
		expect(opts.stateDir).toBe("/tmp/ao-e2e");
		expect(opts.runFile).toBe("/tmp/ao-e2e/run.json");
	});
});
