import { describe, expect, it, vi } from "vitest";
import { attachNewSessionShortcut } from "./new-session-shortcut";

type InputEvent = {
	key: string;
	control: boolean;
	meta: boolean;
	shift: boolean;
	alt: boolean;
	type: "keyDown" | "keyUp";
	isAutoRepeat?: boolean;
};

// Minimal stand-in for the electron WebContents before-input-event emitter.
function fakeContents() {
	let handler: ((event: { preventDefault: () => void }, input: InputEvent) => void) | undefined;
	return {
		on(channel: string, fn: typeof handler) {
			if (channel === "before-input-event") handler = fn;
			return this;
		},
		send(input: Partial<InputEvent> & { key: string }) {
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

describe("attachNewSessionShortcut", () => {
	it("notifies and prevents default on the matching chord (Windows/Linux)", () => {
		const contents = fakeContents();
		const notify = vi.fn();
		attachNewSessionShortcut(contents, false, notify);

		const event = contents.send({ key: "N", control: true, shift: true });

		expect(notify).toHaveBeenCalledTimes(1);
		expect(event.preventDefault).toHaveBeenCalledTimes(1);
	});

	it("notifies on ⌘N on macOS", () => {
		const contents = fakeContents();
		const notify = vi.fn();
		attachNewSessionShortcut(contents, true, notify);

		contents.send({ key: "n", meta: true });

		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("ignores non-matching chords and key-up events", () => {
		const contents = fakeContents();
		const notify = vi.fn();
		attachNewSessionShortcut(contents, false, notify);

		contents.send({ key: "n", control: true }); // plain Ctrl+N — reserved for terminal
		contents.send({ key: "N", control: true, shift: true, type: "keyUp" }); // release
		contents.send({ key: "a", control: true, shift: true });

		expect(notify).not.toHaveBeenCalled();
	});

	it("ignores auto-repeat so holding the combo fires once", () => {
		const contents = fakeContents();
		const notify = vi.fn();
		attachNewSessionShortcut(contents, false, notify);

		contents.send({ key: "N", control: true, shift: true });
		contents.send({ key: "N", control: true, shift: true, isAutoRepeat: true });
		contents.send({ key: "N", control: true, shift: true, isAutoRepeat: true });

		expect(notify).toHaveBeenCalledTimes(1);
	});
});
