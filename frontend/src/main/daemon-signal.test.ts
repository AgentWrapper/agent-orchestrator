// @vitest-environment node
//
// The takeover signal path (#293, cycle-2 1b). The contract this file exists to
// pin down: the takeover NEVER group-signals. `process.kill(-pid)` reaches every
// member of a process group, and only the leader's identity was ever verified —
// a daemon child that inherited the group, or any other process placed into it,
// would be signalled on evidence that was never gathered about it. So the only
// target we ever pass to kill() is the single verified PID, always positive.
import { describe, expect, it, vi } from "vitest";
import { signalVerifiedDaemon, type DaemonSignalDeps } from "./daemon-signal";
import type { ProcessIdentity } from "../shared/daemon-identity";

const DAEMON_PID = 4242;

function daemonIdentity(overrides: Partial<ProcessIdentity> = {}): ProcessIdentity {
	return {
		pid: DAEMON_PID,
		startTimeMs: Date.UTC(2026, 6, 12, 1, 0, 0),
		argv: ["/usr/local/bin/ao", "daemon"],
		...overrides,
	};
}

function deps(overrides: Partial<DaemonSignalDeps> = {}): DaemonSignalDeps {
	return {
		verifyIdentity: vi.fn(async () => daemonIdentity()),
		readIdentity: vi.fn(async () => daemonIdentity()),
		readExecutablePath: vi.fn(async () => "/usr/local/bin/ao"),
		requiredExecutablePath: null,
		kill: vi.fn(),
		platform: "linux",
		warn: vi.fn(),
		...overrides,
	};
}

describe("signalVerifiedDaemon", () => {
	it("signals exactly the verified PID (never a process group) when the run-file PID verifies", async () => {
		const d = deps();
		await expect(signalVerifiedDaemon(DAEMON_PID, "verified-ao-holder", d)).resolves.toBe(true);
		expect(d.kill).toHaveBeenCalledTimes(1);
		expect(d.kill).toHaveBeenCalledWith(DAEMON_PID, "SIGTERM");
	});

	it("signals a port-owner PID only once the OS itself confirms it is running the daemon", async () => {
		const d = deps();
		await expect(signalVerifiedDaemon(DAEMON_PID, "port-owner", d)).resolves.toBe(true);
		expect(d.readIdentity).toHaveBeenCalledWith(DAEMON_PID);
		expect(d.kill).toHaveBeenCalledWith(DAEMON_PID, "SIGTERM");
	});

	// The 1b over-reach: an earlier iteration group-signalled whenever the verified
	// daemon led its own process group, reasoning that the group then "contains
	// nothing we did not verify". False — leadership says nothing about MEMBERSHIP:
	// daemon children inherit the group, and other processes can be placed into it.
	// Whatever the OS reports about the process, the signal target must be the
	// positive verified PID.
	it("never passes a negative (process-group) target to kill, on any authorized path", async () => {
		for (const reason of ["verified-ao-holder", "port-owner"] as const) {
			const d = deps();
			await signalVerifiedDaemon(DAEMON_PID, reason, d);
			for (const [target] of vi.mocked(d.kill).mock.calls) {
				expect(target).toBe(DAEMON_PID);
				expect(target).toBeGreaterThan(0);
			}
		}
	});

	it("aborts when the run-file PID no longer verifies as this daemon (TOCTOU re-check)", async () => {
		const d = deps({ verifyIdentity: vi.fn(async () => null) });
		await expect(signalVerifiedDaemon(DAEMON_PID, "verified-ao-holder", d)).resolves.toBe(false);
		expect(d.kill).not.toHaveBeenCalled();
	});

	it("aborts when the port-owner PID is now running something that is not the daemon", async () => {
		const d = deps({
			readIdentity: vi.fn(async () => daemonIdentity({ argv: ["/usr/bin/psql", "-d", "app"] })),
		});
		await expect(signalVerifiedDaemon(DAEMON_PID, "port-owner", d)).resolves.toBe(false);
		expect(d.kill).not.toHaveBeenCalled();
	});

	// H3, cycle-3. The earlier iteration signalled here, reasoning that the PID came
	// from the daemon's own /healthz body and so needed no OS corroboration. That is
	// the ORIGINAL H3 bug in a new costume: the PID in that body is a CLAIM made by
	// whatever answered the port, not evidence about the PID it names. A racing
	// responder that reports `{status:"ok", service:"agent-orchestrator-daemon",
	// pid:<unrelated-pid>}` would have had that unrelated process SIGTERMed. The OS —
	// not the responder — is the only witness we accept, so an absent OS answer means
	// no signal.
	it("refuses to signal a port-owner PID when the OS discloses no identity (Windows)", async () => {
		const d = deps({ readIdentity: vi.fn(async () => null), platform: "win32" });
		await expect(signalVerifiedDaemon(DAEMON_PID, "port-owner", d)).resolves.toBe(false);
		expect(d.kill).not.toHaveBeenCalled();
		expect(d.warn).toHaveBeenCalled();
	});

	it("refuses to signal a port-owner PID when /proc is unreadable", async () => {
		const d = deps({ readIdentity: vi.fn(async () => null) });
		await expect(signalVerifiedDaemon(DAEMON_PID, "port-owner", d)).resolves.toBe(false);
		expect(d.kill).not.toHaveBeenCalled();
	});

	// H3, cycle-4 (1a). argv is PROCESS-supplied: /proc/<pid>/cmdline is a buffer the
	// process itself owns, so anything can present argv ["/tmp/ao", "daemon"]. The
	// argv-only check therefore authorized a SIGTERM against a process whose only
	// credential was a string it chose. The executable link is the kernel's own
	// answer, and it is now required.
	it("refuses a port-owner PID whose argv claims `ao daemon` but whose executable is not the AO binary", async () => {
		const d = deps({
			readIdentity: vi.fn(async () => daemonIdentity({ argv: ["/tmp/ao", "daemon"] })),
			readExecutablePath: vi.fn(async () => "/usr/bin/python3"),
		});
		await expect(signalVerifiedDaemon(DAEMON_PID, "port-owner", d)).resolves.toBe(false);
		expect(d.readExecutablePath).toHaveBeenCalledWith(DAEMON_PID);
		expect(d.kill).not.toHaveBeenCalled();
		expect(d.warn).toHaveBeenCalled();
	});

	it("refuses a port-owner PID when the kernel discloses no executable for it", async () => {
		const d = deps({ readExecutablePath: vi.fn(async () => null) });
		await expect(signalVerifiedDaemon(DAEMON_PID, "port-owner", d)).resolves.toBe(false);
		expect(d.kill).not.toHaveBeenCalled();
	});

	it("refuses a port-owner PID running a different AO installation when the bundled binary is known", async () => {
		const d = deps({
			readExecutablePath: vi.fn(async () => "/opt/other-ao/ao"),
			requiredExecutablePath: "/Applications/AO.app/Contents/Resources/daemon/ao",
		});
		await expect(signalVerifiedDaemon(DAEMON_PID, "port-owner", d)).resolves.toBe(false);
		expect(d.kill).not.toHaveBeenCalled();
	});

	it("refuses to signal a port-owner PID whose argv the OS returns empty", async () => {
		const d = deps({ readIdentity: vi.fn(async () => daemonIdentity({ argv: [] })) });
		await expect(signalVerifiedDaemon(DAEMON_PID, "port-owner", d)).resolves.toBe(false);
		expect(d.kill).not.toHaveBeenCalled();
	});

	it("never signals on any path without a completed OS identity proof", async () => {
		for (const reason of ["verified-ao-holder", "port-owner"] as const) {
			const d = deps({
				verifyIdentity: vi.fn(async () => null),
				readIdentity: vi.fn(async () => null),
			});
			await expect(signalVerifiedDaemon(DAEMON_PID, reason, d)).resolves.toBe(false);
			expect(d.kill).not.toHaveBeenCalled();
		}
	});

	it("reports failure when the process is already gone", async () => {
		const d = deps({
			kill: vi.fn(() => {
				throw new Error("ESRCH");
			}),
		});
		await expect(signalVerifiedDaemon(DAEMON_PID, "verified-ao-holder", d)).resolves.toBe(false);
	});
});

// Cycle-5 1a. The port-owner proof is assembled from two OS reads. Read them
// concurrently and they need not describe the same process image: the PID can
// re-exec between them, pairing the kernel's answer about the OLD image with the
// NEW image's (process-controlled) argv. The reads are now sequential and bracketed
// by the kernel's executable answer, so an executable that changes under us is
// refused instead of being SIGTERMed on a proof stitched from two programs.
describe("signalVerifiedDaemon and the inconsistent identity proof", () => {
	function reExecDeps(exePaths: string[], overrides: Partial<DaemonSignalDeps> = {}): DaemonSignalDeps {
		const remaining = [...exePaths];
		return deps({
			// argv says `ao daemon` throughout — it is the process's own story, and the
			// story does not change just because the program did.
			readIdentity: vi.fn(async () => daemonIdentity()),
			readExecutablePath: vi.fn(async () => (remaining.length > 1 ? (remaining.shift() as string) : remaining[0])),
			...overrides,
		});
	}

	it("refuses when the kernel's executable changes across the reads (the proof spans two images)", async () => {
		const d = reExecDeps(["/usr/local/bin/ao", "/tmp/not-ao"]);
		await expect(signalVerifiedDaemon(DAEMON_PID, "port-owner", d)).resolves.toBe(false);
		expect(d.kill).not.toHaveBeenCalled();
	});

	// The mirror image: the process was something else when we looked, and had
	// re-exec'd into an `ao`-named binary by the second read. The freshest kernel
	// evidence would accept it, but the argv we hold was read from the OTHER image,
	// so the proof is still stitched together — refuse.
	it("refuses when the kernel's executable changes INTO the AO binary between the reads", async () => {
		const d = reExecDeps(["/tmp/not-ao", "/usr/local/bin/ao"]);
		await expect(signalVerifiedDaemon(DAEMON_PID, "port-owner", d)).resolves.toBe(false);
		expect(d.kill).not.toHaveBeenCalled();
	});

	it("reads the kernel's executable both before and after argv (the argv read is bracketed)", async () => {
		const d = reExecDeps(["/usr/local/bin/ao", "/usr/local/bin/ao"]);
		await expect(signalVerifiedDaemon(DAEMON_PID, "port-owner", d)).resolves.toBe(true);
		expect(d.readExecutablePath).toHaveBeenCalledTimes(2);
		expect(d.readIdentity).toHaveBeenCalledTimes(1);
	});
});
