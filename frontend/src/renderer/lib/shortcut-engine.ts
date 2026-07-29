// Renderer-owned shortcut engine (Tauri path). Ports the matching behavior of
// `main/app-shortcuts.ts` (Electron's `before-input-event` interceptor) onto a
// single `window` `keydown` listener, since the Tauri window has no
// equivalent main-process hook that can see every WebContents. Reuses the
// shared chord tables in `shared/shortcuts.ts` — no duplicated bindings here.
import {
	FOCUS_TERMINAL_SHORTCUT_CHANNEL,
	KEYBOARD_SHORTCUTS_HELP_CHANNEL,
	matchesAppShortcut,
	NEXT_SESSION_SHORTCUT_CHANNEL,
	NEW_SESSION_SHORTCUT_CHANNEL,
	NEW_SHELL_TERMINAL_SHORTCUT_CHANNEL,
	OPEN_SETTINGS_SHORTCUT_CHANNEL,
	PREVIOUS_SESSION_SHORTCUT_CHANNEL,
	type AppShortcutId,
	type KeybindingOverrides,
	type ShortcutChord,
} from "../../shared/shortcuts";
import { isMacPlatform } from "./platform";

// Mirrors the channel table in main/app-shortcuts.ts so the renderer engine
// (Tauri) and the main-process engine (still live under Electron until
// cleanup) cannot drift.
const shortcutChannels: readonly [AppShortcutId, string][] = [
	["new-session", NEW_SESSION_SHORTCUT_CHANNEL],
	["new-shell-terminal", NEW_SHELL_TERMINAL_SHORTCUT_CHANNEL],
	["keyboard-shortcuts", KEYBOARD_SHORTCUTS_HELP_CHANNEL],
	["open-settings", OPEN_SETTINGS_SHORTCUT_CHANNEL],
	["previous-session", PREVIOUS_SESSION_SHORTCUT_CHANNEL],
	["next-session", NEXT_SESSION_SHORTCUT_CHANNEL],
	["focus-terminal", FOCUS_TERMINAL_SHORTCUT_CHANNEL],
];

type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();
let overridesGetter: () => KeybindingOverrides | null = () => null;
let recording = false;
let attached = false;

function keyboardEventChord(event: KeyboardEvent): ShortcutChord {
	return {
		key: event.key,
		code: event.code,
		ctrl: event.ctrlKey,
		meta: event.metaKey,
		shift: event.shiftKey,
		alt: event.altKey,
	};
}

function emit(channel: string): void {
	for (const cb of listeners.get(channel) ?? []) cb();
}

function shortcutChannelFor(chord: ShortcutChord, overrides: KeybindingOverrides): string | null {
	for (const [id, channel] of shortcutChannels) {
		if (matchesAppShortcut(id, chord, isMacPlatform(), overrides)) return channel;
	}
	return null;
}

function dispatchChord(chord: ShortcutChord): string | null {
	// Let the settings dialog's capture listener receive application-owned
	// chords while the user is recording a replacement binding.
	if (recording) return null;
	const channel = shortcutChannelFor(chord, overridesGetter() ?? {});
	if (!channel) return null;
	emit(channel);
	return channel;
}

function handleKeydown(event: KeyboardEvent): void {
	if (event.repeat) return;
	const channel = dispatchChord(keyboardEventChord(event));
	if (channel) event.preventDefault();
}

/**
 * Entry point for chords captured inside a child `browser-*` webview and
 * forwarded to the main window via Rust (`browser_forward_shortcut` ->
 * `browser://forward-shortcut`, see `tauri-bridge.ts`). The child webview's
 * keydowns never reach this window's own `keydown` listener, so this is the
 * only way those chords reach the shared matching table. Unlike
 * `handleKeydown`, there is no DOM event to `preventDefault()` on — the
 * child page already decided synchronously whether to keep handling the key
 * itself (documented deviation from Electron's `before-input-event`, which
 * could suppress the key before the child page saw it at all).
 */
export function handleForwardedChord(chord: ShortcutChord): void {
	dispatchChord(chord);
}

/**
 * Wires the renderer-owned shortcut engine: a single `keydown` listener on
 * `window` that matches application chords and fans out to subscribers
 * registered via `on`. Idempotent — safe to call more than once; only the
 * first call attaches the DOM listener. `getOverrides` is called on every
 * keydown, so callers should keep it backed by a cheap, synchronous cache
 * (e.g. refreshed after `keybindings_get`/`keybindings_set`).
 */
export function initShortcutEngine(getOverrides: () => KeybindingOverrides | null): void {
	overridesGetter = getOverrides;
	if (attached) return;
	window.addEventListener("keydown", handleKeydown);
	attached = true;
}

/** Suspends application-shortcut interception while a binding is being recorded. */
export function setRecording(active: boolean): void {
	recording = active;
}

export function on(channel: string, cb: Listener): () => void {
	let subscribers = listeners.get(channel);
	if (!subscribers) {
		subscribers = new Set();
		listeners.set(channel, subscribers);
	}
	subscribers.add(cb);
	return () => {
		subscribers?.delete(cb);
	};
}

// Exposed for tests to reset module-level state between cases (this module is
// a singleton by design, so tests otherwise leak listeners/attachment).
export function __resetShortcutEngineForTests(): void {
	listeners.clear();
	overridesGetter = () => null;
	recording = false;
	if (attached) {
		window.removeEventListener("keydown", handleKeydown);
		attached = false;
	}
}
