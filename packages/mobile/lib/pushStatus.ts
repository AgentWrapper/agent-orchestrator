import { enT, type TFunction } from "./i18n";
// Pure decision logic for the push-notification UI. Deliberately free of React
// Native / Expo imports so it can be unit-tested directly, and so the rules that
// decide "what can the user do next" live in one place instead of inside a screen.

/** Live permission + registration state of push on this device. */
export type PushStatus = {
	supported: boolean; // remote push only works on a physical device
	granted: boolean; // OS notification permission granted
	canAskAgain: boolean; // false once permanently denied (must use system settings)
	registered: boolean; // we hold a token registered with a daemon
};

/** Just enough of the server config to know whether there's a server to talk to. */
export type ServerTarget = { host?: string } | null | undefined;

/**
 * Is there actually a server to register with? An unpaired app still holds a
 * default config object with an empty host, so presence of the object means
 * nothing — only a non-empty host does.
 */
export function hasServer(server: ServerTarget): boolean {
	return !!server?.host?.trim();
}

export type PushToggle = {
	/** Where the switch sits. On means "permission granted AND registered". */
	value: boolean;
	/** Greyed out — there is nothing turning it on could accomplish. */
	disabled: boolean;
	/** Section footer explaining the current state. */
	footer: string;
	/**
	 * Permission was permanently denied, so the app can no longer prompt. The
	 * switch stays interactive (tapping must explain itself) but flipping it on
	 * has to route through system settings instead of registerForPush.
	 */
	blocked: boolean;
};

/**
 * The whole push state machine, collapsed to a single switch.
 *
 * The old UI exposed up to three different buttons (Enable / Register / Open
 * settings) for what a user thinks of as one setting. All three become "on"
 * here; only `blocked` needs different handling at the call site, because the OS
 * won't let us re-prompt after a permanent denial.
 *
 * Takes the server config itself rather than a caller-computed boolean: passing
 * `!!config` (always true, even unpaired) was the original bug, so the "is there
 * a server" rule lives here where it is tested, not at each call site.
 */
export function describePushToggle(status: PushStatus | null, server: ServerTarget, tr: TFunction = enT): PushToggle {
	if (!status) {
		return { value: false, disabled: true, footer: tr("push.checking"), blocked: false };
	}
	if (!status.supported) {
		return {
			value: false,
			disabled: true,
			footer: tr("push.needDevice"),
			blocked: false,
		};
	}
	if (!hasServer(server)) {
		return {
			value: false,
			disabled: true,
			footer: tr("push.connectFirst"),
			blocked: false,
		};
	}
	if (!status.granted && !status.canAskAgain) {
		return {
			value: false,
			disabled: false,
			footer: tr("push.offInSettings"),
			blocked: true,
		};
	}
	if (status.granted && status.registered) {
		return {
			value: true,
			disabled: false,
			footer: tr("push.registered"),
			blocked: false,
		};
	}
	if (status.granted && !status.registered) {
		return {
			value: false,
			disabled: false,
			footer: tr("push.notRegistered"),
			blocked: false,
		};
	}
	return {
		value: false,
		disabled: false,
		footer: tr("push.turnOn"),
		blocked: false,
	};
}

/** Why a registration attempt did not produce a usable token. */
export type PushRegisterFailure =
	| "unsupported" // simulator / not a physical device
	| "not-configured" // no AO server paired yet, so there's nothing to register with
	| "denied" // permission not granted
	| "no-project-id" // EAS projectId missing from app config
	| "token-failed" // the OS/Expo refused to mint a token (e.g. no APNs entitlement)
	| "server-unreachable" // token fine, but the daemon was never reached
	| "server-auth" // daemon answered 401/403 — wrong or missing password
	| "server-rate-limited" // daemon answered 429 — too many attempts / lockout
	| "server-error"; // daemon answered with some other error status

export type PushRegisterResult =
	| { ok: true; token: string }
	// `status` is the HTTP status when the daemon answered with an error, so the
	// message can name it; absent for every other kind of failure.
	| { ok: false; reason: PushRegisterFailure; status?: number };

/**
 * Maps a failed register call to a reason. `status` is the HTTP status the
 * daemon answered with, or undefined when the request never got an answer
 * (DNS failure, connection refused, timeout).
 *
 * Reaching the server and being rejected by it is not the same as not reaching
 * it: telling someone with a wrong password to "check that AO is running" sends
 * them to debug the wrong thing.
 */
export function classifyServerFailure(status: number | undefined): PushRegisterFailure {
	if (status === undefined) return "server-unreachable";
	if (status === 401 || status === 403) return "server-auth";
	if (status === 429) return "server-rate-limited";
	return "server-error";
}

/**
 * Human-facing title/message for a failed registration. Kept separate from the
 * network code so the wording is testable — and so we never again tell a user on
 * a proper store build that their build "has no push entitlement" when the real
 * problem was simply that their server wasn't reachable.
 */
export function describeRegisterFailure(
	reason: PushRegisterFailure,
	platform: "ios" | "android" | string,
	status?: number,
	tr: TFunction = enT,
): { title: string; message: string } {
	switch (reason) {
		case "server-unreachable":
			return {
				title: tr("push.fail.unreachable.title"),
				message: tr("push.fail.unreachable.message"),
			};
		case "server-auth":
			return {
				title: tr("push.fail.auth.title"),
				message: tr("push.fail.auth.message"),
			};
		case "server-rate-limited":
			return {
				title: tr("push.fail.rateLimited.title"),
				message: tr("push.fail.rateLimited.message"),
			};
		case "server-error":
			return {
				title: tr("push.fail.serverError.title"),
				message: tr("push.fail.serverError.message", {
					status: status ? tr("push.fail.serverError.status", { code: status }) : "",
				}),
			};
		case "not-configured":
			return {
				title: tr("push.fail.notConfigured.title"),
				message: tr("push.fail.notConfigured.message"),
			};
		case "token-failed":
			return {
				title: tr("push.fail.tokenFailed.title"),
				message:
					platform === "ios"
						? tr("push.fail.tokenFailed.message.ios")
						: tr("push.fail.tokenFailed.message.android"),
			};
		case "denied":
			return {
				title: tr("push.fail.denied.title"),
				message: tr("push.fail.denied.message"),
			};
		case "no-project-id":
			return {
				title: tr("push.fail.noProjectId.title"),
				message: tr("push.fail.noProjectId.message"),
			};
		case "unsupported":
			return {
				title: tr("push.fail.unsupported.title"),
				message: tr("push.fail.unsupported.message"),
			};
	}
}
