import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FOCUS_TERMINAL_SHORTCUT_CHANNEL,
	KEYBOARD_SHORTCUTS_HELP_CHANNEL,
	NEXT_SESSION_SHORTCUT_CHANNEL,
	NEW_SESSION_SHORTCUT_CHANNEL,
	NEW_SHELL_TERMINAL_SHORTCUT_CHANNEL,
	OPEN_SETTINGS_SHORTCUT_CHANNEL,
	PREVIOUS_SESSION_SHORTCUT_CHANNEL,
	type KeybindingOverrides,
} from "../../shared/shortcuts";
import { __resetShortcutEngineForTests, initShortcutEngine, on, setRecording } from "./shortcut-engine";

const originalPlatform = Object.getOwnPropertyDescriptor(window.navigator, "platform");
const originalUserAgent = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
const originalUserAgentData = Object.getOwnPropertyDescriptor(window.navigator, "userAgentData");

function spoofPlatform(platform: string, userAgent = platform) {
	Object.defineProperty(window.navigator, "platform", {
		configurable: true,
		get: () => platform,
	});
	Object.defineProperty(window.navigator, "userAgent", {
		configurable: true,
		get: () => userAgent,
	});
	Object.defineProperty(window.navigator, "userAgentData", {
		configurable: true,
		get: () => ({ platform }),
	});
}

function restoreProperty(name: "platform" | "userAgent" | "userAgentData", descriptor: PropertyDescriptor | undefined) {
	if (descriptor) {
		Object.defineProperty(window.navigator, name, descriptor);
		return;
	}
	delete (window.navigator as unknown as Record<string, unknown>)[name];
}

function dispatch(init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
	window.dispatchEvent(event);
	return event;
}

describe("shortcut-engine", () => {
	let overrides: KeybindingOverrides | null = {};

	beforeEach(() => {
		spoofPlatform("Win32");
		overrides = {};
		initShortcutEngine(() => overrides);
	});

	afterEach(() => {
		__resetShortcutEngineForTests();
		restoreProperty("platform", originalPlatform);
		restoreProperty("userAgent", originalUserAgent);
		restoreProperty("userAgentData", originalUserAgentData);
	});

	it("forwards the Windows/Linux new-session chord and prevents default", () => {
		const listener = vi.fn();
		on(NEW_SESSION_SHORTCUT_CHANNEL, listener);

		const event = dispatch({ key: "N", ctrlKey: true, shiftKey: true });

		expect(listener).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
	});

	it("forwards the macOS command chord", () => {
		__resetShortcutEngineForTests();
		spoofPlatform("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
		initShortcutEngine(() => overrides);
		const listener = vi.fn();
		on(NEW_SESSION_SHORTCUT_CHANNEL, listener);

		dispatch({ key: "n", metaKey: true });

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("ignores non-matching chords and auto-repeat", () => {
		const listener = vi.fn();
		on(NEW_SESSION_SHORTCUT_CHANNEL, listener);

		dispatch({ key: "n", ctrlKey: true });
		dispatch({ key: "a", ctrlKey: true, shiftKey: true });
		dispatch({ key: "N", ctrlKey: true, shiftKey: true, repeat: true });

		expect(listener).not.toHaveBeenCalled();
	});

	it("forwards the new-shell-terminal chord using the physical code Ctrl+Shift+` reports", () => {
		const listener = vi.fn();
		on(NEW_SHELL_TERMINAL_SHORTCUT_CHANNEL, listener);

		dispatch({ key: "~", code: "Backquote", ctrlKey: true, shiftKey: true });

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it.each([
		["keyboard-shortcuts help", { key: "/", ctrlKey: true }, KEYBOARD_SHORTCUTS_HELP_CHANNEL],
		["settings", { key: ",", ctrlKey: true }, OPEN_SETTINGS_SHORTCUT_CHANNEL],
		["previous session", { key: "PageUp", ctrlKey: true }, PREVIOUS_SESSION_SHORTCUT_CHANNEL],
		["next session", { key: "PageDown", ctrlKey: true }, NEXT_SESSION_SHORTCUT_CHANNEL],
		["focus terminal", { key: "T", ctrlKey: true, shiftKey: true }, FOCUS_TERMINAL_SHORTCUT_CHANNEL],
	] as const)("forwards the Windows/Linux %s shortcut", (_label, init, channel) => {
		const listener = vi.fn();
		on(channel, listener);

		const event = dispatch(init);

		expect(listener).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
	});

	it("reads live user overrides without reattaching the listener", () => {
		const listener = vi.fn();
		on(FOCUS_TERMINAL_SHORTCUT_CHANNEL, listener);

		dispatch({ key: "T", ctrlKey: true, shiftKey: true });
		overrides = {
			"focus-terminal": [{ key: "j", ctrl: true, meta: false, shift: false, alt: false }],
		};
		dispatch({ key: "T", ctrlKey: true, shiftKey: true });
		dispatch({ key: "j", ctrlKey: true });

		expect(listener).toHaveBeenCalledTimes(2);
	});

	it("does not intercept application shortcuts while a binding is being recorded", () => {
		const listener = vi.fn();
		on(KEYBOARD_SHORTCUTS_HELP_CHANNEL, listener);

		setRecording(true);
		const recordingEvent = dispatch({ key: "/", ctrlKey: true });
		setRecording(false);
		const activeEvent = dispatch({ key: "/", ctrlKey: true });

		expect(recordingEvent.defaultPrevented).toBe(false);
		expect(activeEvent.defaultPrevented).toBe(true);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("supports unsubscribing", () => {
		const listener = vi.fn();
		const unsubscribe = on(NEW_SESSION_SHORTCUT_CHANNEL, listener);
		unsubscribe();

		dispatch({ key: "N", ctrlKey: true, shiftKey: true });

		expect(listener).not.toHaveBeenCalled();
	});
});
