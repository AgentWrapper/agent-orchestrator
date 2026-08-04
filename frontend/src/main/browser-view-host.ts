import type {
	IpcMain,
	IpcMainEvent,
	IpcMainInvokeEvent,
	Rectangle,
	Session,
	View,
	WebContents,
	WebFrameMain,
} from "electron";
import { randomUUID } from "node:crypto";
import type {
	BrowserAnnotationCancelPayload,
	BrowserAnnotationModeInput,
	BrowserAnnotationPageCancelPayload,
	BrowserAnnotationPageSubmitPayload,
	BrowserAnnotationSubmitPayload,
} from "../shared/browser-annotations";
import { attachAppShortcuts } from "./app-shortcuts";
import type { KeybindingOverrides } from "../shared/shortcuts";
import type { AgentBrowserRuntime } from "./agent-browser-runtime";
import type { AgentBrowserTarget, AgentBrowserTargetProvider } from "./agent-browser-cdp-bridge";

export type BrowserRect = Pick<Rectangle, "x" | "y" | "width" | "height">;

/**
 * A renderer replacement for a captured native browser viewport. The pixel
 * size describes the encoded NativeImage (and therefore includes display
 * scale), while the css* fields describe the rounded native viewport and its
 * offset in the renderer's page-zoomed CSS pixels.
 */
export type BrowserMirrorFrame = {
	dataUrl: string;
	pixelWidth: number;
	pixelHeight: number;
	nativeBounds: BrowserRect;
	cssLeft: number;
	cssTop: number;
	cssWidth: number;
	cssHeight: number;
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

export type BrowserTabState = {
	id: string;
	url: string;
	title: string;
	active: boolean;
};

export type BrowserTabsState = {
	viewId: string;
	activeTabId: string;
	tabs: BrowserTabState[];
	change?: {
		kind: "opened" | "popup" | "selected" | "closed";
		tabId: string;
	};
};

export type BrowserAgentActivityState = {
	viewId: string;
	tabId?: string;
	active: boolean;
	action: string;
	phase?: "started" | "finished";
	commandId?: string;
};

export type BrowserAgentStatusInput = {
	viewId: string;
	active: boolean;
};

export type BrowserDevToolsState = {
	viewId: string;
	open: boolean;
	activeTabId: string;
};

export type BrowserDevToolsInput = {
	viewId: string;
	operation: "open" | "close";
};

type InternalBrowserDevToolsOperation = BrowserDevToolsInput["operation"] | "toggle";

type BrowserBoundsInput = {
	viewId: string;
	rect: BrowserRect;
	visible: boolean;
	parked?: boolean;
};

type BrowserNavigateInput = {
	viewId: string;
	url: string;
};

type BrowserTabInput = {
	viewId: string;
	tabId: string;
};

type BrowserWebContents = Pick<
	WebContents,
	| "id"
	| "canGoBack"
	| "canGoForward"
	| "capturePage"
	| "clearHistory"
	| "debugger"
	| "executeJavaScript"
	| "focus"
	| "mainFrame"
	| "getTitle"
	| "getURL"
	| "goBack"
	| "goForward"
	| "isLoading"
	| "loadURL"
	| "on"
	| "reload"
	| "send"
	| "setWindowOpenHandler"
	| "stop"
> & {
	close?: () => void;
	session?: Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler">;
};

type BrowserViewLike = View & {
	webContents: BrowserWebContents;
	setBounds: (bounds: BrowserRect) => void;
	setBorderRadius?: (radius: number) => void;
	setVisible?: (visible: boolean) => void;
};

type BrowserWindowLike = {
	contentView: {
		addChildView: (view: BrowserViewLike) => void;
		removeChildView?: (view: BrowserViewLike) => void;
	};
	getContentBounds: () => BrowserRect;
	webContents: Pick<WebContents, "focus" | "id" | "send"> & {
		session?: Pick<Session, "setDisplayMediaRequestHandler">;
	};
	isDestroyed?: () => boolean;
};

type BrowserDevToolsWindowLike = {
	webContents: Pick<BrowserWebContents, "focus" | "loadURL" | "on">;
	show: () => void;
	focus: () => void;
	close: () => void;
	isDestroyed?: () => boolean;
	on: (event: "closed", listener: () => void) => unknown;
};

type ShellLike = {
	openExternal: (url: string) => Promise<void>;
};

type WebContentsViewConstructor = new (options: { webPreferences: Electron.WebPreferences }) => BrowserViewLike;

export type BrowserViewHostOptions = {
	mainWindow: BrowserWindowLike;
	createDevToolsWindow?: () => BrowserDevToolsWindowLike;
	ipcMain: Pick<IpcMain, "handle" | "on" | "removeHandler" | "off">;
	shell: ShellLike;
	WebContentsView: WebContentsViewConstructor;
	annotatePreloadPath: string;
	rendererOrigin: string;
	// Platform flag for application shortcuts forwarded from each preview view
	// to the shell. Defaults to non-mac when omitted (tests).
	isMac?: boolean;
	getKeybindingOverrides?: () => KeybindingOverrides;
	isKeybindingRecording?: () => boolean;
	agentBrowserRuntime?: AgentBrowserRuntime;
};

export type BrowserViewHost = {
	dispose: () => Promise<void>;
	destroy: (viewId: string) => void;
	destroyAll: () => void;
	execute: (sessionId: string, action: string, args?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
	// webContents of the most recently focused browser panel (or null); the titlebar menu targets it for Edit/Reload/Zoom/DevTools.
	getLastFocusedPanelContents: () => WebContents | null;
	/** Toggle Chromium DevTools for the last focused AO browser panel. */
	toggleDevToolsForLastFocused: () => Promise<BrowserDevToolsState | null>;
	// Drop the remembered panel; call when the shell gains focus for a real reason so a stale panel stops absorbing menu actions.
	forgetLastFocusedPanel: () => void;
};

type BrowserEntry = {
	sessionId: string;
	tabId: string;
	view: BrowserViewLike;
	state: BrowserNavState;
	annotationEnabled: boolean;
	networkCapture?: BrowserNetworkCapture;
};

type BrowserSessionEntry = {
	sessionId: string;
	viewId: string;
	profilePartition: string;
	tabs: Map<string, BrowserEntry>;
	activeTabId: string;
	nextTabNumber: number;
	bounds: BrowserRect;
	rendererBounds: BrowserRect;
	zoomFactor: number;
	visible: boolean;
	parked: boolean;
	networkTabId?: string;
	agentBrowserCommands: number;
	agentStatusActive: boolean;
	agentStatusQueue: Promise<void>;
	devtools?: {
		window: BrowserDevToolsWindowLike;
		targetTabId: string;
	};
};

type BrowserLogEntry = {
	level: string;
	message: string;
	source?: string;
	line?: number;
	timestamp: string;
};

type BrowserNetworkRequest = {
	id: string;
	method: string;
	url: string;
	resourceType?: string;
	startedAt: string;
	status?: number;
	statusText?: string;
	mimeType?: string;
	durationMs?: number;
	failed?: boolean;
	canceled?: boolean;
	errorText?: string;
	fromCache?: boolean;
	fromServiceWorker?: boolean;
	redirectedTo?: string;
	requestHeaders?: Record<string, string>;
	responseHeaders?: Record<string, string>;
};

type InternalBrowserNetworkRequest = BrowserNetworkRequest & {
	protocolRequestId: string;
	startedMonotonic?: number;
};

type BrowserNetworkCapture = {
	active: boolean;
	tabId: string;
	startedAt: string;
	expiresAt: string;
	stoppedAt?: string;
	stopReason?: string;
	maxEntries: number;
	nextSequence: number;
	requests: InternalBrowserNetworkRequest[];
	byRequestId: Map<string, InternalBrowserNetworkRequest>;
	timer?: ReturnType<typeof setTimeout>;
};

// Hidden targets still need a real viewport for screenshots, responsive
// layout, scrolling, and pointer automation before the panel is first shown.
const OFFSCREEN_BOUNDS: BrowserRect = { x: -10_000, y: -10_000, width: 1280, height: 720 };
const BROWSER_VIEW_BORDER_RADIUS = 8;
const DEFAULT_NETWORK_CAPTURE_SECONDS = 60;
const MAX_NETWORK_CAPTURE_SECONDS = 300;
const MAX_NETWORK_REQUESTS = 200;
const MAX_BROWSER_TABS = 16;
const MAX_EXTERNAL_TEXT_BYTES = 1 << 20;
const UNTRUSTED_BEGIN = "<<<BEGIN UNTRUSTED EXTERNAL CONTENT>>>";
const UNTRUSTED_END = "<<<END UNTRUSTED EXTERNAL CONTENT>>>";
// The human-facing address bar may open local preview files. Agent commands use
// normalizeAgentBrowserURL below, which permits only explicit HTTP(S) targets.
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "file:"]);
const AGENT_STATUS_HOST_ID = "__ao_agent_working_pill__";
const AGENT_STATUS_MARKUP = `
<style>
  :host {
    all: initial;
    position: fixed;
    right: 8px;
    bottom: 10px;
    z-index: 2147483647;
    display: flex;
    align-items: flex-end;
    justify-content: flex-end;
    width: 110px;
    height: 26px;
    pointer-events: none;
  }
  .status {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    gap: 4px;
    width: 110px;
    min-width: 110px;
    height: 26px;
    padding: 0 5px 0 8px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 999px;
    background: rgba(20, 24, 30, 0.74);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(255, 255, 255, 0.03);
    backdrop-filter: blur(8px);
    color: rgba(255, 255, 255, 0.84);
    font: 600 11px/1.1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    white-space: nowrap;
    pointer-events: none;
    user-select: none;
    -webkit-user-select: none;
    overflow: hidden;
    animation: ao-agent-working-collapse 3s cubic-bezier(0.22, 1, 0.36, 1) 180ms forwards;
  }
  .label {
    flex: 0 0 auto;
    max-width: 86px;
    overflow: hidden;
    opacity: 1;
    animation: ao-agent-working-label-collapse 3s cubic-bezier(0.22, 1, 0.36, 1) 180ms forwards;
  }
  .dot {
    width: 12px;
    height: 7px;
    flex: 0 0 auto;
    border-radius: 999px;
    background: #75d69b;
    box-shadow: 0 0 0 3px rgba(117, 214, 155, 0.16);
    animation: ao-agent-working-breathe 2.4s ease-in-out infinite;
  }
  @keyframes ao-agent-working-collapse {
    0%, 64% {
      width: 110px;
      min-width: 110px;
      height: 26px;
      padding: 0 5px 0 8px;
      gap: 4px;
      border-color: rgba(255, 255, 255, 0.14);
      background: rgba(20, 24, 30, 0.74);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(255, 255, 255, 0.03);
    }
    100% {
      width: 12px;
      min-width: 12px;
      height: 7px;
      padding: 0;
      gap: 0;
      border-color: transparent;
      background: transparent;
      box-shadow: none;
    }
  }
  @keyframes ao-agent-working-label-collapse {
    0%, 64% {
      max-width: 86px;
      opacity: 1;
    }
    100% {
      max-width: 0;
      opacity: 0;
    }
  }
  @keyframes ao-agent-working-breathe {
    0%, 100% {
      opacity: 0.88;
      box-shadow: 0 0 0 3px rgba(117, 214, 155, 0.14);
    }
    50% {
      opacity: 0.58;
      box-shadow: 0 0 0 5px rgba(117, 214, 155, 0.04);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .status { animation: ao-agent-working-collapse 0s 2.3s forwards; }
    .label { animation: ao-agent-working-label-collapse 0s 2.3s forwards; }
    .dot { animation: none; }
  }
</style>
<div class="status" role="presentation"><span class="label">Agent working</span><span class="dot" aria-hidden="true"></span></div>`;

function agentStatusScript(active: boolean): string {
	return `(() => {
  const hostId = ${JSON.stringify(AGENT_STATUS_HOST_ID)};
  const existing = document.getElementById(hostId);
  if (!${active ? "true" : "false"}) {
    existing?.remove();
    return;
  }
  if (existing || !document.documentElement) return;
  const host = document.createElement("div");
  host.id = hostId;
  host.setAttribute("aria-hidden", "true");
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = ${JSON.stringify(AGENT_STATUS_MARKUP)};
  document.documentElement.appendChild(host);
})()`;
}

export function normalizeBrowserURL(input: string): URL {
	const raw = input.trim();
	if (raw === "") {
		throw new Error("URL is required");
	}
	const candidate = withDefaultScheme(raw);
	const url = new URL(candidate);
	if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
		throw new Error(`Unsupported browser URL scheme: ${url.protocol}`);
	}
	return url;
}

export function isAllowedBrowserURL(input: string, rendererOrigin?: string): boolean {
	try {
		const url = normalizeBrowserURL(input);
		if (rendererOrigin && url.origin === rendererOrigin) return false;
		return true;
	} catch {
		return false;
	}
}

export function clampBoundsToWindow(
	rect: BrowserRect,
	windowBounds: Pick<BrowserRect, "width" | "height">,
): BrowserRect {
	const rounded = {
		x: Math.round(rect.x),
		y: Math.round(rect.y),
		width: Math.max(0, Math.round(rect.width)),
		height: Math.max(0, Math.round(rect.height)),
	};
	const maxX = Math.max(0, Math.round(windowBounds.width));
	const maxY = Math.max(0, Math.round(windowBounds.height));
	const x = Math.min(Math.max(rounded.x, 0), maxX);
	const y = Math.min(Math.max(rounded.y, 0), maxY);
	return {
		x,
		y,
		width: Math.min(rounded.width, Math.max(0, maxX - x)),
		height: Math.min(rounded.height, Math.max(0, maxY - y)),
	};
}

export function scaleBoundsForZoom(rect: BrowserRect, zoomFactor: number): BrowserRect {
	if (!Number.isFinite(zoomFactor) || zoomFactor <= 0 || zoomFactor === 1) return rect;
	return {
		x: rect.x * zoomFactor,
		y: rect.y * zoomFactor,
		width: rect.width * zoomFactor,
		height: rect.height * zoomFactor,
	};
}

export function createBrowserViewHost(options: BrowserViewHostOptions): BrowserViewHost {
	const entries = new Map<string, BrowserSessionEntry>();
	const viewIdsBySessionId = new Map<string, string>();
	const rendererOwnersByViewId = new Map<string, Set<number>>();
	const tabsByWebContentsId = new Map<number, BrowserEntry>();
	const ipcDisposers: Array<() => void> = [];
	let disposePromise: Promise<void> | null = null;
	// viewId of the panel that most recently held focus; cleared when it is hidden or destroyed.
	let lastFocusedViewId: string | null = null;
	const forgetIfFocused = (viewId: string): void => {
		if (lastFocusedViewId === viewId) lastFocusedViewId = null;
	};
	const setAgentBrowserActivity = (
		session: BrowserSessionEntry,
		action: string,
		active: boolean,
		commandId?: string,
		phase?: BrowserAgentActivityState["phase"],
		tabId?: string,
	): void => {
		session.agentBrowserCommands = Math.max(0, session.agentBrowserCommands + (active ? 1 : -1));
		options.mainWindow.webContents.send("browser:agentActivity", {
			viewId: session.viewId,
			...(tabId ? { tabId } : {}),
			active: session.agentBrowserCommands > 0,
			action,
			...(phase ? { phase } : {}),
			...(commandId ? { commandId } : {}),
		} satisfies BrowserAgentActivityState);
	};
	const enqueueAgentStatus = (
		session: BrowserSessionEntry,
		active: boolean,
		target: BrowserEntry | undefined = active ? activeEntry(session) : undefined,
	): Promise<void> => {
		const targets = active ? (target ? [target] : [activeEntry(session)]) : [...session.tabs.values()];
		const update = async (): Promise<void> => {
			await Promise.all(
				targets.map(async (entry) => {
					const executeJavaScript = entry.view.webContents.executeJavaScript;
					if (!executeJavaScript) return;
					try {
						await executeJavaScript.call(entry.view.webContents, agentStatusScript(active));
					} catch {
						// The page may be between documents or the view may be closing.
					}
				}),
			);
		};
		const next = session.agentStatusQueue.then(update, update);
		session.agentStatusQueue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};
	const applyBrowserViewBounds = (view: BrowserViewLike, bounds: BrowserRect, visible?: boolean): void => {
		view.setBounds(bounds);
		if (visible !== undefined) view.setVisible?.(visible);
		view.setBorderRadius?.(BROWSER_VIEW_BORDER_RADIUS);
	};
	let pendingMirror: { viewId: string; expires: number; frame: WebFrameMain } | null = null;

	const sameFrame = (a: WebFrameMain, b: WebFrameMain | null | undefined): boolean =>
		Boolean(b) && a.processId === b!.processId && a.routingId === b!.routingId;

	const pushDevToolsState = (session: BrowserSessionEntry): BrowserDevToolsState => {
		const state: BrowserDevToolsState = {
			viewId: session.viewId,
			open: Boolean(session.devtools),
			activeTabId: session.activeTabId,
		};
		options.mainWindow.webContents.send("browser:devtoolsState", state);
		return state;
	};

	const devtoolsURL = (endpoint: string): string => {
		// Chromium's inspector frontend expects ws=<host/path>, not a nested
		// ws:// URL. Passing the scheme through URLSearchParams produces
		// ws=ws%3A%2F%2F..., which loads the frontend but leaves it disconnected.
		const parsed = new URL(endpoint);
		const websocketTarget = `${parsed.host}${parsed.pathname}${parsed.search}`;
		// This endpoint is page-shaped, so use the inspector's normal frame target.
		// targetType=tab expects Chromium to provide a separate child page target;
		// forcing it here creates the empty intermediary target surface. Omit
		// can_dock as well so the window stays detached and non-dockable.
		const query = new URLSearchParams({ ws: websocketTarget });
		return `devtools://devtools/bundled/inspector.html?${query.toString()}`;
	};

	const destroyDevTools = (session: BrowserSessionEntry): void => {
		const devtools = session.devtools;
		if (!devtools) return;
		session.devtools = undefined;
		if (!devtools.window.isDestroyed?.()) devtools.window.close();
		pushDevToolsState(session);
	};

	const displayMediaSession = options.mainWindow.webContents.session;
	const mirrorSupported = Boolean(displayMediaSession?.setDisplayMediaRequestHandler);
	if (mirrorSupported) {
		displayMediaSession!.setDisplayMediaRequestHandler((request, callback) => {
			const pending = pendingMirror;
			pendingMirror = null;
			const session =
				pending && pending.expires > Date.now() && sameFrame(pending.frame, request.frame)
					? entries.get(pending.viewId)
					: undefined;
			try {
				if (session) {
					callback({ video: activeEntry(session).view.webContents.mainFrame });
				} else {
					callback({});
				}
			} catch {
				return;
			}
		});
		ipcDisposers.push(() => {
			try {
				displayMediaSession?.setDisplayMediaRequestHandler(null);
			} catch {
				return;
			}
		});
	}

	const createTab = (session: BrowserSessionEntry, activate: boolean): BrowserEntry => {
		if (session.tabs.size >= MAX_BROWSER_TABS) {
			throw browserError("BROWSER_TAB_LIMIT", `Browser tab limit of ${MAX_BROWSER_TABS} reached`);
		}
		const view = new options.WebContentsView({
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				partition: session.profilePartition,
				preload: options.annotatePreloadPath,
				sandbox: true,
			},
		});
		applyBrowserViewBounds(view, OFFSCREEN_BOUNDS, false);
		options.mainWindow.contentView.addChildView(view);
		view.setBorderRadius?.(BROWSER_VIEW_BORDER_RADIUS);
		view.webContents.session?.setPermissionCheckHandler?.(() => false);
		view.webContents.session?.setPermissionRequestHandler?.((_contents, _permission, callback) => callback(false));

		const tabId = `t${session.nextTabNumber++}`;
		const state: BrowserNavState = emptyNavState(session.viewId);
		const entry: BrowserEntry = {
			sessionId: session.sessionId,
			tabId,
			view,
			state,
			annotationEnabled: false,
		};
		session.tabs.set(tabId, entry);
		tabsByWebContentsId.set(view.webContents.id, entry);
		hardenWebContents(view.webContents, options, entry, () => {
			const popup = createTab(session, true);
			pushTabsState(options, session, { kind: "popup", tabId: popup.tabId });
			return popup.view.webContents;
		}, () => session.tabs.size < MAX_BROWSER_TABS);
		wireNavEvents(
			view.webContents,
			options,
			entry,
			() => entries.get(session.viewId)?.activeTabId === entry.tabId,
			() => applySessionBounds(session, entry),
			() => pushTabsState(options, session),
			() => {
				if (session.agentStatusActive) void enqueueAgentStatus(session, true, entry);
			},
		);
		wireAutomationEvents(view.webContents, entry);
		// The preview is a separate WebContentsView, so renderer-window keydown
		// listeners never see keys typed here. Forward application shortcuts to the
		// shell renderer so they still work with the panel focused.
		attachAppShortcuts(
			view.webContents,
			Boolean(options.isMac),
			options.mainWindow.webContents,
			true,
			options.getKeybindingOverrides,
			options.isKeybindingRecording,
			(id) => {
				if (id !== "toggle-browser-devtools") return;
				lastFocusedViewId = session.viewId;
				void devtoolsAction(session, "toggle")
					.then((state) => {
						if (state.open) session.devtools?.window.focus();
					})
					.catch(() => undefined);
			},
		);
		view.webContents.on("focus", () => {
			lastFocusedViewId = session.viewId;
		});
		if (activate) activateTab(session, tabId, false);
		return entry;
	};

	const ensureSession = (sessionId: string, rendererId?: number): BrowserSessionEntry => {
		const existingViewId = viewIdsBySessionId.get(sessionId);
		const viewId = existingViewId ?? `${rendererId ?? 0}:${sessionId}`;
		let session = entries.get(viewId);
		if (!session) {
			session = {
				sessionId,
				viewId,
				// A non-persist: Electron partition is memory-only. Every tab in
				// this worker shares it, while a fresh worker runtime receives a
				// different partition even if a session ID is ever reused.
				profilePartition: `ao-browser-${randomUUID()}`,
				tabs: new Map(),
				activeTabId: "",
				nextTabNumber: 1,
				bounds: OFFSCREEN_BOUNDS,
				rendererBounds: OFFSCREEN_BOUNDS,
				zoomFactor: 1,
				visible: false,
				parked: false,
				agentBrowserCommands: 0,
				agentStatusActive: false,
				agentStatusQueue: Promise.resolve(),
			};
			entries.set(viewId, session);
			viewIdsBySessionId.set(sessionId, viewId);
			createTab(session, true);
		}
		if (rendererId !== undefined) {
			const owners = rendererOwnersByViewId.get(viewId) ?? new Set<number>();
			owners.add(rendererId);
			rendererOwnersByViewId.set(viewId, owners);
		}
		return session;
	};

	const openTab = async (
		session: BrowserSessionEntry,
		url: string | undefined,
		activate: boolean,
		reason: "opened" | "popup" = "opened",
	): Promise<BrowserEntry> => {
		let normalizedURL: string | undefined;
		if (url) {
			const normalized = normalizeBrowserURL(url);
			if (!isAllowedBrowserURL(normalized.href, options.rendererOrigin)) {
				throw browserError("NAVIGATION_FAILED", "Unsupported browser URL");
			}
			normalizedURL = normalized.href;
		}
		const entry = createTab(session, activate);
		if (normalizedURL) {
			const navigation = navigateEntry(entry, normalizedURL);
			pushTabsState(options, session, { kind: reason, tabId: entry.tabId });
			const state = await navigation;
			if (state.error) throw browserError("NAVIGATION_FAILED", state.error);
		} else {
			pushTabsState(options, session, { kind: reason, tabId: entry.tabId });
		}
		return entry;
	};

	function activateTab(session: BrowserSessionEntry, tabId: string, notify = true): BrowserEntry {
		const next = session.tabs.get(tabId);
		if (!next) throw browserError("TAB_NOT_FOUND", `Browser tab ${tabId} does not exist`);
		const previous = session.tabs.get(session.activeTabId);
		if (previous && previous !== next) {
			applyBrowserViewBounds(previous.view, OFFSCREEN_BOUNDS, false);
		}
		session.activeTabId = tabId;
		applySessionBounds(session, next);
		if (session.agentStatusActive) void enqueueAgentStatus(session, true, next);
		pushNavState(options, next);
		if (notify) pushTabsState(options, session, { kind: "selected", tabId });
		if (session.devtools) pushDevToolsState(session);
		if (session.devtools && session.devtools.targetTabId !== tabId) {
			void retargetDevTools(session, tabId).catch(() => undefined);
		}
		return next;
	}

	function closeTab(session: BrowserSessionEntry, tabId = session.activeTabId): BrowserTabsState {
		if (session.tabs.size === 1) {
			throw browserError("CANNOT_CLOSE_LAST_TAB", "The only browser tab cannot be closed");
		}
		const tab = session.tabs.get(tabId);
		if (!tab) throw browserError("TAB_NOT_FOUND", `Browser tab ${tabId} does not exist`);
		const wasActive = tabId === session.activeTabId;
		disposeNetworkCapture(tab, "tab-closed");
		if (session.networkTabId === tabId) session.networkTabId = undefined;
		session.tabs.delete(tabId);
		tabsByWebContentsId.delete(tab.view.webContents.id);
		destroyTabView(tab);
		if (wasActive) {
			const nextTabId = [...session.tabs.keys()].at(-1)!;
			activateTab(session, nextTabId, false);
		}
		const state = listTabs(session, { kind: "closed", tabId });
		options.mainWindow.webContents.send("browser:tabsState", state);
		return state;
	}

	function agentBrowserTargets(session: BrowserSessionEntry): AgentBrowserTargetProvider {
		const target = (entry: BrowserEntry): AgentBrowserTarget => ({
			id: entry.tabId,
			url: entry.view.webContents.getURL() || "about:blank",
			title: entry.view.webContents.getTitle(),
			debugger: entry.view.webContents.debugger,
		});
		return {
			listTargets: () => [...session.tabs.values()].map(target),
			createTarget: async (url) => target(await openTab(session, url === "about:blank" ? undefined : url, true)),
			activateTarget: (targetId) => {
				activateTab(session, targetId);
			},
			closeTarget: (targetId) => {
				closeTab(session, targetId);
			},
		};
	}

	const retargetDevTools = async (
		session: BrowserSessionEntry,
		tabId = session.activeTabId,
		reveal = false,
	): Promise<BrowserDevToolsState> => {
		const devtools = session.devtools;
		if (!devtools) return pushDevToolsState(session);
		const entry = session.tabs.get(tabId);
		if (!entry) throw browserError("TAB_NOT_FOUND", `Browser tab ${tabId} does not exist`);
		if (!options.agentBrowserRuntime) {
			throw browserError("BROWSER_DEVTOOLS_UNAVAILABLE", "Browser DevTools are unavailable");
		}
		const endpoint = await options.agentBrowserRuntime.devtoolsEndpoint(
			session.sessionId,
			entry.tabId,
			agentBrowserTargets(session),
		);
		await devtools.window.webContents.loadURL(devtoolsURL(endpoint));
		devtools.targetTabId = entry.tabId;
		if (reveal) {
			devtools.window.show();
			devtools.window.focus();
		}
		return pushDevToolsState(session);
	};

	const openDevTools = async (
		session: BrowserSessionEntry,
	): Promise<BrowserDevToolsState> => {
		const entry = activeEntry(session);
		if (!options.agentBrowserRuntime || !options.createDevToolsWindow) {
			throw browserError("BROWSER_DEVTOOLS_UNAVAILABLE", "Browser DevTools are unavailable");
		}
		if (!session.devtools || session.devtools.window.isDestroyed?.()) {
			const window = options.createDevToolsWindow();
			// The detached DevTools window is outside the shell renderer, so keep
			// the application-owned toggle shortcut available while it is focused.
			attachAppShortcuts(
				window.webContents,
				Boolean(options.isMac),
				options.mainWindow.webContents,
				false,
				options.getKeybindingOverrides,
				options.isKeybindingRecording,
				(id) => {
					if (id !== "toggle-browser-devtools") return;
					void devtoolsAction(session, "toggle")
						.then((state) => {
							if (state.open) session.devtools?.window.focus();
							else activeEntry(session).view.webContents.focus?.();
						})
						.catch(() => undefined);
				},
			);
			window.on("closed", () => {
				if (session.devtools?.window !== window) return;
				session.devtools = undefined;
				pushDevToolsState(session);
			});
			session.devtools = { window, targetTabId: entry.tabId };
		}
		return retargetDevTools(session, entry.tabId, true);
	};

	const devtoolsAction = async (
		session: BrowserSessionEntry,
		operation: InternalBrowserDevToolsOperation,
	): Promise<BrowserDevToolsState> => {
		switch (operation) {
			case "open":
				return openDevTools(session);
			case "toggle":
				if (session.devtools) {
					destroyDevTools(session);
					return pushDevToolsState(session);
				}
				return openDevTools(session);
			case "close":
				destroyDevTools(session);
				return pushDevToolsState(session);
		}
	};

	function applySessionBounds(session: BrowserSessionEntry, entry: BrowserEntry): void {
		if (!session.visible) {
			applyBrowserViewBounds(entry.view, OFFSCREEN_BOUNDS, false);
			return;
		}
		applyBrowserViewBounds(
			entry.view,
			session.bounds,
			session.parked || (session.bounds.width > 0 && session.bounds.height > 0),
		);
	}

	const isRendererOwned = (event: IpcMainInvokeEvent | IpcMainEvent, viewId: string): boolean =>
		rendererOwnersByViewId.get(viewId)?.has(event.sender.id) ?? false;

	const setBounds = ({ viewId, rect, visible, parked }: BrowserBoundsInput, zoomFactor = 1): void => {
		const session = entries.get(viewId);
		if (!session) return;
		const effectiveZoomFactor = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
		session.zoomFactor = effectiveZoomFactor;
		const entry = activeEntry(session);
		if (parked) {
			const scaled = scaleBoundsForZoom(rect, effectiveZoomFactor);
			const width = Math.max(1, Math.round(scaled.width));
			const height = Math.max(1, Math.round(scaled.height));
			session.bounds = { x: OFFSCREEN_BOUNDS.x, y: 0, width, height };
			session.visible = true;
			session.parked = true;
			applySessionBounds(session, entry);
			return;
		}
		if (!visible) {
			session.bounds = OFFSCREEN_BOUNDS;
			session.visible = false;
			session.parked = false;
			applySessionBounds(session, entry);
			forgetIfFocused(viewId);
			return;
		}
		// The renderer measures the slot in page-zoomed CSS pixels, while
		// WebContentsView bounds are window coordinates. Convert before clamping so
		// Cmd+/Cmd- page zoom does not detach the native view from its React slot.
		session.rendererBounds = { ...rect };
		session.bounds = clampBoundsToWindow(
			scaleBoundsForZoom(rect, effectiveZoomFactor),
			options.mainWindow.getContentBounds(),
		);
		session.visible = true;
		session.parked = false;
		applySessionBounds(session, entry);
		// The shell toolbar can receive focus immediately after the Browser panel
		// becomes visible. Remember that active panel too, so the DevTools shortcut
		// still targets the browser even when the native page itself is not focused.
		lastFocusedViewId = viewId;
	};

	const navigate = async ({ viewId, url }: BrowserNavigateInput): Promise<BrowserNavState> => {
		const session = entries.get(viewId);
		if (!session) throw browserError("BROWSER_TARGET_UNAVAILABLE", "Browser target is unavailable");
		return navigateEntry(activeEntry(session), url);
	};

	const navigateEntry = async (entry: BrowserEntry, url: string): Promise<BrowserNavState> => {
		cancelAnnotation(options, entry, "navigation");
		const normalized = normalizeBrowserURL(url);
		if (!isAllowedBrowserURL(normalized.href, options.rendererOrigin)) {
			throw new Error("Unsupported browser URL");
		}
		try {
			await entry.view.webContents.loadURL(normalized.href);
		} catch (err) {
			if ((err as { errorCode?: number })?.errorCode === -3) return pushNavState(options, entry);
			entry.view.setVisible?.(false);
			entry.state = { ...readNavState(entry), error: String((err as Error)?.message || "Unable to load page") };
			options.mainWindow.webContents.send("browser:navState", entry.state);
			return entry.state;
		}
		const session = entries.get(entry.state.viewId);
		if (session?.activeTabId === entry.tabId) applySessionBounds(session, entry);
		return pushNavState(options, entry);
	};

	// clear resets the view to a blank page (`ao preview clear`). about:blank is
	// loaded directly, bypassing the URL allowlist — it carries no content and
	// readNavState normalizes it back to an empty url so the panel shows its
	// empty state.
	const clear = async (viewId: string): Promise<BrowserNavState> => {
		const session = entries.get(viewId);
		if (!session) throw browserError("BROWSER_TARGET_UNAVAILABLE", "Browser target is unavailable");
		const entry = activeEntry(session);
		cancelAnnotation(options, entry, "navigation");
		session.visible = false;
		session.parked = false;
		session.bounds = OFFSCREEN_BOUNDS;
		applySessionBounds(session, entry);
		forgetIfFocused(viewId);
		await entry.view.webContents.loadURL("about:blank");
		entry.view.webContents.clearHistory();
		return pushNavState(options, entry);
	};

	const capture = async (viewId: string): Promise<BrowserMirrorFrame | null> => {
		const session = entries.get(viewId);
		if (!session) return null;
		const entry = activeEntry(session);
		try {
			const image = await entry.view.webContents.capturePage();
			if (image.isEmpty()) return null;
			const size = image.getSize();
			const dataUrl = `data:image/jpeg;base64,${image.toJPEG(70).toString("base64")}`;
			return {
				dataUrl,
				pixelWidth: size.width,
				pixelHeight: size.height,
				nativeBounds: { ...session.bounds },
				cssLeft: session.bounds.x / session.zoomFactor - session.rendererBounds.x,
				cssTop: session.bounds.y / session.zoomFactor - session.rendererBounds.y,
				cssWidth: session.bounds.width / session.zoomFactor,
				cssHeight: session.bounds.height / session.zoomFactor,
			};
		} catch {
			return null;
		}
	};

	const destroy = (viewId: string): void => {
		const session = entries.get(viewId);
		if (!session) return;
		if (options.mainWindow.isDestroyed?.()) session.devtools = undefined;
		else destroyDevTools(session);
		void options.agentBrowserRuntime?.closeSession(session.sessionId);
		entries.delete(viewId);
		viewIdsBySessionId.delete(session.sessionId);
		rendererOwnersByViewId.delete(viewId);
		forgetIfFocused(viewId);
		// When the window is already gone (dispose fired from mainWindow "closed"),
		// Electron has torn down contentView and the child WebContentsViews. Touching
		// them throws "Object has been destroyed", so just drop our reference.
		if (options.mainWindow.isDestroyed?.()) {
			for (const entry of session.tabs.values()) {
				tabsByWebContentsId.delete(entry.view.webContents.id);
				disposeNetworkCapture(entry, "session-closed");
			}
			return;
		}
		for (const entry of session.tabs.values()) {
			tabsByWebContentsId.delete(entry.view.webContents.id);
			disposeNetworkCapture(entry, "session-closed");
			destroyTabView(entry);
		}
	};

	const destroyTabView = (entry: BrowserEntry): void => {
		applyBrowserViewBounds(entry.view, OFFSCREEN_BOUNDS, false);
		options.mainWindow.contentView.removeChildView?.(entry.view);
		if (entry.view.webContents.debugger?.isAttached()) {
			entry.view.webContents.debugger.detach();
		}
		entry.view.webContents.close?.();
	};

	const invokeNav = (
		viewId: string,
		action: (contents: BrowserWebContents) => void,
		cancelForNavigation = false,
	): BrowserNavState => {
		const session = entries.get(viewId);
		if (!session) return emptyNavState(viewId);
		const entry = activeEntry(session);
		if (cancelForNavigation) {
			cancelAnnotation(options, entry, "navigation");
			applySessionBounds(session, entry);
		}
		action(entry.view.webContents);
		return pushNavState(options, entry);
	};

	const setAnnotationMode = (event: IpcMainInvokeEvent, input: BrowserAnnotationModeInput): void => {
		if (!isRendererOwned(event, input.viewId)) return;
		const session = entries.get(input.viewId);
		if (!session) return;
		const entry = activeEntry(session);
		entry.annotationEnabled = input.enabled;
		entry.view.webContents.send("browser:annotation:setMode", { enabled: input.enabled });
	};

	const forwardAnnotationSubmit = (
		event: IpcMainEvent,
		payload: BrowserAnnotationPageSubmitPayload | undefined,
	): void => {
		const entry = tabsByWebContentsId.get(event.sender.id);
		const viewId = entry?.state.viewId;
		if (
			!viewId ||
			!entry ||
			!payload ||
			typeof payload.instruction !== "string" ||
			typeof payload.context !== "object" ||
			payload.context === null
		) {
			return;
		}
		entry.annotationEnabled = false;
		const forwarded: BrowserAnnotationSubmitPayload = {
			viewId,
			instruction: payload.instruction,
			context: payload.context,
		};
		options.mainWindow.webContents.send("browser:annotation:submitted", forwarded);
	};

	const forwardAnnotationCancel = (
		event: IpcMainEvent,
		payload: BrowserAnnotationPageCancelPayload | undefined,
	): void => {
		const entry = tabsByWebContentsId.get(event.sender.id);
		const viewId = entry?.state.viewId;
		if (!viewId || !entry) return;
		entry.annotationEnabled = false;
		const forwarded: BrowserAnnotationCancelPayload = {
			viewId,
			reason: payload?.reason ?? "cancel",
		};
		options.mainWindow.webContents.send("browser:annotation:canceled", forwarded);
	};

	const handle = <Args extends unknown[], Result>(
		channel: string,
		fn: (event: IpcMainInvokeEvent, ...args: Args) => Result,
	): void => {
		options.ipcMain.handle(channel, fn);
		ipcDisposers.push(() => options.ipcMain.removeHandler(channel));
	};
	const on = <Args extends unknown[]>(channel: string, fn: (event: IpcMainEvent, ...args: Args) => void): void => {
		options.ipcMain.on(channel, fn);
		ipcDisposers.push(() => options.ipcMain.off(channel, fn));
	};

	handle("browser:ensure", (event, sessionId: string) => {
		const session = ensureSession(sessionId, event.sender.id);
		pushDevToolsState(session);
		return pushNavState(options, activeEntry(session));
	});
	handle("browser:setAgentStatus", (event, input: BrowserAgentStatusInput) => {
		if (!input || typeof input.viewId !== "string" || typeof input.active !== "boolean") return;
		if (!isRendererOwned(event, input.viewId)) return;
		const session = entries.get(input.viewId);
		if (!session) return;
		session.agentStatusActive = input.active;
		return enqueueAgentStatus(session, input.active);
	});
	on("browser:setBounds", (event, input: BrowserBoundsInput) => {
		if (isRendererOwned(event, input.viewId)) setBounds(input, event.sender.getZoomFactor());
	});
	handle("browser:navigate", (event, input: BrowserNavigateInput) =>
		isRendererOwned(event, input.viewId) ? navigate(input) : emptyNavState(input.viewId),
	);
	handle("browser:clear", (event, viewId: string) =>
		isRendererOwned(event, viewId) ? clear(viewId) : emptyNavState(viewId),
	);
	handle("browser:capture", (event, viewId: string) => (isRendererOwned(event, viewId) ? capture(viewId) : null));
	handle("browser:requestMirror", (event, viewId: string) => {
		if (!mirrorSupported || !isRendererOwned(event, viewId) || !entries.has(viewId)) return false;
		const frame = event.senderFrame;
		if (!frame) return false;
		pendingMirror = { viewId, expires: Date.now() + 5000, frame };
		return true;
	});
	handle("browser:goBack", (event, viewId: string) =>
		isRendererOwned(event, viewId) ? invokeNav(viewId, (contents) => contents.goBack(), true) : emptyNavState(viewId),
	);
	handle("browser:goForward", (event, viewId: string) =>
		isRendererOwned(event, viewId)
			? invokeNav(viewId, (contents) => contents.goForward(), true)
			: emptyNavState(viewId),
	);
	handle("browser:reload", (event, viewId: string) =>
		isRendererOwned(event, viewId) ? invokeNav(viewId, (contents) => contents.reload(), true) : emptyNavState(viewId),
	);
	handle("browser:stop", (event, viewId: string) =>
		isRendererOwned(event, viewId) ? invokeNav(viewId, (contents) => contents.stop()) : emptyNavState(viewId),
	);
	handle("browser:getTabs", (event, viewId: string) => {
		const session = entries.get(viewId);
		return session && isRendererOwned(event, viewId) ? listTabs(session) : emptyTabsState(viewId);
	});
	handle("browser:selectTab", (event, input: BrowserTabInput) => {
		const session = entries.get(input.viewId);
		if (!session || !isRendererOwned(event, input.viewId)) return emptyTabsState(input.viewId);
		activateTab(session, input.tabId);
		return listTabs(session);
	});
	handle("browser:closeTab", (event, input: BrowserTabInput) => {
		const session = entries.get(input.viewId);
		return session && isRendererOwned(event, input.viewId)
			? closeTab(session, input.tabId)
			: emptyTabsState(input.viewId);
	});
	handle("browser:devtools", (event, input: BrowserDevToolsInput) => {
		if (!input || typeof input.viewId !== "string" || !isRendererOwned(event, input.viewId)) {
			return emptyDevToolsState(input?.viewId ?? "");
		}
		const session = entries.get(input.viewId);
		if (!session) return emptyDevToolsState(input.viewId);
		if (!["open", "close"].includes(input.operation)) {
			throw browserError("INVALID_ARGUMENT", "Unsupported browser DevTools operation");
		}
		return devtoolsAction(session, input.operation);
	});
	handle("browser:annotation:setMode", (event, input: BrowserAnnotationModeInput) => setAnnotationMode(event, input));
	on("browser:destroy", (event, viewId: string) => {
		if (isRendererOwned(event, viewId)) destroy(viewId);
	});
	on("browser:annotation:submit", (event, payload: BrowserAnnotationPageSubmitPayload) =>
		forwardAnnotationSubmit(event, payload),
	);
	on("browser:annotation:cancel", (event, payload: BrowserAnnotationPageCancelPayload) =>
		forwardAnnotationCancel(event, payload),
	);

	return {
		execute: async (sessionId, action, args = {}, signal) => {
			throwIfAborted(signal);
			if (!sessionId.trim()) throw browserError("INVALID_ARGUMENT", "sessionId is required");
			if (action === "__destroy-session") {
				const viewId = viewIdsBySessionId.get(sessionId);
				await options.agentBrowserRuntime?.closeSession(sessionId);
				if (viewId) destroy(viewId);
				return { destroyed: Boolean(viewId) };
			}
			const session = ensureSession(sessionId);
			const entry = activeEntry(session);
			const agentTabId = entry.tabId;
			const runNative = async (nativeAction: string, nativeArgs: Record<string, unknown> = {}) => {
				if (!options.agentBrowserRuntime) {
					throw browserError("BROWSER_AUTOMATION_UNAVAILABLE", "Browser automation runtime is unavailable");
				}
				return options.agentBrowserRuntime.runAction(
					sessionId,
					nativeAction,
					nativeArgs,
					agentBrowserTargets(session),
					signal,
				);
			};
			const commandId = randomUUID();
			setAgentBrowserActivity(session, action, true, commandId, "started", agentTabId);
			try {
				switch (action) {
				case "open": {
					const url = stringArg(args, "url", "URL_REQUIRED", "url is required");
					await runNative(action, { url: normalizeAgentBrowserURL(url) });
					return pushNavState(options, activeEntry(session));
				}
				case "snapshot": {
					const result = await runNative(action, { interactive: Boolean(args.interactive) });
					if (typeof result.snapshot !== "string") {
						throw browserError("BROWSER_AUTOMATION_INVALID_OUTPUT", "Browser snapshot output was invalid");
					}
					return { text: result.snapshot, refs: result.refs, untrustedExternalContent: true };
				}
				case "click":
				case "dblclick":
				case "focus":
				case "hover":
				case "highlight":
				case "scrollintoview":
				case "check":
				case "uncheck":
					return runNative(action, { ref: stringArg(args, "ref", "REFERENCE_REQUIRED", "ref is required") });
				case "fill":
				case "type":
					return runNative(action, {
						ref: stringArg(args, "ref", "REFERENCE_REQUIRED", "ref is required"),
						text: stringArg(args, "text", "INVALID_ARGUMENT", "text is required", true),
					});
				case "press":
					return runNative(action, { key: stringArg(args, "key", "INVALID_ARGUMENT", "key is required") });
				case "drag":
					return runNative(action, {
						ref: stringArg(args, "ref", "REFERENCE_REQUIRED", "ref is required"),
						targetRef: stringArg(args, "targetRef", "REFERENCE_REQUIRED", "target ref is required"),
					});
				case "unhighlight":
					return unhighlightEntry(entry);
				case "tabs":
					return listTabs(session);
				case "tab-new": {
					const url =
						typeof args.url === "string" && args.url.trim() ? normalizeAgentBrowserURL(args.url) : undefined;
					await runNative(action, { url });
					return tabResult(activeEntry(session), true);
				}
				case "tab-select": {
					await runNative(action, { tabId: stringArg(args, "tabId", "TAB_ID_REQUIRED", "tabId is required") });
					return tabResult(activeEntry(session), true);
				}
				case "tab-close": {
					const tabId =
						typeof args.tabId === "string" && args.tabId.trim() ? args.tabId.trim() : session.activeTabId;
					await runNative(action, { tabId });
					return { closedTabId: tabId, ...listTabs(session) };
				}
				case "scroll":
					return runNative(action, {
						direction: stringArg(args, "direction", "INVALID_ARGUMENT", "direction is required"),
						amount: numberArg(args.amount, 1, 5_000) || 600,
					});
				case "select":
					return runNative(action, {
						ref: stringArg(args, "ref", "REFERENCE_REQUIRED", "ref is required"),
						value: stringArg(args, "value", "INVALID_ARGUMENT", "value is required", true),
					});
				case "get": {
					const property = stringArg(args, "property", "INVALID_ARGUMENT", "property is required");
					const result = await runNative(action, {
						property,
						ref: typeof args.ref === "string" && args.ref.trim() ? args.ref : undefined,
					});
					return { ...result, value: result.value ?? result[property] };
				}
				case "wait":
					return runNative(action, args);
				case "frame":
				case "dialog":
					return runNative(action, args);
				case "devtools-open":
				case "devtools-close":
				{
					const operation = action.slice("devtools-".length) as BrowserDevToolsInput["operation"];
					return devtoolsAction(session, operation);
				}
				case "screenshot":
					if (!options.agentBrowserRuntime) {
						throw browserError("BROWSER_AUTOMATION_UNAVAILABLE", "Browser automation runtime is unavailable");
					}
					return options.agentBrowserRuntime.screenshot(sessionId, agentBrowserTargets(session), signal);
				case "network-start":
					return startNetworkCapture(
						session,
						entry,
						networkDurationArg(args.durationSeconds),
					);
				case "network-status":
					return networkCaptureStatus(networkEntryFor(session));
				case "network-list":
					return networkCaptureResult(networkEntryFor(session));
				case "network-stop":
					return stopNetworkCapture(networkEntryFor(session), "stopped");
				case "network-clear":
					return clearNetworkCapture(networkEntryFor(session));
				case "console":
				case "errors":
					return normalizeNativeMessages(await runNative(action), action);
				default:
					throw browserError("INVALID_ARGUMENT", `Unsupported browser action: ${action}`);
				}
			} finally {
				setAgentBrowserActivity(session, action, false, commandId, "finished", agentTabId);
			}
		},
		dispose: () => {
			if (disposePromise) return disposePromise;
			disposePromise = (async () => {
				ipcDisposers.splice(0).forEach((dispose) => dispose());
				await options.agentBrowserRuntime?.dispose();
				for (const viewId of [...entries.keys()]) {
					destroy(viewId);
				}
			})();
			return disposePromise;
		},
		destroy,
		destroyAll: () => {
			for (const viewId of [...entries.keys()]) {
				destroy(viewId);
			}
		},
		getLastFocusedPanelContents: () => {
			if (lastFocusedViewId === null) return null;
			const session = entries.get(lastFocusedViewId);
			if (!session) return null;
			const entry = activeEntry(session);
			// Stored narrowed as BrowserWebContents but is a full WebContents at runtime.
			const contents = entry.view.webContents as unknown as WebContents;
			return contents.isDestroyed() ? null : contents;
		},
		toggleDevToolsForLastFocused: async () => {
			if (lastFocusedViewId === null) return null;
			const session = entries.get(lastFocusedViewId);
			if (!session) return null;
			return devtoolsAction(session, "toggle");
		},
		forgetLastFocusedPanel: () => {
			lastFocusedViewId = null;
		},
	};
}

function withDefaultScheme(raw: string): string {
	if (isWindowsAbsolutePath(raw) || isPosixAbsolutePath(raw)) return localPathToFileURL(raw);
	if (/^https?:\/\//i.test(raw)) return raw;
	if (isLocalhostLike(raw)) return `http://${raw}`;
	// A single token with no whitespace can be a destination: an explicit scheme
	// (file:, mailto:, ...) or a bare hostname we default to https. Anything else —
	// whitespace-containing text, or a lone word that is not a hostname — is a
	// search query, not a URL (Chrome-style omnibox behavior).
	if (!/\s/.test(raw)) {
		if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)) return raw;
		if (looksLikeHost(raw)) return `https://${raw}`;
	}
	return searchURL(raw);
}

// Treat input as a navigable host when the authority (the part before any
// path/query/fragment) is an IPv6 literal, carries an explicit :port, or has a
// dot (a domain). Bare words like "hi" fail this and become a search instead.
function looksLikeHost(raw: string): boolean {
	const host = raw.split(/[/?#]/, 1)[0];
	if (host === "") return false;
	if (host.startsWith("[") && host.includes("]")) return true;
	if (/:\d+$/.test(host)) return true;
	return host.includes(".");
}

function searchURL(query: string): string {
	return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function isWindowsAbsolutePath(raw: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(raw);
}

function isPosixAbsolutePath(raw: string): boolean {
	return raw.startsWith("/");
}

function localPathToFileURL(raw: string): string {
	if (isWindowsAbsolutePath(raw)) {
		const normalized = raw.replace(/\\/g, "/");
		return `file:///${encodePathSegments(normalized).replace(/^([A-Za-z])%3A(?=\/)/, "$1:")}`;
	}
	return `file://${encodePathSegments(raw)}`;
}

function encodePathSegments(pathname: string): string {
	return pathname.split("/").map(encodeURIComponent).join("/");
}

function isLocalhostLike(raw: string): boolean {
	return /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(raw);
}

function emptyNavState(viewId: string): BrowserNavState {
	return {
		viewId,
		url: "",
		title: "",
		canGoBack: false,
		canGoForward: false,
		isLoading: false,
	};
}

function emptyTabsState(viewId: string): BrowserTabsState {
	return { viewId, activeTabId: "", tabs: [] };
}

function emptyDevToolsState(viewId: string): BrowserDevToolsState {
	return { viewId, open: false, activeTabId: "" };
}

function activeEntry(session: BrowserSessionEntry): BrowserEntry {
	const entry = session.tabs.get(session.activeTabId);
	if (!entry) throw browserError("BROWSER_TARGET_UNAVAILABLE", "Active browser tab is unavailable");
	return entry;
}

function tabResult(entry: BrowserEntry, active: boolean): {
	id: string;
	url: string;
	title: string;
	active: boolean;
} {
	return {
		id: entry.tabId,
		url: entry.view.webContents.getURL(),
		title: entry.view.webContents.getTitle(),
		active,
	};
}

function listTabs(session: BrowserSessionEntry, change?: BrowserTabsState["change"]): BrowserTabsState {
	return {
		viewId: session.viewId,
		activeTabId: session.activeTabId,
		tabs: [...session.tabs.values()].map((entry) => tabResult(entry, entry.tabId === session.activeTabId)),
		...(change ? { change } : {}),
	};
}

function pushTabsState(
	options: BrowserViewHostOptions,
	session: BrowserSessionEntry,
	change?: BrowserTabsState["change"],
): BrowserTabsState {
	const state = listTabs(session, change);
	options.mainWindow.webContents.send("browser:tabsState", state);
	return state;
}

function hardenWebContents(
	contents: BrowserWebContents,
	options: BrowserViewHostOptions,
	entry: BrowserEntry,
	createPopup: () => BrowserWebContents,
	canCreatePopup: () => boolean,
): void {
	contents.setWindowOpenHandler(({ url }) => {
		if (!isAllowedBrowserURL(url, options.rendererOrigin) || !canCreatePopup()) {
			return { action: "deny" };
		}
		return {
			action: "allow",
			createWindow: () => createPopup() as WebContents,
		};
	});
	const blockUnsafeNavigation = (event: Electron.Event, url: string) => {
		if (!isAllowedBrowserURL(url, options.rendererOrigin)) {
			event.preventDefault();
			entry.state = { ...entry.state, error: "Unsupported browser URL" };
			options.mainWindow.webContents.send("browser:navState", entry.state);
		}
	};
	contents.on("will-navigate", blockUnsafeNavigation);
	contents.on("will-redirect", blockUnsafeNavigation);
}

function wireNavEvents(
	contents: BrowserWebContents,
	options: BrowserViewHostOptions,
	entry: BrowserEntry,
	isActive: () => boolean,
	syncActiveBounds: () => void,
	syncTabs: () => void,
	syncAgentStatus: () => void,
): void {
	const update = () => {
		syncTabs();
		if (isActive()) pushNavState(options, entry);
	};
	contents.on("did-navigate", () => {
		if (isActive()) syncActiveBounds();
		syncAgentStatus();
		update();
	});
	contents.on("did-navigate-in-page", update);
	contents.on("page-title-updated", update);
	contents.on("did-start-loading", () => {
		cancelAnnotation(options, entry, "navigation");
		update();
	});
	contents.on("did-stop-loading", () => {
		syncAgentStatus();
		update();
	});
	contents.on("did-fail-load", (_event, errorCode, errorDescription) => {
		if (errorCode === -3) return;
		if (isActive()) entry.view.setVisible?.(false);
		entry.state = { ...readNavState(entry), error: String(errorDescription || "Unable to load page") };
		if (isActive()) options.mainWindow.webContents.send("browser:navState", entry.state);
	});
}

function cancelAnnotation(
	options: BrowserViewHostOptions,
	entry: BrowserEntry,
	reason: BrowserAnnotationCancelPayload["reason"],
): void {
	if (!entry.annotationEnabled) return;
	entry.annotationEnabled = false;
	entry.view.webContents.send("browser:annotation:setMode", { enabled: false });
	options.mainWindow.webContents.send("browser:annotation:canceled", { viewId: entry.state.viewId, reason });
}

function pushNavState(options: BrowserViewHostOptions, entry: BrowserEntry): BrowserNavState {
	entry.state = readNavState(entry);
	options.mainWindow.webContents.send("browser:navState", entry.state);
	return entry.state;
}

function readNavState(entry: BrowserEntry): BrowserNavState {
	const { webContents } = entry.view;
	const currentURL = webContents.getURL();
	return {
		viewId: entry.state.viewId,
		// about:blank is the cleared/blank state — surface it as an empty url so
		// the panel renders its "enter a URL" empty state and the address bar is
		// blank rather than showing "about:blank".
		url: currentURL === "about:blank" ? "" : currentURL,
		title: webContents.getTitle(),
		canGoBack: webContents.canGoBack(),
		canGoForward: webContents.canGoForward(),
		isLoading: webContents.isLoading(),
	};
}

function wireAutomationEvents(contents: BrowserWebContents, entry: BrowserEntry): void {
	contents.debugger?.on("message", (_event, method, params) => {
		handleNetworkDebuggerEvent(entry, method, params as Record<string, unknown>);
	});
}


async function ensureDebugger(entry: BrowserEntry): Promise<void> {
	const debug = entry.view.webContents.debugger;
	if (!debug) throw browserError("BROWSER_TARGET_UNAVAILABLE", "Browser debugger is unavailable");
	if (!debug.isAttached()) {
		try {
			debug.attach("1.3");
		} catch (error) {
			throw browserError(
				"BROWSER_TARGET_UNAVAILABLE",
				error instanceof Error ? error.message : "Unable to attach to browser target",
			);
		}
	}
	await debug.sendCommand("Runtime.enable");
	await debug.sendCommand("DOM.enable");
}

function networkEntryFor(session: BrowserSessionEntry): BrowserEntry {
	if (session.networkTabId) {
		const captured = session.tabs.get(session.networkTabId);
		if (captured) return captured;
		session.networkTabId = undefined;
	}
	return activeEntry(session);
}

async function startNetworkCapture(
	session: BrowserSessionEntry,
	entry: BrowserEntry,
	durationSeconds: number,
): Promise<unknown> {
	const existing = networkEntryFor(session);
	if (existing.networkCapture?.active) {
		return { ...networkCaptureStatus(existing), alreadyActive: true };
	}
	if (existing !== entry) disposeNetworkCapture(existing, "restarted");
	disposeNetworkCapture(entry, "restarted");
	await ensureDebugger(entry);
	await entry.view.webContents.debugger.sendCommand("Network.enable");
	const started = Date.now();
	const capture: BrowserNetworkCapture = {
		active: true,
		tabId: entry.tabId,
		startedAt: new Date(started).toISOString(),
		expiresAt: new Date(started + durationSeconds * 1_000).toISOString(),
		maxEntries: MAX_NETWORK_REQUESTS,
		nextSequence: 1,
		requests: [],
		byRequestId: new Map(),
	};
	capture.timer = setTimeout(() => {
		void stopNetworkCapture(entry, "expired");
	}, durationSeconds * 1_000);
	entry.networkCapture = capture;
	session.networkTabId = entry.tabId;
	return networkCaptureStatus(entry);
}

function networkCaptureStatus(entry: BrowserEntry): Record<string, unknown> {
	const capture = entry.networkCapture;
	if (!capture) {
		return {
			active: false,
			metadataOnly: true,
			tabId: entry.tabId,
			requestCount: 0,
			maxEntries: MAX_NETWORK_REQUESTS,
		};
	}
	return {
		active: capture.active,
		metadataOnly: true,
		tabId: capture.tabId,
		requestCount: capture.requests.length,
		maxEntries: capture.maxEntries,
		startedAt: capture.startedAt,
		expiresAt: capture.expiresAt,
		...(capture.stoppedAt ? { stoppedAt: capture.stoppedAt } : {}),
		...(capture.stopReason ? { stopReason: capture.stopReason } : {}),
	};
}

function networkCaptureResult(entry: BrowserEntry): Record<string, unknown> {
	return {
		...networkCaptureStatus(entry),
		requests: (entry.networkCapture?.requests ?? []).map(publicNetworkRequest),
		untrustedExternalContent: true,
	};
}

async function stopNetworkCapture(entry: BrowserEntry, reason: string): Promise<Record<string, unknown>> {
	const capture = entry.networkCapture;
	if (!capture?.active) return networkCaptureResult(entry);
	if (capture.timer) {
		clearTimeout(capture.timer);
		capture.timer = undefined;
	}
	capture.active = false;
	capture.stoppedAt = new Date().toISOString();
	capture.stopReason = reason;
	try {
		await entry.view.webContents.debugger.sendCommand("Network.disable");
	} catch {
		// The target may have closed while an expiry timer was firing. The in-memory
		// capture is still safely stopped and can be discarded with the tab.
	}
	return networkCaptureResult(entry);
}

function clearNetworkCapture(entry: BrowserEntry): Record<string, unknown> {
	const capture = entry.networkCapture;
	if (capture) {
		capture.requests = [];
		capture.byRequestId.clear();
	}
	return networkCaptureStatus(entry);
}

function disposeNetworkCapture(entry: BrowserEntry, reason: string): void {
	const capture = entry.networkCapture;
	if (!capture) return;
	const wasActive = capture.active;
	if (capture.timer) clearTimeout(capture.timer);
	capture.timer = undefined;
	capture.active = false;
	capture.stoppedAt = new Date().toISOString();
	capture.stopReason = reason;
	try {
		if (wasActive && entry.view.webContents.debugger?.isAttached()) {
			void entry.view.webContents.debugger.sendCommand("Network.disable").catch(() => undefined);
		}
	} catch {
		// Electron may already have destroyed the target during window shutdown.
	}
}

function handleNetworkDebuggerEvent(entry: BrowserEntry, method: string, params: Record<string, unknown>): void {
	const capture = entry.networkCapture;
	if (!capture?.active || !method.startsWith("Network.")) return;

	const requestID = typeof params.requestId === "string" ? params.requestId : "";
	if (!requestID) return;
	const timestamp = finiteNumber(params.timestamp);

	if (method === "Network.requestWillBeSent") {
		const request = objectValue(params.request);
		const url = typeof request.url === "string" ? request.url : "";
		const previous = capture.byRequestId.get(requestID);
		const redirect = objectValue(params.redirectResponse);
		if (previous && Object.keys(redirect).length > 0) {
			applyNetworkResponse(previous, redirect);
			finishNetworkRequest(previous, timestamp);
			previous.redirectedTo = sanitizeNetworkURL(url);
		}
		const wallTime = finiteNumber(params.wallTime);
		const item: InternalBrowserNetworkRequest = {
			id: `n${capture.nextSequence++}`,
			protocolRequestId: requestID,
			method: typeof request.method === "string" ? request.method : "GET",
			url: sanitizeNetworkURL(url),
			resourceType: typeof params.type === "string" ? params.type.toLowerCase() : undefined,
			startedAt: wallTime ? new Date(wallTime * 1_000).toISOString() : new Date().toISOString(),
			startedMonotonic: timestamp,
			requestHeaders: selectedNetworkHeaders(request.headers, "request"),
		};
		appendNetworkRequest(capture, item);
		capture.byRequestId.set(requestID, item);
		return;
	}

	const item = capture.byRequestId.get(requestID);
	if (!item) return;
	switch (method) {
		case "Network.responseReceived":
			applyNetworkResponse(item, objectValue(params.response));
			break;
		case "Network.loadingFinished":
			finishNetworkRequest(item, timestamp);
			break;
		case "Network.loadingFailed":
			item.failed = true;
			item.canceled = params.canceled === true;
			item.errorText = typeof params.errorText === "string" ? params.errorText : "Request failed";
			finishNetworkRequest(item, timestamp);
			break;
		case "Network.requestServedFromCache":
			item.fromCache = true;
			break;
	}
}

function applyNetworkResponse(item: InternalBrowserNetworkRequest, response: Record<string, unknown>): void {
	const status = finiteNumber(response.status);
	if (status !== undefined) item.status = status;
	if (typeof response.statusText === "string" && response.statusText) item.statusText = response.statusText;
	if (typeof response.mimeType === "string" && response.mimeType) item.mimeType = response.mimeType;
	item.fromCache =
		item.fromCache === true ||
		response.fromDiskCache === true ||
		response.fromPrefetchCache === true;
	item.fromServiceWorker = response.fromServiceWorker === true;
	item.responseHeaders = selectedNetworkHeaders(response.headers, "response");
}

function finishNetworkRequest(item: InternalBrowserNetworkRequest, timestamp: number | undefined): void {
	if (timestamp !== undefined && item.startedMonotonic !== undefined) {
		item.durationMs = Math.max(0, Math.round((timestamp - item.startedMonotonic) * 1_000));
	}
}

function appendNetworkRequest(capture: BrowserNetworkCapture, item: InternalBrowserNetworkRequest): void {
	capture.requests.push(item);
	if (capture.requests.length <= capture.maxEntries) return;
	const removed = capture.requests.shift();
	if (removed && capture.byRequestId.get(removed.protocolRequestId) === removed) {
		capture.byRequestId.delete(removed.protocolRequestId);
	}
}

function publicNetworkRequest(item: InternalBrowserNetworkRequest): BrowserNetworkRequest {
	const { protocolRequestId: _protocolRequestId, startedMonotonic: _startedMonotonic, ...result } = item;
	return result;
}

const SAFE_REQUEST_HEADERS = new Set([
	"accept",
	"content-type",
	"origin",
	"referer",
	"sec-fetch-mode",
	"sec-fetch-site",
]);
const SAFE_RESPONSE_HEADERS = new Set([
	"access-control-allow-headers",
	"access-control-allow-methods",
	"access-control-allow-origin",
	"cache-control",
	"content-length",
	"content-type",
	"location",
	"vary",
]);

function selectedNetworkHeaders(value: unknown, kind: "request" | "response"): Record<string, string> | undefined {
	const headers = objectValue(value);
	const allowed = kind === "request" ? SAFE_REQUEST_HEADERS : SAFE_RESPONSE_HEADERS;
	const selected: Record<string, string> = {};
	for (const [rawName, rawValue] of Object.entries(headers)) {
		const name = rawName.toLowerCase();
		if (!allowed.has(name)) continue;
		let headerValue = typeof rawValue === "string" ? rawValue : String(rawValue);
		if (name === "referer" || name === "location") headerValue = sanitizeNetworkURL(headerValue);
		selected[name] = headerValue.slice(0, 1_000);
	}
	return Object.keys(selected).length > 0 ? selected : undefined;
}

function sanitizeNetworkURL(raw: string): string {
	try {
		const url = new URL(raw);
		if (!["http:", "https:", "file:"].includes(url.protocol)) {
			return `${url.protocol}[redacted]`;
		}
		url.username = "";
		url.password = "";
		url.hash = "";
		for (const name of [...url.searchParams.keys()]) {
			url.searchParams.set(name, "[redacted]");
		}
		return url.href;
	} catch {
		const withoutFragment = raw.split("#", 1)[0] ?? "";
		return (withoutFragment.split("?", 1)[0] ?? "").slice(0, 2_000);
	}
}

function objectValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}


async function unhighlightEntry(entry: BrowserEntry): Promise<unknown> {
	await ensureDebugger(entry);
	await entry.view.webContents.debugger.sendCommand("Overlay.enable");
	await entry.view.webContents.debugger.sendCommand("Overlay.hideHighlight");
	return { url: entry.view.webContents.getURL() };
}


function stringArg(
	args: Record<string, unknown>,
	name: string,
	code: string,
	message: string,
	allowEmpty = false,
): string {
	const value = args[name];
	if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw browserError(code, message);
	return value;
}


function numberArg(value: unknown, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(min, Math.min(max, Math.round(value)));
}

function networkDurationArg(value: unknown): number {
	if (value === undefined) return DEFAULT_NETWORK_CAPTURE_SECONDS;
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > MAX_NETWORK_CAPTURE_SECONDS
	) {
		throw browserError(
			"INVALID_ARGUMENT",
			`network capture duration must be an integer from 1 to ${MAX_NETWORK_CAPTURE_SECONDS} seconds`,
		);
	}
	return value;
}

function normalizeAgentBrowserURL(input: string): string {
	const raw = input.trim();
	if (!raw) throw browserError("URL_REQUIRED", "url is required");
	if (isWindowsAbsolutePath(raw) || isPosixAbsolutePath(raw) || /^file:/i.test(raw)) {
		throw browserError("BROWSER_URL_FORBIDDEN", "Agent browser commands cannot open local files");
	}
	if (!/^https?:\/\//i.test(raw) && !isLocalhostLike(raw) && !looksLikeHost(raw)) {
		throw browserError("INVALID_URL", "ao browser open requires an explicit http(s) URL or hostname");
	}
	const normalized = normalizeBrowserURL(raw);
	if (normalized.protocol !== "http:" && normalized.protocol !== "https:") {
		throw browserError("BROWSER_URL_FORBIDDEN", "Agent browser commands support only http(s) URLs");
	}
	return normalized.href;
}

function externalText(value: unknown): string {
	const raw = value == null ? "" : String(value);
	const bytes = Buffer.from(raw, "utf8");
	if (bytes.length <= MAX_EXTERNAL_TEXT_BYTES) return raw;
	return `${bytes.subarray(0, MAX_EXTERNAL_TEXT_BYTES).toString("utf8")}\n[Content truncated at ${MAX_EXTERNAL_TEXT_BYTES} bytes]`;
}

function markUntrusted(value: string): string {
	return `${UNTRUSTED_BEGIN}\n${value}\n${UNTRUSTED_END}`;
}

function normalizeNativeMessages(result: Record<string, unknown>, action: string): Record<string, unknown> {
	const raw = Array.isArray(result.messages) ? result.messages : Array.isArray(result.value) ? result.value : [];
	const messages = raw.map((item): BrowserLogEntry => {
		if (typeof item === "string") {
			return {
				level: action === "errors" ? "error" : "log",
				message: markUntrusted(externalText(item)),
				timestamp: new Date().toISOString(),
			};
		}
		const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
		const level =
			typeof record.level === "string"
				? record.level
				: typeof record.type === "string"
					? record.type
					: action === "errors"
						? "error"
						: "log";
		const message =
			typeof record.message === "string"
				? record.message
				: typeof record.text === "string"
					? record.text
					: JSON.stringify(record);
		return {
			level,
			message: markUntrusted(externalText(message)),
			timestamp: typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString(),
		};
	});
	return { messages, untrustedExternalContent: true };
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw browserError("BROWSER_COMMAND_CANCELED", "Browser command was canceled");
}

function browserError(code: string, message: string): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}
