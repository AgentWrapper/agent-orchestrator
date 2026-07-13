// The one place the takeover path is allowed to signal a process (#293).
//
// Dependency-injected so the contract below is exercisable in vitest without
// Electron or a real process tree.
//
// THE CONTRACT, in two halves.
//
// (1) We never signal a process GROUP. `process.kill(-pid)` reaches every member of
// the group, and membership is not what we checked — at most the leader was. Daemon
// children inherit the group and other processes can be placed into it, so a group
// signal terminates processes on evidence gathered about a different process.
// Killing a group honestly would mean enumerating and authorizing every member,
// which the OS gives us no way to do; so we do not kill groups.
//
// (2) We never signal a PID unless the KERNEL ITSELF told us which executable that
// PID is running, and it is the AO binary. This holds on BOTH authorization paths,
// and both are re-checked HERE, immediately before the signal:
//
//   * "verified-ao-holder": the run-file's PID. Re-run the full identity proof
//     (kernel-reported AO binary + `daemon` subcommand argv + OS start time matching
//     this run-file's `startedAt`); anything less aborts the signal.
//   * "port-owner": something answered /healthz on the daemon port with the AO
//     service name and named this PID. Read that carefully — the PID in that body
//     is a CLAIM the responder makes about itself, not evidence about the process
//     it names. It establishes that an AO-shaped daemon is listening; it does NOT
//     establish that the named PID is that listener, or is a daemon, or even
//     exists. So we require an independent OS read of the PID: its EXECUTABLE from
//     the kernel (/proc/<pid>/exe, `ps -o comm=`) — the exact bundled binary when we
//     know it, otherwise a binary named `ao` — plus `daemon`-mode argv. If the OS
//     says nothing — Windows, an unreadable /proc entry, an exited PID — we do NOT
//     signal. "Unknown" reads as "not ours" here exactly as it does everywhere else,
//     and the caller surfaces the unverified-port-holder advisory naming the PID and
//     port instead.
//
// Cycle-4 correction (1a): the port-owner path used to check ONLY argv. argv comes
// from /proc/<pid>/cmdline, which is the process's OWN memory — any program can
// present ["/tmp/ao", "daemon"] — so a /healthz body naming such a process got it
// SIGTERMed on the strength of a string it chose for itself. The executable link is
// the kernel's answer and cannot be forged by the process; it is now required here,
// as it already was on the run-file path.
//
// What is still NOT established on the port-owner path, stated rather than glossed:
//
//   * That this PID owns the port. Node cannot read a listening socket's owning PID
//     without a native addon. A second, unrelated AO daemon on the box satisfies the
//     same proof, and a /healthz responder can name any PID it likes; if it names an
//     innocent AO daemon, that daemon is the one we SIGTERM.
//   * That this PID is the daemon of THIS handshake. There is no run-file
//     `startedAt` on this path to bind it to.
//   * That the file the kernel exec'd is genuinely our AO build. When the launch is
//     bundled we pin the exact path; otherwise we can only say the kernel exec'd a
//     binary named `ao`. Someone who can plant an `ao`-named binary the user runs is
//     already inside the trust boundary.
//
// What the kernel-executable proof DOES buy is the thing H3 is about: we no longer
// terminate a process that merely claims to be an AO daemon — the editor, database
// or build process on a recycled PID, which is what the original bug killed.
//
// Residual TOCTOU risk, stated plainly rather than papered over: the re-check and
// the kill() are separate syscalls, so a PID could in principle exit and be
// recycled — or, without exiting at all, re-exec into a different program — in the
// microseconds between them. Node exposes no PID-bound handle (Linux
// pidfd_open/pidfd_send_signal need a native addon we will not take on), so the
// window is narrowed to that gap — it is not closed. Signalling one PID rather than
// a group is also what bounds the blast radius if it ever loses that race.
//
// Cycle-5 correction (1a): the evidence itself used to be read CONCURRENTLY, so the
// proof was not even internally consistent — a re-exec between the two reads paired
// the kernel's answer about the old image with the new image's argv, and BOTH
// authorization paths did it. Evidence is now gathered by
// readConsistentProcessEvidence(): sequential, kernel-executable-bracketed, refused
// outright when the executable changes under us.
//
// Where to VERIFY that "both paths" claim, since only one of them is visible here:
// the port-owner branch below calls readConsistentProcessEvidence() directly; the
// run-file branch delegates to the injected deps.verifyIdentity, which production
// wires to verifiedDaemonIdentity() in main.ts — and THAT calls the same helper (it
// is the function that carried the original concurrent Promise.all). A reviewer who
// reads only this file cannot confirm the run-file half, so it is named here rather
// than left as an assertion you have to take on trust.
//
// What the bracketing buys, exactly: an
// inconsistent proof can now only be assembled across a re-exec of the SAME
// executable path — which, since that path must be the AO binary (the exact bundled
// path when we know it), means the worst stitched-together proof still targets an AO
// binary in some other mode, not an unrelated program. It does NOT make the proof
// atomic. A fully atomic process-identity snapshot is not achievable from Node
// (again: pidfd, or a native addon), and this code does not claim one.

import {
	readConsistentProcessEvidence,
	verifyProcessIsAoDaemon,
	type ProcessIdentity,
} from "../shared/daemon-identity";

export type DaemonSignalReason = "port-owner" | "verified-ao-holder";

export type DaemonSignalDeps = {
	/** Full identity proof of the run-file PID; null when it does not verify. */
	verifyIdentity: (pid: number) => Promise<ProcessIdentity | null>;
	/** Raw OS view of a live PID (argv, start time); null when the OS tells us nothing. */
	readIdentity: (pid: number) => Promise<ProcessIdentity | null>;
	/**
	 * The executable the KERNEL reports for a PID (/proc/<pid>/exe, `ps -o comm=`);
	 * null when it will not tell us. Unforgeable by the process, unlike argv — which
	 * is why the port-owner path is not allowed to skip it.
	 */
	readExecutablePath: (pid: number) => Promise<string | null>;
	/** The exact binary a bundled launch would have started; null when unknown. */
	requiredExecutablePath: string | null;
	/** process.kill. The target is ALWAYS a positive pid — never a negative group. */
	kill: (pid: number, signal: NodeJS.Signals) => void;
	platform: NodeJS.Platform;
	warn?: (message: string) => void;
};

/**
 * SIGTERM the single process the takeover is authorized to signal — and nothing
 * else. Returns whether a signal was actually delivered (false = we refused, or
 * the process was already gone), so the caller knows whether there is anything to
 * wait for.
 */
export async function signalVerifiedDaemon(
	pid: number,
	reason: DaemonSignalReason,
	deps: DaemonSignalDeps,
): Promise<boolean> {
	const warn = deps.warn ?? (() => {});
	if (reason === "verified-ao-holder") {
		const identity = await deps.verifyIdentity(pid);
		if (!identity) {
			warn(`AO: pid ${pid} no longer verifies as this daemon; nothing signalled.`);
			return false;
		}
	} else {
		// Both reads, always: the kernel's executable AND the process's argv. argv on
		// its own is a self-description (see the header) and never authorizes a signal.
		// Read as ONE proof (exe → argv → exe), never concurrently: a PID that re-execs
		// between two concurrent reads would pair the kernel's answer about the old image
		// with the new image's argv (cycle-5 1a).
		const evidence = await readConsistentProcessEvidence(pid, deps);
		const verdict = verifyProcessIsAoDaemon({
			...evidence,
			requiredExecutablePath: deps.requiredExecutablePath,
			platform: deps.platform,
		});
		if (!verdict.verified) {
			warn(
				`AO: a /healthz response named pid ${pid} as the daemon, but the OS does not corroborate that ` +
					`(${verdict.reason}); nothing signalled.`,
			);
			return false;
		}
	}
	try {
		// Positive pid, always: the verified process, never its process group.
		deps.kill(pid, "SIGTERM");
		return true;
	} catch {
		// Already gone; nothing to do.
		return false;
	}
}
