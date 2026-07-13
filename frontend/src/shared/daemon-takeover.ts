// Pure decision helper for the wedged-orphan kill+replace path.
//
// Context: on app launch, after both attach attempts fail (inspectExistingDaemon
// and resolveDaemonFromPort both returned null/non-ready), a process may still be
// holding the daemon port. Spawning a new daemon then makes the Go child collide
// on the port and exit 1. This helper decides what — if anything — may be
// signalled first.
//
// H3 (#293): the previous rule ("kill whatever PID running.json names, as long as
// it is alive") treated a live run-file PID as proof of port ownership. After a
// crash the run-file survives, its PID gets recycled by the OS, and the app then
// SIGTERMed an unrelated editor/database/build process AND its process group —
// destroying unsaved work while no AO daemon was even listening. Liveness of a
// recorded PID is not ownership. Neither, and this is the cycle-3 correction, is a
// PID a remote responder reports about ITSELF: a claim is not evidence.
//
// So this helper NOMINATES a candidate; it never authorizes a kill on its own. Two
// nominations exist, and main/daemon-signal.ts re-proves identity against the OS
// before either one is signalled — the signal step, not this decision, is the gate:
//
//   * "port-owner": /healthz answered on the expected port with the AO daemon's
//     service name and a PID. That establishes only that SOMETHING AO-shaped is
//     listening. The PID is self-reported, so it proves nothing about the process
//     it names; daemon-signal.ts refuses to signal it unless the OS independently
//     shows that PID running the `daemon` subcommand.
//   * "verified-ao-holder": the run-file's live PID, which the caller verified to be
//     THIS daemon — the AO binary, running the `daemon` subcommand, whose OS start
//     time agrees with the `startedAt` recorded in that same run-file (see
//     shared/daemon-identity). An `ao`-shaped executable alone is not identity.
//
// Anything else is an unverifiable stale handshake: discard it (delete the
// run-file), spawn, and let the daemon's own bind failure surface. A process we
// cannot prove is an AO daemon is never ours to kill — on Windows and an unreadable
// /proc that means we kill nothing at all and tell the user which PID to stop.
//
// Kept side-effect free and dependency-injected (no node:* or electron imports)
// so it can be exercised in vitest without the Electron polyfill layer.

import type { DaemonProbe } from "./daemon-attach";
import type { DaemonStatus } from "./daemon-status";

export type PortHolderEvidence = {
	/** A live AO daemon answering /healthz on the expected port, when one does. */
	probe: DaemonProbe | null;
	/** PID recorded in running.json, when the handshake could be read. */
	runFilePid: number | null;
	/** Whether that recorded PID is still a live process (kill(pid, 0) succeeded). */
	runFilePidAlive: boolean;
	/**
	 * Whether that live PID was verified by the caller to be the daemon this
	 * run-file describes (binary + `daemon` subcommand + start time matching the
	 * run-file's `startedAt`; see shared/daemon-identity). Callers that cannot
	 * verify — unsupported platform, unreadable /proc entry, foreign binary,
	 * contradicting start time — MUST pass false: unverified means not ours, and
	 * not ours means never signalled.
	 */
	runFilePidIsAoDaemon: boolean;
};

export type PortHolderAction =
	/** Nothing is holding the port and no handshake to clean up: spawn now. */
	| { kind: "spawn" }
	/**
	 * A candidate PID to take over from. The signal step re-proves its identity against
	 * the OS and may still refuse (then nothing is signalled and the advisory is shown);
	 * on success: SIGTERM it, wait for the port, spawn.
	 */
	| { kind: "kill"; pid: number; reason: "port-owner" | "verified-ao-holder" }
	/**
	 * The handshake cannot be trusted (dead PID, or a live PID we could not prove is
	 * an AO daemon). Signal nothing, delete the run-file, spawn, and let a genuine
	 * bind collision surface as a daemon error instead of killing a stranger.
	 */
	| { kind: "discard-stale-handshake" };

/**
 * Decide what to do about a possible holder of the daemon port. Called only after
 * both attach paths (run-file and direct port probe) declined to attach.
 */
export function decidePortHolderAction(evidence: PortHolderEvidence): PortHolderAction {
	const { probe, runFilePid, runFilePidAlive, runFilePidIsAoDaemon } = evidence;

	// An answering /healthz proves that an AO-shaped daemon is listening (service
	// name) — a fresher fact than the run-file, so prefer it. The PID it carries is
	// the responder's claim about itself, NOT proof that that PID is the listener, so
	// this is a nomination only: signalVerifiedDaemon() will refuse it unless the OS
	// independently confirms the PID is running the daemon.
	if (probe) return { kind: "kill", pid: probe.pid, reason: "port-owner" };

	if (runFilePid === null) return { kind: "spawn" };
	if (!runFilePidAlive) return { kind: "discard-stale-handshake" };
	if (runFilePidIsAoDaemon) return { kind: "kill", pid: runFilePid, reason: "verified-ao-holder" };

	// Live PID, no AO evidence: a recycled PID belonging to someone else's process.
	return { kind: "discard-stale-handshake" };
}

/**
 * The recovery instruction for a process we refused to signal (#293, cycle-2 2c).
 *
 * Failing closed is right — an unverifiable process is never killed — but it must
 * not fail SILENTLY. When a live process could not be proved to be our daemon we
 * delete the run-file and spawn anyway; if that process really was holding the
 * port, the replacement dies on bind and the user sees only "Daemon exited with
 * code 1". Windows hits this on EVERY wedged daemon (no /proc, no identity
 * evidence, so verification can never succeed there). Name the PID and the port so
 * the user can clear it themselves.
 *
 * Returns null when there is no live PID to name — then the ordinary daemon error
 * is the whole story.
 */
export function unverifiedPortHolderAdvisory(input: { pid: number | null; port: number }): string | null {
	const { pid, port } = input;
	if (pid === null || !Number.isInteger(pid) || pid <= 0) return null;
	return (
		`A process (pid ${pid}) may still be holding the AO daemon port ${port}, but it could not be verified ` +
		`as an AO daemon, so AO did not stop it. Stop pid ${pid} yourself, then start the daemon again.`
	);
}

/** Attach the advisory (when there is one) to the daemon failure the user sees. */
export function withTakeoverAdvisory(message: string, advisory: string | null): string {
	return advisory ? `${message} ${advisory}` : message;
}

const PORT_UNCONFIRMED_MESSAGE = "Daemon port not confirmed from logs or running.json; assuming the configured port.";

/**
 * The status for the last-resort path: the spawned daemon is still alive, but the
 * port-discovery timeout expired without either confirmed source (a "daemon
 * listening" log line, a fresh running.json), so we report the CONFIGURED port to
 * get the renderer off "starting".
 *
 * This "ready" is a guess, and that is why the advisory belongs in it (cycle-5 1b).
 * The advisory is cleared exactly once — in reportBoundPort, where an OBSERVED bind
 * proves the port was free and therefore that the process we declined to signal was
 * not in the way. Nothing is observed here. A refused takeover's PID may well still
 * hold the port, with our child alive but unable to serve, and this banner is the
 * user's chance to be told which PID to stop; dropping the advisory would leave them
 * with a bare "port not confirmed" and no recovery instruction. For the same reason
 * the caller must NOT clear the advisory here: it is still live, so a subsequent exit
 * that appends it is repeating current advice, not stale advice.
 */
export function portUnconfirmedReadyStatus(port: number, advisory: string | null): DaemonStatus {
	return {
		state: "ready",
		port,
		message: withTakeoverAdvisory(PORT_UNCONFIRMED_MESSAGE, advisory),
		code: "port_unconfirmed",
	};
}
