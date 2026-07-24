import { describe, expect, it, vi } from "vitest";
// prettier-ignore
import { FOCUS_TERMINAL_SHORTCUT_CHANNEL, KEYBOARD_SHORTCUTS_HELP_CHANNEL, NEXT_SESSION_SHORTCUT_CHANNEL, NEW_SESSION_SHORTCUT_CHANNEL, NEW_SHELL_TERMINAL_SHORTCUT_CHANNEL, OPEN_SETTINGS_SHORTCUT_CHANNEL, PREVIOUS_SESSION_SHORTCUT_CHANNEL } from "../shared/shortcuts";
import { attachAppShortcuts } from "./app-shortcuts";

type InputEvent = {
	key: string;
	// Physical key (Electron input.code), needed for chords whose character is
	// layout-shifted, e.g. Ctrl+Shift+` reports key "~" but code "Backquote".
	code?: string;
	control: boolean;
	meta: boolean;
	shift: boolean;
	alt: boolean;
	type: "keyDown" | "keyUp";
	isAutoRepeat?: boolean;
};

function fakeSource() {
	let handler: ((event: { preventDefault: () => void }, input: InputEvent) => void) | undefined;
	return {
		on(channel: string, listener: typeof handler) {
			if (channel === "before-input-event") handler = listener;
			return this;
		},
		emit(input: Partial<InputEvent> & { key: string }) {
			const event = { preventDefault: vi.fn() };
			handler?.(event, {
				control: false,
				meta: false,
				shift: false,
				alt: false,
				type: "keyDown",
				...input,
			});
			return event;
		},
	};
}

function fakeTarget() {
	return { focus: vi.fn(), send: vi.fn() };
}

describe("attachAppShortcuts", () => {
	it("forwards and prevents default on the main-window chord", () => {
		const source = fakeSource();
		const target = fakeTarget();
		attachAppShortcuts(source, false, target);

		const event = source.emit({ key: "N", control: true, shift: true });

		expect(target.send).toHaveBeenCalledWith(NEW_SESSION_SHORTCUT_CHANNEL);
		expect(target.focus).not.toHaveBeenCalled();
		expect(event.preventDefault).toHaveBeenCalledTimes(1);
	});

	it("forwards the macOS command chord", () => {
		const source = fakeSource();
		const target = fakeTarget();
		attachAppShortcuts(source, true, target);

		source.emit({ key: "n", meta: true });

		expect(target.send).toHaveBeenCalledWith(NEW_SESSION_SHORTCUT_CHANNEL);
	});

	it("focuses a separate shell target before forwarding", () => {
		const source = fakeSource();
		const target = fakeTarget();
		attachAppShortcuts(source, false, target, true);

		source.emit({ key: "N", control: true, shift: true });

		expect(target.focus).toHaveBeenCalledTimes(1);
		expect(target.send).toHaveBeenCalledWith(NEW_SESSION_SHORTCUT_CHANNEL);
		expect(target.focus.mock.invocationCallOrder[0]).toBeLessThan(target.send.mock.invocationCallOrder[0]);
	});

	it("ignores non-matching chords and key-up events", () => {
		const source = fakeSource();
		const target = fakeTarget();
		attachAppShortcuts(source, false, target);

		source.emit({ key: "n", control: true });
		source.emit({ key: "N", control: true, shift: true, type: "keyUp" });
		source.emit({ key: "a", control: true, shift: true });

		expect(target.send).not.toHaveBeenCalled();
	});

	it("ignores auto-repeat so holding the combo fires once", () => {
		const source = fakeSource();
		const target = fakeTarget();
		attachAppShortcuts(source, false, target);

		source.emit({ key: "N", control: true, shift: true });
		source.emit({ key: "N", control: true, shift: true, isAutoRepeat: true });
		source.emit({ key: "N", control: true, shift: true, isAutoRepeat: true });

		expect(target.send).toHaveBeenCalledTimes(1);
	});

	it("forwards the new-shell-terminal chord using the physical code Ctrl+Shift+` reports", () => {
		const source = fakeSource();
		const target = fakeTarget();
		attachAppShortcuts(source, false, target);

		// Real Electron values for Ctrl+Shift+` on a US layout: Shift shifts the
		// character to "~", so only the physical code "Backquote" identifies the
		// chord. This pins app-shortcuts forwarding `code` into the matcher.
		source.emit({ key: "~", code: "Backquote", control: true, shift: true, type: "keyDown" });

		expect(target.send).toHaveBeenCalledWith(NEW_SHELL_TERMINAL_SHORTCUT_CHANNEL);
	});

	it("forwards keyboard-shortcut help on each platform", () => {
		const windowsSource = fakeSource();
		const windowsTarget = fakeTarget();
		attachAppShortcuts(windowsSource, false, windowsTarget);
		windowsSource.emit({ key: "/", control: true });

		const macSource = fakeSource();
		const macTarget = fakeTarget();
		attachAppShortcuts(macSource, true, macTarget);
		macSource.emit({ key: "/", meta: true });

		expect(windowsTarget.send).toHaveBeenCalledWith(KEYBOARD_SHORTCUTS_HELP_CHANNEL);
		expect(macTarget.send).toHaveBeenCalledWith(KEYBOARD_SHORTCUTS_HELP_CHANNEL);
	});

	it.each([
		["settings", { key: ",", control: true }, OPEN_SETTINGS_SHORTCUT_CHANNEL],
		["previous session", { key: "PageUp", control: true }, PREVIOUS_SESSION_SHORTCUT_CHANNEL],
		["next session", { key: "PageDown", control: true }, NEXT_SESSION_SHORTCUT_CHANNEL],
		["focus terminal", { key: "T", control: true, shift: true }, FOCUS_TERMINAL_SHORTCUT_CHANNEL],
	] as const)("forwards the Windows/Linux %s shortcut", (_label, input, channel) => {
		const source = fakeSource();
		const target = fakeTarget();
		attachAppShortcuts(source, false, target);

		const event = source.emit(input);

		expect(target.send).toHaveBeenCalledWith(channel);
		expect(event.preventDefault).toHaveBeenCalledTimes(1);
	});
});
