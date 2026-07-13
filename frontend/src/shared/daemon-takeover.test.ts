// Unit tests for the wedged-orphan takeover decision. Run with:
//   cd frontend && npx vitest run src/shared/daemon-takeover.test.ts
import { describe, expect, it } from "vitest";
import { DAEMON_SERVICE_NAME, type DaemonProbe } from "./daemon-attach";
import {
	decidePortHolderAction,
	portUnconfirmedReadyStatus,
	unverifiedPortHolderAdvisory,
	withTakeoverAdvisory,
	type PortHolderEvidence,
} from "./daemon-takeover";

// A minimal valid DaemonProbe (non-null means the AO daemon answered /healthz).
const healthyProbe: DaemonProbe = {
	status: "ok",
	service: DAEMON_SERVICE_NAME,
	pid: 1234,
};

function evidence(overrides: Partial<PortHolderEvidence> = {}): PortHolderEvidence {
	return {
		probe: null,
		runFilePid: null,
		runFilePidAlive: false,
		runFilePidIsAoDaemon: false,
		...overrides,
	};
}

describe("decidePortHolderAction", () => {
	it("kills the port owner the AO daemon health probe reports (service/PID identity)", () => {
		expect(decidePortHolderAction(evidence({ probe: healthyProbe }))).toEqual({
			kind: "kill",
			pid: 1234,
			reason: "port-owner",
		});
		// Even when the run-file names a different PID, the verified port owner wins:
		// the run-file PID is never the thing we signal on this path.
		expect(decidePortHolderAction(evidence({ probe: healthyProbe, runFilePid: 777, runFilePidAlive: true }))).toEqual({
			kind: "kill",
			pid: 1234,
			reason: "port-owner",
		});
	});

	it("kills a live run-file PID only once it is verified to be an AO daemon executable", () => {
		expect(
			decidePortHolderAction(evidence({ runFilePid: 4321, runFilePidAlive: true, runFilePidIsAoDaemon: true })),
		).toEqual({ kind: "kill", pid: 4321, reason: "verified-ao-holder" });
	});

	// H3 (#293): a stale running.json whose PID has been recycled by an unrelated
	// process (editor, database, build). Nothing answers the daemon port, so there
	// is no evidence the live PID owns it — signalling it would kill the innocent
	// process and its whole group. Discard the handshake and let the spawn's bind
	// failure surface instead.
	it("never signals a live run-file PID that is not a verified AO daemon (recycled PID)", () => {
		expect(decidePortHolderAction(evidence({ runFilePid: 4321, runFilePidAlive: true }))).toEqual({
			kind: "discard-stale-handshake",
		});
	});

	it("discards a stale handshake whose PID is dead", () => {
		expect(decidePortHolderAction(evidence({ runFilePid: 4321 }))).toEqual({ kind: "discard-stale-handshake" });
	});

	it("spawns immediately when there is no handshake and nothing answers the port", () => {
		expect(decidePortHolderAction(evidence())).toEqual({ kind: "spawn" });
	});
});

// 2c (#293 cycle 2): failing closed is right — an unverifiable process is never
// signalled — but the user was then left with a bare "Daemon exited with code 1"
// after the replacement collided on the still-occupied port. Windows (no identity
// evidence at all) hits this on every wedged daemon. Refusing to kill must not
// also mean refusing to explain: name the PID and the port so the user can clear
// it themselves.
describe("unverifiedPortHolderAdvisory", () => {
	it("names the PID and the port so the user can recover manually", () => {
		const advisory = unverifiedPortHolderAdvisory({ pid: 4321, port: 3001 });
		expect(advisory).toContain("4321");
		expect(advisory).toContain("3001");
		expect(advisory).toMatch(/could not be verified/i);
		expect(advisory).toMatch(/stop/i);
	});

	it("says nothing when there is no live process to name", () => {
		expect(unverifiedPortHolderAdvisory({ pid: null, port: 3001 })).toBeNull();
		expect(unverifiedPortHolderAdvisory({ pid: 0, port: 3001 })).toBeNull();
	});
});

describe("withTakeoverAdvisory", () => {
	it("appends the advisory to the daemon failure the user actually sees", () => {
		const advisory = unverifiedPortHolderAdvisory({ pid: 4321, port: 3001 });
		const message = withTakeoverAdvisory("Daemon exited with code 1", advisory);
		expect(message).toContain("Daemon exited with code 1");
		expect(message).toContain("4321");
	});

	it("leaves the message untouched when there is no advisory", () => {
		expect(withTakeoverAdvisory("Daemon exited with code 1", null)).toBe("Daemon exited with code 1");
	});
});

// Cycle-5 1b. The fallback "ready" is the path where NOTHING confirmed the port:
// no listening line, no running.json. It is not authoritative, so it must not drop
// the advisory that names the PID a refused takeover left holding the port — that
// advisory is the user's only recovery instruction.
describe("portUnconfirmedReadyStatus", () => {
	it("carries the takeover advisory into the unconfirmed-port banner", () => {
		const advisory = unverifiedPortHolderAdvisory({ pid: 4321, port: 3001 });
		const status = portUnconfirmedReadyStatus(3001, advisory);
		expect(status).toEqual({
			state: "ready",
			port: 3001,
			code: "port_unconfirmed",
			message: expect.stringContaining("not confirmed"),
		});
		expect(status.message).toContain("4321");
		expect(status.message).toContain("3001");
	});

	it("reports only the unconfirmed port when no takeover was refused", () => {
		const status = portUnconfirmedReadyStatus(3001, null);
		expect(status.message).toContain("not confirmed");
		expect(status.message).not.toContain("pid");
	});
});
