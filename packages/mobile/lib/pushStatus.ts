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

/** The single action offered to move push forward, if any. */
export type PushAction = "enable" | "register" | "open-settings";

export type PushDescription = {
	label: string;
	hint: string;
	action: PushAction | null;
	actionLabel: string | null;
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

/**
 * Describes push state as a label/hint plus the one action that advances it.
 *
 * Takes the server config itself rather than a caller-computed boolean: passing
 * `!!config` (always true, even unpaired) was the original bug, so the "is there
 * a server" rule lives here where it is tested, not at each call site.
 */
export function describePush(status: PushStatus | null, server: ServerTarget): PushDescription {
	const configured = hasServer(server);
	if (!status) {
		return { label: "Checking…", hint: "", action: null, actionLabel: null };
	}
	if (!status.supported) {
		return {
			label: "Not available",
			hint: "Push notifications need a physical device.",
			action: null,
			actionLabel: null,
		};
	}
	if (status.granted && status.registered) {
		return {
			label: "On",
			hint: "You'll be alerted when an agent needs you or a PR is ready.",
			action: null,
			actionLabel: null,
		};
	}
	if (status.granted && !status.registered) {
		// Only offer Register when there's actually a server configured.
		return configured
			? {
					label: "Permission granted",
					hint: "This device isn't registered yet. Tap to register with your server.",
					action: "register",
					actionLabel: "Register",
				}
			: {
					label: "Permission granted",
					hint: "Connect to your AO server first — this device registers automatically once connected.",
					action: null,
					actionLabel: null,
				};
	}
	if (!status.granted && status.canAskAgain) {
		// Same rule as Register above: without a server there is nothing to
		// register with, so Enable could only burn the one-shot OS permission
		// prompt and then fail. Pairing triggers registration on its own.
		return configured
			? {
					label: "Off",
					hint: "Turn on alerts for agents that need input and PR updates.",
					action: "enable",
					actionLabel: "Enable",
				}
			: {
					label: "Off",
					hint: "Connect to your AO server first — notifications turn on once connected.",
					action: null,
					actionLabel: null,
				};
	}
	// Permanently denied — only system settings can flip it back on.
	return {
		label: "Blocked",
		hint: "Notifications are turned off for AO in system settings.",
		action: "open-settings",
		actionLabel: "Open settings",
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
): { title: string; message: string } {
	switch (reason) {
		case "server-unreachable":
			return {
				title: "Couldn't reach your AO server",
				message:
					"Your device is set up for notifications, but we couldn't reach your server to register it. " +
					"Check that AO is running and your phone is on the same network, then try again.",
			};
		case "server-auth":
			return {
				title: "Your AO server rejected the request",
				message:
					"We reached your server, but it wouldn't accept the connection password. " +
					"Re-enter it under Settings → Server, then try again.",
			};
		case "server-rate-limited":
			return {
				title: "Too many attempts",
				message: "Your AO server is temporarily refusing new attempts. Wait a minute, then try again.",
			};
		case "server-error":
			return {
				title: "Your AO server couldn't register this device",
				message:
					`We reached your server, but it returned an error${status ? ` (HTTP ${status})` : ""}. ` +
					"Check the AO logs on your computer, then try again.",
			};
		case "not-configured":
			return {
				title: "Connect to your AO server first",
				message:
					"This app isn't paired with a server yet, so there's nothing to register with. " +
					"Add your server under Settings → Server (or scan its QR code) — notifications turn on once connected.",
			};
		case "token-failed":
			return {
				title: "This build can't receive push notifications",
				message:
					platform === "ios"
						? "This iOS build has no push entitlement. Install a build distributed through TestFlight to receive notifications."
						: "The device couldn't provide a push token for this build.",
			};
		case "denied":
			return {
				title: "Notifications are turned off",
				message: "Allow notifications for AO in your system settings, then try again.",
			};
		case "no-project-id":
			return {
				title: "Push isn't configured in this build",
				message: "This build is missing its EAS project ID, so it can't register for notifications.",
			};
		case "unsupported":
			return {
				title: "Not available on this device",
				message: "Push notifications only work on a physical device, not a simulator.",
			};
	}
}
