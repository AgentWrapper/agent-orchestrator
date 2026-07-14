// Keyboard-shortcut matchers shared by the shell key handler. Kept pure and
// platform-parameterized so the binding logic is unit-testable without a DOM.

type ShortcutEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

// New session: ⌘N on macOS, Ctrl+Shift+N on Windows/Linux. Plain Ctrl+N is a
// live terminal keystroke (readline/vim "next line"), so the non-mac binding
// adds Shift to steer clear of the xterm key handler.
export function isNewSessionShortcut(event: ShortcutEvent, isMac: boolean): boolean {
	if (event.key.toLowerCase() !== "n") return false;
	return isMac
		? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
		: event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
}

// A shortcut must not fire while the user is typing into a field.
export function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable === true;
}
