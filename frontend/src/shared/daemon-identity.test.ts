import { describe, expect, it } from "vitest";
import {
	argvRunsDaemonSubcommand,
	executablePathIsDaemonBinary,
	parseProcBootTimeMs,
	parseProcCmdline,
	parseProcStat,
	parsePsArgv,
	procStartTimeMs,
	parsePsStartTimeMs,
	type ProcessIdentity,
	startTimeMatchesRunFile,
	verifyDaemonProcessIdentity,
	readConsistentProcessEvidence,
	verifyProcessIsAoDaemon,
} from "./daemon-identity";

const BOOT_MS = Date.UTC(2026, 6, 12, 0, 0, 0);

function identity(overrides: Partial<ProcessIdentity> = {}): ProcessIdentity {
	return {
		pid: 4242,
		startTimeMs: BOOT_MS + 60_000,
		argv: ["/usr/local/bin/ao", "daemon"],
		...overrides,
	};
}

describe("parseProcStat", () => {
	it("reads starttime (field 22) past a comm containing spaces and parens", () => {
		// comm is field 2, wrapped in parens, and may itself contain ") (" — the
		// only safe split point is the LAST ')'.
		const fields = [
			"R", // 3 state
			"1", // 4 ppid
			"4242", // 5 pgrp
			"4242", // 6 session
			"0", // 7 tty_nr
			"-1", // 8 tpgid
			"0", // 9 flags
			"0", // 10 minflt
			"0", // 11 cminflt
			"0", // 12 majflt
			"0", // 13 cmajflt
			"0", // 14 utime
			"0", // 15 stime
			"0", // 16 cutime
			"0", // 17 cstime
			"20", // 18 priority
			"0", // 19 nice
			"1", // 20 num_threads
			"0", // 21 itrealvalue
			"6000", // 22 starttime
			"0", // 23 vsize
		].join(" ");
		const stat = parseProcStat(`4242 (ao daemon (weird)) ${fields}\n`);
		expect(stat).toEqual({ startTimeTicks: 6000 });
	});

	it("returns null for garbage", () => {
		expect(parseProcStat("")).toBeNull();
		expect(parseProcStat("4242 no-parens 1 2 3")).toBeNull();
	});
});

describe("parseProcBootTimeMs", () => {
	it("reads btime (seconds since epoch) from /proc/stat", () => {
		expect(parseProcBootTimeMs("cpu  1 2 3\nbtime 1783900800\nprocesses 42\n")).toBe(1783900800 * 1000);
	});

	it("returns null when btime is absent or unparseable", () => {
		expect(parseProcBootTimeMs("cpu 1 2 3\n")).toBeNull();
		expect(parseProcBootTimeMs("btime nope\n")).toBeNull();
	});
});

describe("procStartTimeMs", () => {
	it("converts ticks-since-boot into an absolute epoch time", () => {
		expect(procStartTimeMs(BOOT_MS, 6000, 100)).toBe(BOOT_MS + 60_000);
	});

	it("returns null for a nonsensical clock rate", () => {
		expect(procStartTimeMs(BOOT_MS, 6000, 0)).toBeNull();
	});
});

describe("parsePsStartTimeMs", () => {
	it("parses the macOS `ps -o lstart=` format", () => {
		expect(parsePsStartTimeMs("Sun Jul 12 09:15:04 2026")).toBe(new Date("Sun Jul 12 09:15:04 2026").getTime());
	});

	it("returns null for unparseable input", () => {
		expect(parsePsStartTimeMs("")).toBeNull();
		expect(parsePsStartTimeMs("not a date")).toBeNull();
	});
});

describe("parseProcCmdline", () => {
	it("splits the NUL-delimited argv and drops the trailing empty", () => {
		expect(parseProcCmdline("/usr/local/bin/ao\0daemon\0")).toEqual(["/usr/local/bin/ao", "daemon"]);
	});

	it("returns an empty argv for a kernel thread's empty cmdline", () => {
		expect(parseProcCmdline("")).toEqual([]);
	});
});

describe("argvRunsDaemonSubcommand", () => {
	it("accepts the AO binary running the daemon subcommand", () => {
		expect(argvRunsDaemonSubcommand(["/usr/local/bin/ao", "daemon"], "linux")).toBe(true);
		expect(argvRunsDaemonSubcommand(["/tmp/go-build123/b001/exe/ao", "daemon"], "linux")).toBe(true);
		expect(argvRunsDaemonSubcommand(["C:\\ao\\ao.exe", "daemon"], "win32")).toBe(true);
	});

	it("rejects an ordinary `ao` CLI invocation — the CLI is not the daemon", () => {
		expect(argvRunsDaemonSubcommand(["/usr/local/bin/ao", "status"], "linux")).toBe(false);
		expect(argvRunsDaemonSubcommand(["/usr/local/bin/ao"], "linux")).toBe(false);
		// "daemon" appearing as a later argument (e.g. a message body) is not the
		// subcommand — only the first non-flag token is.
		expect(argvRunsDaemonSubcommand(["/usr/local/bin/ao", "session", "send", "daemon"], "linux")).toBe(false);
	});

	it("rejects a non-AO executable", () => {
		expect(argvRunsDaemonSubcommand(["/usr/bin/psql", "daemon"], "linux")).toBe(false);
	});
});

describe("startTimeMatchesRunFile", () => {
	const startedAt = BOOT_MS + 61_000; // run-file written 1s after the process started

	it("accepts a process that started just before the run-file recorded it", () => {
		expect(startTimeMatchesRunFile(BOOT_MS + 60_000, startedAt)).toBe(true);
	});

	it("rejects a recycled PID — a process that started long AFTER the recorded daemon start", () => {
		expect(startTimeMatchesRunFile(startedAt + 3_600_000, startedAt)).toBe(false);
	});

	it("rejects a process that predates the recorded start by more than daemon init could take", () => {
		expect(startTimeMatchesRunFile(startedAt - 3_600_000, startedAt)).toBe(false);
	});

	it("rejects unknown start times and a run-file with no startedAt", () => {
		expect(startTimeMatchesRunFile(null, startedAt)).toBe(false);
		expect(startTimeMatchesRunFile(BOOT_MS + 60_000, 0)).toBe(false);
	});
});

describe("verifyDaemonProcessIdentity", () => {
	const runFileStartedAtMs = BOOT_MS + 61_000;

	it("verifies a process that is the AO binary, running `daemon`, started when the run-file says", () => {
		expect(
			verifyDaemonProcessIdentity({
				identity: identity(),
				executablePath: "/usr/local/bin/ao",
				requiredExecutablePath: null,
				runFileStartedAtMs,
				platform: "linux",
			}),
		).toEqual({ verified: true, reason: "verified" });
	});

	it("refuses a PID whose start time contradicts the run-file (PID recycled after a crash)", () => {
		const result = verifyDaemonProcessIdentity({
			identity: identity({ startTimeMs: runFileStartedAtMs + 7_200_000 }),
			executablePath: "/usr/local/bin/ao",
			requiredExecutablePath: null,
			runFileStartedAtMs,
			platform: "linux",
		});
		expect(result).toEqual({ verified: false, reason: "start-time-mismatch" });
	});

	it("refuses a plain `ao` CLI process — an `ao` basename is not the daemon", () => {
		const result = verifyDaemonProcessIdentity({
			identity: identity({ argv: ["/usr/local/bin/ao", "session", "ls"] }),
			executablePath: "/usr/local/bin/ao",
			requiredExecutablePath: null,
			runFileStartedAtMs,
			platform: "linux",
		});
		expect(result).toEqual({ verified: false, reason: "not-daemon-argv" });
	});

	it("refuses a bundled launch whose PID runs a different AO installation's binary", () => {
		const result = verifyDaemonProcessIdentity({
			identity: identity({ argv: ["/opt/other-ao/ao", "daemon"] }),
			executablePath: "/opt/other-ao/ao",
			requiredExecutablePath: "/Applications/AO.app/Contents/Resources/daemon/ao",
			runFileStartedAtMs,
			platform: "darwin",
		});
		expect(result).toEqual({ verified: false, reason: "executable-mismatch" });
	});

	it("refuses when the OS would not tell us who the process is (unverifiable is never ours)", () => {
		expect(
			verifyDaemonProcessIdentity({
				identity: null,
				executablePath: "/usr/local/bin/ao",
				requiredExecutablePath: null,
				runFileStartedAtMs,
				platform: "linux",
			}),
		).toEqual({ verified: false, reason: "no-process-identity" });
		expect(
			verifyDaemonProcessIdentity({
				identity: identity(),
				executablePath: null,
				requiredExecutablePath: null,
				runFileStartedAtMs,
				platform: "linux",
			}),
		).toEqual({ verified: false, reason: "no-executable" });
	});

	// Cycle-4 1a. argv is PROCESS-supplied — /proc/<pid>/cmdline is whatever the
	// process put there, and prctl/exec let any program present itself as
	// ["/usr/local/bin/ao", "daemon"]. The executable link is what the KERNEL says.
	// With no bundled path to pin against, an argv-only check accepted any binary.
	it("refuses a process claiming `ao daemon` in argv while the kernel names another executable", () => {
		const result = verifyDaemonProcessIdentity({
			identity: identity({ argv: ["/usr/local/bin/ao", "daemon"] }),
			executablePath: "/tmp/not-ao",
			requiredExecutablePath: null,
			runFileStartedAtMs,
			platform: "linux",
		});
		expect(result).toEqual({ verified: false, reason: "executable-mismatch" });
	});
});

describe("executablePathIsDaemonBinary", () => {
	it("accepts the AO binary the kernel reports, per platform", () => {
		expect(executablePathIsDaemonBinary("/usr/local/bin/ao", "linux")).toBe(true);
		expect(executablePathIsDaemonBinary("/Applications/Agent Orchestrator.app/Contents/Resources/ao", "darwin")).toBe(
			true,
		);
		expect(executablePathIsDaemonBinary("C:\\Program Files\\AO\\ao.exe", "win32")).toBe(true);
	});

	it("refuses a foreign executable and an unknown one", () => {
		expect(executablePathIsDaemonBinary("/usr/bin/psql", "linux")).toBe(false);
		expect(executablePathIsDaemonBinary("/tmp/ao-impostor", "linux")).toBe(false);
		expect(executablePathIsDaemonBinary(null, "linux")).toBe(false);
	});
});

// The port-owner proof: everything the run-file proof requires EXCEPT the
// start-time binding (there is no run-file `startedAt` to bind to on that path).
describe("verifyProcessIsAoDaemon", () => {
	it("verifies a kernel-confirmed AO binary running the `daemon` subcommand", () => {
		expect(
			verifyProcessIsAoDaemon({
				identity: identity(),
				executablePath: "/usr/local/bin/ao",
				requiredExecutablePath: null,
				platform: "linux",
			}),
		).toEqual({ verified: true, reason: "verified" });
	});

	it("refuses an impostor whose argv says `ao daemon` but whose executable is not the AO binary", () => {
		expect(
			verifyProcessIsAoDaemon({
				identity: identity({ argv: ["/usr/local/bin/ao", "daemon"] }),
				executablePath: "/usr/bin/psql",
				requiredExecutablePath: null,
				platform: "linux",
			}),
		).toEqual({ verified: false, reason: "executable-mismatch" });
	});

	it("refuses when the kernel discloses no executable (unknown is never ours)", () => {
		expect(
			verifyProcessIsAoDaemon({
				identity: identity(),
				executablePath: null,
				requiredExecutablePath: null,
				platform: "linux",
			}),
		).toEqual({ verified: false, reason: "no-executable" });
	});

	it("refuses a different AO installation's binary when the bundled path is known", () => {
		expect(
			verifyProcessIsAoDaemon({
				identity: identity({ argv: ["/opt/other-ao/ao", "daemon"] }),
				executablePath: "/opt/other-ao/ao",
				requiredExecutablePath: "/Applications/AO.app/Contents/Resources/daemon/ao",
				platform: "darwin",
			}),
		).toEqual({ verified: false, reason: "executable-mismatch" });
	});

	it("refuses an AO binary that is not running the daemon subcommand", () => {
		expect(
			verifyProcessIsAoDaemon({
				identity: identity({ argv: ["/usr/local/bin/ao", "session", "ls"] }),
				executablePath: "/usr/local/bin/ao",
				requiredExecutablePath: null,
				platform: "linux",
			}),
		).toEqual({ verified: false, reason: "not-daemon-argv" });
	});
});

// 2b (#293 cycle 2): macOS `ps -o args=` flattens argv into one whitespace-joined
// line, so a packaged binary whose path contains spaces —
// "/Applications/Agent Orchestrator.app/.../ao daemon" — split naively yields
// argv[0] === "/Applications/Agent" and the genuine daemon is rejected as
// not-daemon-argv, leaving a wedged packaged daemon impossible to replace. The
// executable path is obtained separately (`ps -o comm=`), so it can carve the
// exact argv[0] prefix back off the flattened line.
describe("parsePsArgv", () => {
	it("keeps an executable path containing spaces intact as argv[0]", () => {
		const exe = "/Applications/Agent Orchestrator.app/Contents/Resources/bin/ao";
		expect(parsePsArgv(`${exe} daemon`, exe)).toEqual([exe, "daemon"]);
		expect(argvRunsDaemonSubcommand(parsePsArgv(`${exe} daemon`, exe), "darwin")).toBe(true);
	});

	it("keeps later arguments after a space-containing executable path", () => {
		const exe = "/Applications/Agent Orchestrator.app/Contents/Resources/bin/ao";
		expect(parsePsArgv(`${exe} daemon --port 3001`, exe)).toEqual([exe, "daemon", "--port", "3001"]);
	});

	it("splits on whitespace when the executable path has no spaces", () => {
		expect(parsePsArgv("/usr/local/bin/ao daemon", "/usr/local/bin/ao")).toEqual(["/usr/local/bin/ao", "daemon"]);
	});

	it("falls back to a whitespace split when the executable path is unknown", () => {
		expect(parsePsArgv("/usr/local/bin/ao daemon", null)).toEqual(["/usr/local/bin/ao", "daemon"]);
	});

	it("falls back to a whitespace split when args do not start with the executable path", () => {
		// argv[0] need not be the executable (a re-exec, a login shell's `-zsh`).
		expect(parsePsArgv("ao daemon", "/usr/local/bin/ao")).toEqual(["ao", "daemon"]);
	});

	it("returns an empty argv when ps told us nothing", () => {
		expect(parsePsArgv("", "/usr/local/bin/ao")).toEqual([]);
		expect(parsePsArgv("   ", null)).toEqual([]);
	});
});

// Cycle-5 1a. The proof is assembled from TWO OS reads. Read them concurrently (or
// in any order, without a stability check) and they need not describe the same
// process image: a PID can re-exec BETWEEN them, so the kernel's executable answer
// can come from the old image while argv comes from the new one. Re-exec keeps the
// PID and — this is the trap — keeps /proc/<pid>/stat's start time too, so the
// start-time check CANNOT see it. The one invariant that does change across a
// re-exec is /proc/<pid>/exe, so the evidence read brackets the argv read with it.
describe("readConsistentProcessEvidence", () => {
	function readers(exePaths: (string | null)[], id: ProcessIdentity | null = identity()) {
		const seen = [...exePaths];
		return {
			readIdentity: async () => id,
			readExecutablePath: async () => (seen.length > 1 ? (seen.shift() as string | null) : seen[0]),
		};
	}

	it("reports a stable image when the kernel names the same executable either side of the argv read", async () => {
		const evidence = await readConsistentProcessEvidence(4242, readers(["/usr/local/bin/ao", "/usr/local/bin/ao"]));
		expect(evidence.imageChanged).toBe(false);
		expect(evidence.executablePath).toBe("/usr/local/bin/ao");
		expect(evidence.identity).toEqual(identity());
	});

	it("uses the LAST kernel read — the freshest evidence, closest to the signal", async () => {
		const evidence = await readConsistentProcessEvidence(4242, readers(["/usr/local/bin/ao", "/tmp/not-ao"]));
		expect(evidence.executablePath).toBe("/tmp/not-ao");
	});

	it("flags a re-exec between the two reads: the executable changed under us", async () => {
		const evidence = await readConsistentProcessEvidence(4242, readers(["/usr/local/bin/ao", "/tmp/not-ao"]));
		expect(evidence.imageChanged).toBe(true);
	});

	it("flags an image whose first kernel read failed — an unstable read is not a stable image", async () => {
		const evidence = await readConsistentProcessEvidence(4242, readers([null, "/usr/local/bin/ao"]));
		expect(evidence.imageChanged).toBe(true);
	});

	it("leaves an unreadable executable to the no-executable verdict rather than calling it a change", async () => {
		const evidence = await readConsistentProcessEvidence(4242, readers(["/usr/local/bin/ao", null]));
		expect(evidence.executablePath).toBeNull();
		expect(evidence.imageChanged).toBe(false);
	});
});

describe("an identity proof assembled across a re-exec", () => {
	// The exact inconsistent-read scenario: the executable read returns the AO
	// binary, the argv read returns daemon-mode argv, but they came from different
	// process images. Neither half is a lie; the PROOF is, because the two halves
	// describe different programs. We refuse.
	it("is refused on the port-owner path", () => {
		expect(
			verifyProcessIsAoDaemon({
				identity: identity({ argv: ["/usr/local/bin/ao", "daemon"] }),
				executablePath: "/usr/local/bin/ao",
				requiredExecutablePath: null,
				imageChanged: true,
				platform: "linux",
			}),
		).toEqual({ verified: false, reason: "image-changed" });
	});

	it("is refused on the run-file path (both authorization paths gather the same evidence)", () => {
		expect(
			verifyDaemonProcessIdentity({
				identity: identity(),
				executablePath: "/usr/local/bin/ao",
				requiredExecutablePath: null,
				imageChanged: true,
				runFileStartedAtMs: (identity().startTimeMs ?? 0) + 1_000,
				platform: "linux",
			}),
		).toEqual({ verified: false, reason: "image-changed" });
	});
});
