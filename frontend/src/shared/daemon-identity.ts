// Daemon process identity (H3 follow-up, #293).
//
// The takeover path may only signal a process whose identity as *the daemon this
// running.json describes* is established. An earlier iteration accepted any live
// executable whose basename was `ao` — which an ordinary `ao status` CLI call, or
// a second AO installation, satisfies just as well as the daemon does. Worse, it
// then signalled the whole process GROUP (`kill(-pid)`) although only the PID was
// ever checked.
//
// What the OS tells us about a PID, and what we therefore require. Note which of
// these the KERNEL asserts and which the PROCESS merely claims — they are not the
// same kind of evidence, and an earlier iteration treated them as if they were:
//
//   1. executable (Linux /proc/<pid>/exe, macOS `ps -o comm=`): KERNEL-asserted.
//      The link points at the image the kernel actually exec'd; a process cannot
//      rewrite it. We require it to be the AO binary — and, when the caller knows
//      the exact binary it would have launched (a bundled app), to be that path.
//   2. argv (Linux /proc/<pid>/cmdline, macOS `ps -o args=`): PROCESS-supplied.
//      /proc/<pid>/cmdline is a region of the process's own memory; any program can
//      present argv ["/usr/local/bin/ao", "daemon"] without being the AO binary. So
//      argv is never identity on its own. What it adds ON TOP of the kernel's
//      executable answer is WHICH MODE the AO binary is in: only `ao daemon` writes
//      running.json (backend/internal/httpd/server.go → runfile.Write), so an
//      `ao status` CLI call does not pass. (An AO binary lying about its own argv is
//      not in the threat model: it is our binary either way.)
//   3. start time (Linux: /proc/<pid>/stat field 22, ticks since boot, plus
//      /proc/stat's btime; macOS: `ps -o lstart=`) compared against the
//      `startedAt` the daemon itself recorded in running.json. This is the bit
//      that binds the PID to *this* handshake: a recycled PID belongs to a
//      process that started long after the crashed daemon recorded its start.
//      Only the run-file path has a `startedAt` to bind against; see
//      verifyProcessIsAoDaemon for what the port-owner path does and does not get.
//
// What we deliberately do NOT do: signal a process GROUP. An earlier fix tried to
// authorize `kill(-pid)` whenever the verified daemon led its own group, on the
// theory that leadership means the group holds nothing unverified. That is false:
// leadership is not membership. Children the daemon forked inherit the group, and
// any process in the session can be placed into it — none of them were verified.
// So there is no process-group id here and no group plan: the takeover signals the
// single PID it proved, and nothing else. (Group termination would require
// enumerating every member and authorizing each one independently, which the OS
// gives us no honest way to do.)
//
// Residual risk we do NOT paper over: every check below is a separate syscall, and
// the eventual `process.kill()` is another one. A PID can exit and be recycled
// between the evidence and the signal. Node exposes no PID-bound handle (Linux
// pidfd_open/pidfd_send_signal are unreachable without a native addon), so this
// window is NARROWED — re-verified immediately before the signal — not CLOSED.
//
// A SECOND way the image can change under us, distinct from PID recycling and
// initially missed (cycle-5 1a): `execve()`. A live PID can swap the program it runs
// without exiting, so evidence read at two moments can describe two different
// programs. Note what this does to check (3): a re-exec preserves the process's start
// time (it is set at fork, not at exec), so the start-time check is BLIND to it —
// start time detects a recycled PID, never a re-exec'd one. The only invariant that
// moves on a re-exec is the kernel's executable link, so the evidence read brackets
// argv with it; see readConsistentProcessEvidence for exactly what that does and
// does not establish. A re-exec occurring after the last read is plain TOCTOU and is
// no more closable than the recycling window above.
//
// Pure and dependency-free (no node:* imports — vite-plugin-electron-renderer's
// polyfill breaks those under vitest); the Electron main process does the I/O.

/** What we can learn about a live process from the OS. */
export type ProcessIdentity = {
	pid: number;
	/** Absolute wall-clock start time (epoch ms), or null when unknown. */
	startTimeMs: number | null;
	/** Full argv, argv[0] first. Empty when the OS gave us nothing. */
	argv: string[];
};

/** Linux USER_HZ. Fixed at 100 on every supported architecture. */
export const LINUX_CLOCK_TICKS_PER_SECOND = 100;

/**
 * How much *later* than the recorded `startedAt` a process may have started and
 * still be believed. Normally negative (the daemon starts, then records), so this
 * only absorbs clock granularity: /proc/stat's btime has second resolution and the
 * derived start time is therefore accurate to about a second.
 */
export const DAEMON_START_SKEW_MS = 5_000;

/**
 * How much *earlier* than the recorded `startedAt` a process may have started.
 * The daemon writes running.json right after it binds its listener, so the gap is
 * its own init (config, migrations) — seconds, generously bounded at five minutes.
 * Anything older is a different process that happens to hold the PID.
 */
export const DAEMON_START_MAX_INIT_MS = 300_000;

/**
 * Parse /proc/<pid>/stat. Field 2 (comm) is parenthesized and may itself contain
 * spaces and parens, so the only safe anchor is the LAST ')'. Returns field 22
 * (starttime, in clock ticks since boot).
 */
export function parseProcStat(contents: string): { startTimeTicks: number } | null {
	const close = contents.lastIndexOf(")");
	if (close === -1) return null;
	const fields = contents
		.slice(close + 1)
		.trim()
		.split(/\s+/);
	// fields[0] is field 3 (state), so field N lives at fields[N - 3].
	const startTimeTicks = Number(fields[19]);
	if (!Number.isFinite(startTimeTicks) || startTimeTicks < 0) return null;
	return { startTimeTicks };
}

/** Parse the `btime <epoch-seconds>` line of /proc/stat into epoch ms. */
export function parseProcBootTimeMs(contents: string): number | null {
	const match = /^btime\s+(\d+)\s*$/m.exec(contents);
	if (!match) return null;
	const seconds = Number(match[1]);
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** Absolute start time of a process from its ticks-since-boot and the boot time. */
export function procStartTimeMs(
	bootTimeMs: number,
	startTimeTicks: number,
	ticksPerSecond: number = LINUX_CLOCK_TICKS_PER_SECOND,
): number | null {
	if (!Number.isFinite(bootTimeMs) || bootTimeMs <= 0) return null;
	if (!Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) return null;
	if (!Number.isFinite(startTimeTicks) || startTimeTicks < 0) return null;
	return Math.round(bootTimeMs + (startTimeTicks / ticksPerSecond) * 1000);
}

/** Parse macOS `ps -o lstart=` ("Sun Jul 12 09:15:04 2026") into epoch ms. */
export function parsePsStartTimeMs(lstart: string): number | null {
	const parsed = Date.parse(lstart.trim());
	return Number.isNaN(parsed) ? null : parsed;
}

/** Split the NUL-delimited /proc/<pid>/cmdline into argv. */
export function parseProcCmdline(contents: string): string[] {
	return contents.split("\0").filter((arg) => arg !== "");
}

/**
 * Recover argv from macOS `ps -o args=`, which flattens the real argv into one
 * whitespace-joined line and destroys its boundaries. A blind whitespace split
 * therefore mangles any argv[0] containing spaces — the packaged path
 * "/Applications/Agent Orchestrator.app/Contents/Resources/bin/ao" becomes
 * "/Applications/Agent", and the genuine daemon is rejected as not-daemon-argv,
 * making a wedged packaged daemon impossible to replace.
 *
 * `ps -o comm=` gives the executable path separately, so when the flattened line
 * starts with it we carve off exactly that prefix and only split the remainder.
 * (`comm` and argv[0] can legitimately differ — a re-exec, a login shell's
 * "-zsh"; then we fall back to the whitespace split, which is what argv[0] would
 * look like anyway.) Boundaries inside LATER arguments are still lost; nothing we
 * check depends on them.
 */
export function parsePsArgv(args: string, executablePath: string | null): string[] {
	const line = args.trim();
	if (line === "") return [];
	if (executablePath && line.startsWith(executablePath)) {
		const rest = line.slice(executablePath.length);
		// Must end at a real boundary: a bare prefix match could be a longer path
		// (".../ao-old daemon" starts with ".../ao").
		if (rest === "" || /^\s/.test(rest)) {
			return [
				executablePath,
				...rest
					.trim()
					.split(/\s+/)
					.filter((arg) => arg !== ""),
			];
		}
	}
	return line.split(/\s+/).filter((arg) => arg !== "");
}

function basename(value: string): string {
	const separator = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
	return separator === -1 ? value : value.slice(separator + 1);
}

/** The daemon binary's name — matches shared/daemon-launch's bundled name. */
function daemonBinaryName(platform: NodeJS.Platform): string {
	return platform === "win32" ? "ao.exe" : "ao";
}

/**
 * Is the executable the KERNEL reports for this PID the AO binary?
 *
 * This is the check argv cannot make. /proc/<pid>/cmdline is process-supplied — a
 * program can present any argv it likes, including ["/tmp/ao", "daemon"] — whereas
 * /proc/<pid>/exe (and macOS `ps -o comm=`) is the image the kernel exec'd. Callers
 * that know the exact binary they would have launched should ALSO pin that path
 * (see requiredExecutablePath); this name check is the floor for callers that do
 * not, and it is what a dev/configured launch has.
 *
 * Honest about its own strength: matching the name `ao` says the kernel exec'd a
 * file called `ao` — it does not attest to that file's CONTENTS. Anyone who can
 * write an `ao`-named binary the user then runs is already inside the trust
 * boundary. What it does close is the impostor that merely SAYS it is `ao daemon`.
 */
export function executablePathIsDaemonBinary(
	executablePath: string | null,
	platform: NodeJS.Platform,
): executablePath is string {
	if (!executablePath) return false;
	return basename(executablePath).toLowerCase() === daemonBinaryName(platform).toLowerCase();
}

/**
 * Does this argv show the AO binary running the daemon? Only `ao daemon` writes
 * running.json, so the subcommand — not the binary name — is what separates the
 * daemon from an `ao status` CLI call that happens to be alive on a recycled PID.
 * Only the FIRST non-flag token counts, so "daemon" appearing later (e.g. inside a
 * message body) proves nothing.
 *
 * argv is a CLAIM the process makes about itself; on its own it is not identity.
 * It is only ever consumed alongside executablePathIsDaemonBinary().
 */
export function argvRunsDaemonSubcommand(argv: string[], platform: NodeJS.Platform): boolean {
	if (argv.length < 2) return false;
	if (basename(argv[0]).toLowerCase() !== daemonBinaryName(platform).toLowerCase()) return false;
	const subcommand = argv.slice(1).find((arg) => !arg.startsWith("-"));
	return subcommand === "daemon";
}

/**
 * Does the process's real start time agree with the `startedAt` the daemon wrote
 * into running.json? This is what binds a PID to a specific handshake: after a
 * crash the run-file survives and the OS hands its PID to a process that started
 * much later, which lands outside the window.
 */
export function startTimeMatchesRunFile(procStartMs: number | null, runFileStartedAtMs: number): boolean {
	if (procStartMs === null || !Number.isFinite(procStartMs) || procStartMs <= 0) return false;
	if (!Number.isFinite(runFileStartedAtMs) || runFileStartedAtMs <= 0) return false;
	const initGap = runFileStartedAtMs - procStartMs;
	return initGap >= -DAEMON_START_SKEW_MS && initGap <= DAEMON_START_MAX_INIT_MS;
}

export type ProcessIdentityEvidence = {
	/** What the OS told us about the PID; null when it told us nothing. */
	identity: ProcessIdentity | null;
	/** The executable the KERNEL reports (/proc/<pid>/exe, `ps -o comm=`). */
	executablePath: string | null;
	/** The exact binary we expect (bundled launches know it); null when we don't. */
	requiredExecutablePath: string | null;
	/**
	 * Did the kernel's executable answer change WHILE we were gathering the rest of
	 * the evidence? True means the two halves of the proof describe different process
	 * images and the proof is void — see readConsistentProcessEvidence. Absent on
	 * hand-built evidence (pure unit tests), which is a single consistent snapshot by
	 * construction.
	 */
	imageChanged?: boolean;
	platform: NodeJS.Platform;
};

export type DaemonIdentityEvidence = ProcessIdentityEvidence & {
	/** `startedAt` from running.json, epoch ms (0 when absent). */
	runFileStartedAtMs: number;
};

export type DaemonIdentityVerdict = {
	verified: boolean;
	reason:
		| "verified"
		| "no-process-identity"
		| "no-executable"
		| "image-changed"
		| "executable-mismatch"
		| "not-daemon-argv"
		| "start-time-mismatch";
};

/** The two OS reads the proof is built from. Injected so the order is testable. */
export type ProcessEvidenceReaders = {
	/** argv + start time (/proc/<pid>/cmdline + stat, `ps`). Process-supplied argv. */
	readIdentity: (pid: number) => Promise<ProcessIdentity | null>;
	/** The kernel's own answer (/proc/<pid>/exe, `ps -o comm=`). Unforgeable. */
	readExecutablePath: (pid: number) => Promise<string | null>;
};

/**
 * Gather the identity evidence for a PID as ONE proof rather than two unrelated
 * reads (cycle-5 1a).
 *
 * The problem this exists to solve: the evidence used to be read CONCURRENTLY
 * (Promise.all of the exe read and the argv read). Nothing then tied the two answers
 * to the same process image. A PID can `execve()` between them — no exit, no PID
 * reuse, just a new program in the same process — and the resulting "proof" pairs
 * the kernel's answer about the OLD image with the NEW image's argv. Neither read
 * lies; the PROOF does, because its halves describe different programs.
 *
 * What can and cannot detect that, stated precisely:
 *
 *   * START TIME CANNOT. /proc/<pid>/stat field 22 is set when the process is
 *     forked and `execve()` does NOT reset it. It detects PID REUSE (a different
 *     process on the same number) and nothing else. It is blind to a re-exec, so it
 *     is not the invariant to re-read here.
 *   * THE KERNEL'S EXECUTABLE LINK CAN, and it is the only thing available to us
 *     that can: /proc/<pid>/exe follows the image the kernel actually exec'd, so a
 *     re-exec changes it (unless the process re-execs the very same file path).
 *
 * So we read SEQUENTIALLY and bracket the argv read with the kernel's answer:
 * exe → argv/start-time → exe. The verdict then uses the LAST exe read (the freshest
 * unforgeable evidence, closest to the kill) and refuses outright when the two exe
 * reads disagree. Order matters: the strong, kernel-asserted half is what we read
 * last, so the half that can go stale first is argv — the half we already refuse to
 * treat as identity on its own.
 *
 * What this establishes: any image change that this proof can be assembled ACROSS is
 * one where the kernel reported the SAME executable path before and after. What it
 * does NOT establish: that no re-exec happened at all. A process that re-execs the
 * same path (or exits and is replaced by one running the same path, which the
 * run-file path's start-time check would still catch) is invisible here. That
 * residue means the worst inconsistent proof we can still assemble is one about a
 * binary at the AO path — an `ao` binary in some other mode, not an arbitrary
 * program. It is NOT a claim that the proof is atomic; Node has no way to make it
 * atomic, and we do not pretend otherwise.
 */
export async function readConsistentProcessEvidence(
	pid: number,
	readers: ProcessEvidenceReaders,
): Promise<{ identity: ProcessIdentity | null; executablePath: string | null; imageChanged: boolean }> {
	const executableBefore = await readers.readExecutablePath(pid);
	const identity = await readers.readIdentity(pid);
	const executablePath = await readers.readExecutablePath(pid);
	// A failed LAST read is "the OS told us nothing" — the no-executable verdict, not
	// a change. A failed FIRST read is different: we have no stable baseline to
	// compare against, so the image is not established as stable and we fail closed.
	const imageChanged = executablePath !== null && executableBefore !== executablePath;
	return { identity, executablePath, imageChanged };
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
	return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Is this live PID an AO daemon process AT ALL — kernel-confirmed executable, in
 * `daemon` mode? This is the whole proof available on the port-owner path, where
 * there is no run-file to bind to.
 *
 * States exactly what it establishes: the kernel exec'd the AO binary (the exact
 * bundled path when the caller knows it, otherwise a binary named `ao`) and that
 * binary's argv puts it in daemon mode. That is enough to say "this PID is an AO
 * daemon"; it is NOT enough to say "this PID is THE daemon holding our port". Two
 * gaps remain, and no OS call available to us closes either:
 *
 *   * Port ownership is unproved. Node cannot read a listening socket's owning PID
 *     without a native addon, so a second, unrelated AO daemon on the box satisfies
 *     this proof exactly as the port holder would.
 *   * Handshake binding is unproved. Without a run-file `startedAt` there is
 *     nothing to tie this PID to the daemon we are trying to replace.
 *
 * verifyDaemonProcessIdentity() closes the second gap with the start-time check;
 * the first is closed by nothing we have. Callers must not describe this verdict as
 * more than it is.
 */
export function verifyProcessIsAoDaemon(evidence: ProcessIdentityEvidence): DaemonIdentityVerdict {
	const { identity, executablePath, requiredExecutablePath, imageChanged, platform } = evidence;
	if (!identity) return { verified: false, reason: "no-process-identity" };
	if (!executablePath) return { verified: false, reason: "no-executable" };
	// The proof must describe ONE process image. When the kernel named a different
	// executable before and after we read argv, the PID re-exec'd under us and the two
	// halves came from different programs — an internally inconsistent proof authorizes
	// nothing, however good each half looks alone (cycle-5 1a).
	if (imageChanged) return { verified: false, reason: "image-changed" };
	// The kernel's answer first: argv is the process's own story about itself and is
	// worthless until the executable behind it is the AO binary.
	if (!executablePathIsDaemonBinary(executablePath, platform)) {
		return { verified: false, reason: "executable-mismatch" };
	}
	if (requiredExecutablePath && !samePath(executablePath, requiredExecutablePath, platform)) {
		return { verified: false, reason: "executable-mismatch" };
	}
	if (!argvRunsDaemonSubcommand(identity.argv, platform)) return { verified: false, reason: "not-daemon-argv" };
	return { verified: true, reason: "verified" };
}

/**
 * Is this live PID the daemon that wrote this running.json? The AO-daemon proof
 * above, PLUS the start-time check that binds the PID to this specific handshake.
 * Fails closed on every axis: no evidence, contradicted evidence, or evidence we
 * cannot read all mean "not ours" — and not ours is never signalled.
 */
export function verifyDaemonProcessIdentity(evidence: DaemonIdentityEvidence): DaemonIdentityVerdict {
	const isDaemon = verifyProcessIsAoDaemon(evidence);
	if (!isDaemon.verified) return isDaemon;
	if (!startTimeMatchesRunFile(evidence.identity?.startTimeMs ?? null, evidence.runFileStartedAtMs)) {
		return { verified: false, reason: "start-time-mismatch" };
	}
	return { verified: true, reason: "verified" };
}

// There is deliberately no signal "plan" type here. The takeover's only signal
// target is the verified PID; see main/daemon-signal.ts, which is the single place
// that calls kill() and never passes a negative (process-group) target.
