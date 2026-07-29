// Pure type definitions shared by the Electron preload bridge, the browser/dev
// fallback, and (eventually) the Tauri bridge. Kept free of Electron and Rust
// runtime code so it can be imported from any of the three implementations
// without pulling in a specific platform's runtime.
import { type KeybindingOverrides } from "./shortcuts";
import type { DaemonStatus } from "./daemon-status";
import type { TelemetryBootstrap } from "./telemetry";
import type {
	BrowserAnnotationCancelPayload,
	BrowserAnnotationModeInput,
	BrowserAnnotationSubmitPayload,
} from "./browser-annotations";

export type BrowserRect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type BrowserNavState = {
	viewId: string;
	url: string;
	title: string;
	canGoBack: boolean;
	canGoForward: boolean;
	isLoading: boolean;
	error?: string;
};

export type MigrationStatus = "pending" | "completed" | "declined" | "failed";

export interface MigrationState {
	status: MigrationStatus;
	lastAttemptAt?: string;
	completedAt?: string;
	report?: { projectsImported: number; projectsSkipped: number };
	error?: string;
}

export type UpdateChannel = "latest" | "nightly";

/** A pinned PR feature build. `channel` stays as the home channel; this is a separate overlay. */
export interface FeaturePin {
	pr: number;
}

export interface UpdateSettings {
	enabled: boolean;
	/** Home channel: stable or nightly. Never set this to a feature/pr value. */
	channel: UpdateChannel;
	nightlyAck: boolean;
	/** When set, the updater tracks the pr<N> prerelease channel instead of `channel`. Null = not pinned. */
	feature: FeaturePin | null;
}

// Live state of a manual update check/download, streamed to the renderer so the
// Global Settings "Check for updates" / "Update" buttons can reflect progress.
export type UpdateState =
	"idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error" | "unsupported";

export interface UpdateStatus {
	state: UpdateState;
	version?: string;
	percent?: number;
	message?: string;
	/** Present for statuses owned by a renderer-requested updater operation. */
	requestId?: string;
	// Present only when state === "downloaded".
	// stagedAt: epoch ms when the update finished downloading.
	// escalated: true when per-channel rules say the user should be nudged harder.
	stagedAt?: number;
	escalated?: boolean;
}

export interface UpdateCheckOptions {
	settings?: UpdateSettings;
	requestId?: string;
}

export interface FeatureBuild {
	pr: number;
	title: string;
	base: string;
	sha: string;
	slug: string;
	/** The version/tag of the build (e.g. "1.2.3-pr2270.0"). */
	buildId: string;
	publishedAt: string;
}

export type BrowserBoundsInput = {
	viewId: string;
	rect: BrowserRect;
	visible: boolean;
	parked?: boolean;
};

export type BrowserNavigateInput = {
	viewId: string;
	url: string;
};

export type ImportFolderMode = "project" | "workspace";

export type ImportRepoScan = {
	name: string;
	path: string;
	relativePath: string;
	branch: string;
	remote: string;
	hasRemote: boolean;
	status?: "ok" | "error";
	reason?: string;
};

export type ImportFolderScan = {
	path: string;
	repos: ImportRepoScan[];
	setupWarning?: string;
};

export interface AoBridge {
	app: {
		getVersion: () => Promise<string>;
		chooseDirectory: (title?: string) => Promise<string | null>;
		openExternal: (url: string) => Promise<void>;
		scanImportFolder: (input: { path: string; mode: ImportFolderMode }) => Promise<ImportFolderScan>;
		onNewSessionShortcut: (listener: () => void) => () => void;
		onKeyboardShortcutsHelp: (listener: () => void) => () => void;
		onNewShellTerminalShortcut: (listener: () => void) => () => void;
		onOpenSettingsShortcut: (listener: () => void) => () => void;
		onPreviousSessionShortcut: (listener: () => void) => () => void;
		onNextSessionShortcut: (listener: () => void) => () => void;
		onFocusTerminalShortcut: (listener: () => void) => () => void;
	};
	terminal: {
		saveDroppedFile: (input: { name: string; bytes: Uint8Array }) => Promise<string>;
	};
	window: {
		setOverlay: (overlay: { color: string; symbolColor: string }) => Promise<void>;
		isFullScreen: () => Promise<boolean>;
		onFullScreen: (listener: (fullScreen: boolean) => void) => () => void;
	};
	theme: {
		set: (preference: "light" | "dark" | "system") => Promise<void>;
	};
	menu: {
		action: (action: string) => Promise<void>;
		notifyShellFocus: () => void;
	};
	clipboard: {
		writeText: (text: string) => Promise<void>;
		readText: () => Promise<string>;
	};
	daemon: {
		getStatus: () => Promise<DaemonStatus>;
		start: () => Promise<DaemonStatus>;
		stop: () => Promise<DaemonStatus>;
		restart: () => Promise<DaemonStatus>;
		onStatus: (listener: (status: DaemonStatus) => void) => () => void;
	};
	telemetry: {
		getBootstrap: () => Promise<TelemetryBootstrap | null>;
	};
	browser: {
		ensure: (sessionId: string) => Promise<BrowserNavState>;
		setBounds: (input: BrowserBoundsInput) => void;
		navigate: (input: BrowserNavigateInput) => Promise<BrowserNavState>;
		clear: (viewId: string) => Promise<BrowserNavState>;
		capture: (viewId: string) => Promise<string>;
		requestMirror: (viewId: string) => Promise<boolean>;
		goBack: (viewId: string) => Promise<BrowserNavState>;
		goForward: (viewId: string) => Promise<BrowserNavState>;
		reload: (viewId: string) => Promise<BrowserNavState>;
		stop: (viewId: string) => Promise<BrowserNavState>;
		destroy: (viewId: string) => void;
		setAnnotationMode: (input: BrowserAnnotationModeInput) => Promise<void>;
		onNavState: (listener: (state: BrowserNavState) => void) => () => void;
		onAnnotationSubmit: (listener: (payload: BrowserAnnotationSubmitPayload) => void) => () => void;
		onAnnotationCancel: (listener: (payload: BrowserAnnotationCancelPayload) => void) => () => void;
	};
	notifications: {
		show: (notification: { id: string; title: string; body?: string }) => Promise<void>;
		onClick: (listener: (id: string) => void) => () => void;
	};
	appState: {
		getMigration: () => Promise<MigrationState>;
		setMigration: (migration: MigrationState) => Promise<void>;
	};
	updateSettings: {
		get: () => Promise<UpdateSettings>;
		set: (settings: UpdateSettings) => Promise<void>;
	};
	keybindings: {
		get: () => Promise<KeybindingOverrides>;
		set: (overrides: KeybindingOverrides) => Promise<KeybindingOverrides>;
		setRecording: (active: boolean) => Promise<void>;
	};
	updates: {
		getStatus: () => Promise<UpdateStatus>;
		check: (options?: UpdateCheckOptions) => Promise<void>;
		returnHome: (requestId?: string) => Promise<void>;
		download: (requestId?: string) => Promise<void>;
		install: () => Promise<void>;
		onStatus: (listener: (status: UpdateStatus) => void) => () => void;
	};
	featureBuilds: {
		list: () => Promise<FeatureBuild[]>;
		getActive: () => Promise<{ pr: number } | null>;
	};
}
