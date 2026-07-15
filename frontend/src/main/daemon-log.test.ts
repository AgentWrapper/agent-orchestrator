// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DAEMON_LOG_FILE_NAME, DAEMON_LOG_MAX_BYTES, daemonLogPath, openDaemonLog } from "./daemon-log";

describe("daemon-log", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "ao-daemon-log-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("stores daemon logs beside running.json under logs/", () => {
		expect(daemonLogPath(path.join(dir, "running.json"), "/home/alice")).toBe(
			path.join(dir, "logs", DAEMON_LOG_FILE_NAME),
		);
	});

	it("falls back to ~/.ao/logs when no run-file path is available", () => {
		expect(daemonLogPath(null, "/home/alice")).toBe(path.join("/home/alice", ".ao", "logs", DAEMON_LOG_FILE_NAME));
	});

	it("persists stdout and stderr with line prefixes and flushes partial lines on close", async () => {
		const sink = await openDaemonLog(path.join(dir, "running.json"), "/home/alice");
		expect(sink).not.toBeNull();

		sink!.writeOutput("stdout", "ready\npartial");
		sink!.writeOutput("stderr", "panic: boom\n");
		sink!.writeOutput("stdout", " line\n");
		await sink!.close();

		const contents = await readFile(sink!.path, "utf8");
		expect(contents).toContain("[supervisor] daemon launch output started");
		expect(contents).toContain("[stdout] ready\n");
		expect(contents).toContain("[stdout] partial line\n");
		expect(contents).toContain("[stderr] panic: boom\n");
	});

	it("rotates an oversized prior log before appending a new launch", async () => {
		const logPath = path.join(dir, "logs", DAEMON_LOG_FILE_NAME);
		await mkdir(path.dirname(logPath), { recursive: true });
		await writeFile(logPath, "x".repeat(DAEMON_LOG_MAX_BYTES + 1), "utf8");

		const sink = await openDaemonLog(path.join(dir, "running.json"), "/home/alice");
		expect(sink).not.toBeNull();
		await sink!.close();

		const rotated = await stat(`${logPath}.1`);
		const current = await stat(logPath);
		expect(rotated.size).toBe(DAEMON_LOG_MAX_BYTES + 1);
		expect(current.size).toBeGreaterThan(0);
	});
});
