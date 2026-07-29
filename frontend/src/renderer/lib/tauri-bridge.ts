import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText as clipboardWriteText, readText as clipboardReadText } from "@tauri-apps/plugin-clipboard-manager";
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
import type {
	BrowserAnnotationCancelPayload,
	BrowserAnnotationSubmitPayload,
} from "../../shared/browser-annotations";
import type { AoBridge, BrowserNavState } from "../../shared/bridge-types";
import type { ShortcutChord } from "../../shared/shortcuts";
import { updatesFallback, featureBuildsFallback } from "./bridge";
import { handleForwardedChord, initShortcutEngine, on as onShortcut, setRecording as setEngineRecording } from "./shortcut-engine";

// Cache of the persisted keybinding overrides, kept in sync with the Rust
// store so the (synchronous, per-keydown) shortcut engine can read it without
// awaiting an IPC round trip on every chord. Loaded at bridge creation and
// refreshed after every `keybindings.set`.
let cachedKeybindingOverrides: KeybindingOverrides | null = null;

function refreshCachedKeybindingOverrides(): void {
	invoke<KeybindingOverrides>("keybindings_get")
		.then((overrides) => {
			cachedKeybindingOverrides = overrides;
		})
		.catch(() => undefined);
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
	const p = listen<T>(channel, (event) => listener(event.payload));
	return () => {
		p.then((un) => un());
	};
}

export function createTauriBridge(): AoBridge {
	// The shortcut engine runs in this same window (there is no main-process
	// equivalent under Tauri that can see every WebContents), so app.on*
	// shortcut subscriptions below wire to its local emitter instead of Tauri
	// events.
	initShortcutEngine(() => cachedKeybindingOverrides);
	refreshCachedKeybindingOverrides();
	// Chords captured inside a child `browser-*` webview never reach this
	// window's own `keydown` listener (see shortcut-engine.ts), so Rust
	// (`browser_forward_shortcut`) re-emits them here for the shared matching
	// table to see.
	subscribe<ShortcutChord>("browser://forward-shortcut", handleForwardedChord);
	return {
		app: {
			getVersion: () => invoke("app_get_version"),
			chooseDirectory: async (title?: string) => {
				const selected = await open({ directory: true, title });
				return Array.isArray(selected) ? (selected[0] ?? null) : selected;
			},
			openExternal: (url: string) => openUrl(url),
			scanImportFolder: (input) => invoke("app_scan_import_folder", { input }),
			onNewSessionShortcut: (listener) => onShortcut(NEW_SESSION_SHORTCUT_CHANNEL, listener),
			onKeyboardShortcutsHelp: (listener) => onShortcut(KEYBOARD_SHORTCUTS_HELP_CHANNEL, listener),
			onNewShellTerminalShortcut: (listener) => onShortcut(NEW_SHELL_TERMINAL_SHORTCUT_CHANNEL, listener),
			onOpenSettingsShortcut: (listener) => onShortcut(OPEN_SETTINGS_SHORTCUT_CHANNEL, listener),
			onPreviousSessionShortcut: (listener) => onShortcut(PREVIOUS_SESSION_SHORTCUT_CHANNEL, listener),
			onNextSessionShortcut: (listener) => onShortcut(NEXT_SESSION_SHORTCUT_CHANNEL, listener),
			onFocusTerminalShortcut: (listener) => onShortcut(FOCUS_TERMINAL_SHORTCUT_CHANNEL, listener),
		},
		terminal: {
			saveDroppedFile: ({ name, bytes }) =>
				invoke("terminal_save_dropped_file", { name, bytes: Array.from(bytes) }),
		},
		window: {
			setOverlay: (overlay) => invoke("window_set_overlay", { overlay }),
			isFullScreen: () => invoke("window_is_full_screen"),
			onFullScreen: (listener) => subscribe<boolean>("window://fullscreen", listener),
		},
		theme: {
			set: (preference) => invoke("theme_set", { preference }),
		},
		menu: {
			action: (action) => invoke("menu_action", { action }),
			notifyShellFocus: () => {
				invoke("menu_action", { action: "shell-focus" }).catch(() => undefined);
			},
		},
		clipboard: {
			writeText: (text) => clipboardWriteText(text),
			readText: () => clipboardReadText(),
		},
		daemon: {
			getStatus: () => invoke("daemon_get_status"),
			start: () => invoke("daemon_start"),
			stop: () => invoke("daemon_stop"),
			restart: () => invoke("daemon_restart"),
			onStatus: (listener) => subscribe("daemon://status", listener),
		},
		telemetry: {
			getBootstrap: () => invoke("telemetry_get_bootstrap"),
		},
		browser: {
			ensure: (sessionId) => invoke("browser_ensure", { sessionId }),
			setBounds: (input) => {
				invoke("browser_set_bounds", { input }).catch(() => undefined);
			},
			navigate: (input) => invoke("browser_navigate", { input }),
			clear: (viewId) => invoke("browser_clear", { viewId }),
			capture: (viewId) => invoke("browser_capture", { viewId }),
			requestMirror: (viewId) => invoke("browser_request_mirror", { viewId }),
			goBack: (viewId) => invoke("browser_go_back", { viewId }),
			goForward: (viewId) => invoke("browser_go_forward", { viewId }),
			reload: (viewId) => invoke("browser_reload", { viewId }),
			stop: (viewId) => invoke("browser_stop", { viewId }),
			destroy: (viewId) => {
				invoke("browser_destroy", { viewId }).catch(() => undefined);
			},
			setAnnotationMode: (input) => invoke("browser_annotation_set_mode", { input }),
			onNavState: (listener) => subscribe<BrowserNavState>("browser://nav-state", listener),
			onAnnotationSubmit: (listener) =>
				subscribe<BrowserAnnotationSubmitPayload>("browser://annotation-submitted", listener),
			onAnnotationCancel: (listener) =>
				subscribe<BrowserAnnotationCancelPayload>("browser://annotation-canceled", listener),
		},
		notifications: {
			show: (notification) => invoke("notifications_show", { notification }),
			onClick: (listener) => subscribe<string>("notifications://click", listener),
		},
		appState: {
			getMigration: () => invoke("app_state_get_migration"),
			setMigration: (migration) => invoke("app_state_set_migration", { migration }),
		},
		updateSettings: {
			get: () => invoke("update_settings_get"),
			set: (settings) => invoke("update_settings_set", { settings }),
		},
		keybindings: {
			get: () => invoke("keybindings_get"),
			set: async (overrides) => {
				const next = await invoke<KeybindingOverrides>("keybindings_set", { overrides });
				cachedKeybindingOverrides = next;
				return next;
			},
			setRecording: (active) => {
				setEngineRecording(active);
				return invoke("keybindings_set_recording", { active });
			},
		},
		// TODO(M5): updates namespace is not yet backed by a Rust command; reuse
		// the updates-fallback stub until electron-updater's Tauri equivalent lands.
		updates: updatesFallback,
		// TODO(M5): featureBuilds namespace is not yet backed by a Rust command;
		// reuse the feature-builds fallback stub until it lands.
		featureBuilds: featureBuildsFallback,
	} satisfies AoBridge;
}
