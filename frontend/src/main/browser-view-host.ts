import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, Rectangle, View, WebContents } from "electron";
import type {
	BrowserAnnotationCancelPayload,
	BrowserAnnotationModeInput,
	BrowserAnnotationPageCancelPayload,
	BrowserAnnotationPageSubmitPayload,
	BrowserAnnotationSubmitPayload,
} from "../shared/browser-annotations";

export type BrowserRect = Pick<Rectangle, "x" | "y" | "width" | "height">;

export type BrowserNavState = {
	viewId: string;
	url: string;
	title: string;
	canGoBack: boolean;
	canGoForward: boolean;
	isLoading: boolean;
	error?: string;
};

type BrowserBoundsInput = {
	viewId: string;
	rect: BrowserRect;
	visible: boolean;
};

type BrowserNavigateInput = {
	viewId: string;
	url: string;
};

type BrowserWebContents = Pick<
	WebContents,
	| "id"
	| "canGoBack"
	| "canGoForward"
	| "clearHistory"
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
};

type BrowserViewLike = View & {
	webContents: BrowserWebContents;
	setBounds: (bounds: BrowserRect) => void;
	setVisible?: (visible: boolean) => void;
};

type BrowserWindowLike = {
	contentView: {
		addChildView: (view: BrowserViewLike) => void;
		removeChildView?: (view: BrowserViewLike) => void;
	};
	getContentBounds: () => BrowserRect;
	webContents: Pick<WebContents, "id" | "send">;
	isDestroyed?: () => boolean;
};

type ShellLike = {
	openExternal: (url: string) => Promise<void>;
};

type WebContentsViewConstructor = new (options: { webPreferences: Electron.WebPreferences }) => BrowserViewLike;

/**
 * How many session-scoped WebContentsViews may exist at once (M12, #293). Each one
 * is a live Chromium page: memory, timers, sockets, background network. Hidden
 * views are kept warm so returning to a session is instant, but they must not
 * accumulate for every session a long-running dashboard ever visited. Beyond this
 * cap the least recently used view is destroyed; re-entering that session simply
 * re-creates it.
 */
export const DEFAULT_MAX_BROWSER_VIEWS = 6;

export type BrowserViewHostOptions = {
	mainWindow: BrowserWindowLike;
	ipcMain: Pick<IpcMain, "handle" | "on" | "removeHandler" | "off">;
	shell: ShellLike;
	WebContentsView: WebContentsViewConstructor;
	annotatePreloadPath: string;
	rendererOrigin: string;
	/** Bound on live session views; defaults to {@link DEFAULT_MAX_BROWSER_VIEWS}. */
	maxViews?: number;
};

export type BrowserViewHost = {
	dispose: () => void;
	destroy: (viewId: string) => void;
	destroyAll: () => void;
};

type BrowserEntry = {
	view: BrowserViewLike;
	state: BrowserNavState;
	annotationEnabled: boolean;
};

const OFFSCREEN_BOUNDS: BrowserRect = { x: -10_000, y: -10_000, width: 0, height: 0 };
// ponytail: file:// allowed unsanitized; preview targets are agent-trusted for now
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "file:"]);

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
	// Map iteration order is insertion order, so re-inserting on touch makes this a
	// least-recently-used list: the first key is the coldest view.
	const entries = new Map<string, BrowserEntry>();
	const viewIdsByWebContentsId = new Map<number, string>();
	const ipcDisposers: Array<() => void> = [];
	const maxViews = Math.max(1, options.maxViews ?? DEFAULT_MAX_BROWSER_VIEWS);

	const ensure = (viewId: string): BrowserEntry => {
		const existing = entries.get(viewId);
		if (existing) {
			// Refresh recency so an actively used view is never the eviction victim.
			entries.delete(viewId);
			entries.set(viewId, existing);
			return existing;
		}

		const view = new options.WebContentsView({
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				preload: options.annotatePreloadPath,
				sandbox: true,
			},
		});
		view.setBounds(OFFSCREEN_BOUNDS);
		view.setVisible?.(false);
		options.mainWindow.contentView.addChildView(view);

		const state: BrowserNavState = emptyNavState(viewId);
		const entry = { view, state, annotationEnabled: false };
		entries.set(viewId, entry);
		viewIdsByWebContentsId.set(view.webContents.id, viewId);
		hardenWebContents(view.webContents, options, entry);
		wireNavEvents(view.webContents, options, entry);
		evictColdViews(viewId);
		return entry;
	};

	// Destroy least-recently-used views until the map is back within its bound. The
	// just-ensured view is never a candidate, even at maxViews === 1.
	const evictColdViews = (keepViewId: string): void => {
		while (entries.size > maxViews) {
			const coldest = [...entries.keys()].find((id) => id !== keepViewId);
			if (!coldest) return;
			destroy(coldest);
		}
	};

	const setBounds = ({ viewId, rect, visible }: BrowserBoundsInput, zoomFactor = 1): void => {
		const entry = entries.get(viewId);
		if (!entry) return;
		if (!visible) {
			entry.view.setVisible?.(false);
			entry.view.setBounds(OFFSCREEN_BOUNDS);
			return;
		}
		// The renderer measures the slot in page-zoomed CSS pixels, while
		// WebContentsView bounds are window coordinates. Convert before clamping so
		// Cmd+/Cmd- page zoom does not detach the native view from its React slot.
		const bounds = clampBoundsToWindow(scaleBoundsForZoom(rect, zoomFactor), options.mainWindow.getContentBounds());
		entry.view.setBounds(bounds);
		entry.view.setVisible?.(bounds.width > 0 && bounds.height > 0);
	};

	// Every failure mode here — a malformed target, a blocked scheme, a refused
	// connection — must come back as a nav state the panel can render (M14, #293).
	// Rejecting across IPC only produced an unhandled rejection in the renderer and
	// a panel that silently ignored the user's input.
	const navigate = async ({ viewId, url }: BrowserNavigateInput): Promise<BrowserNavState> => {
		const entry = ensure(viewId);
		cancelAnnotation(options, entry, "navigation");
		try {
			const normalized = normalizeBrowserURL(url);
			if (!isAllowedBrowserURL(normalized.href, options.rendererOrigin)) {
				throw new Error("Unsupported browser URL");
			}
			await entry.view.webContents.loadURL(normalized.href);
		} catch (error) {
			return failNavState(options, entry, error);
		}
		return pushNavState(options, entry);
	};

	// clear resets the view to a blank page (`ao preview clear`). about:blank is
	// loaded directly, bypassing the URL allowlist — it carries no content and
	// readNavState normalizes it back to an empty url so the panel shows its
	// empty state.
	const clear = async (viewId: string): Promise<BrowserNavState> => {
		const entry = ensure(viewId);
		cancelAnnotation(options, entry, "navigation");
		entry.view.setVisible?.(false);
		entry.view.setBounds(OFFSCREEN_BOUNDS);
		try {
			await entry.view.webContents.loadURL("about:blank");
			entry.view.webContents.clearHistory();
		} catch (error) {
			return failNavState(options, entry, error);
		}
		return pushNavState(options, entry);
	};

	const destroy = (viewId: string): void => {
		const entry = entries.get(viewId);
		if (!entry) return;
		entries.delete(viewId);
		viewIdsByWebContentsId.delete(entry.view.webContents.id);
		// When the window is already gone (dispose fired from mainWindow "closed"),
		// Electron has torn down contentView and the child WebContentsViews. Touching
		// them throws "Object has been destroyed", so just drop our reference.
		if (options.mainWindow.isDestroyed?.()) return;
		entry.view.setVisible?.(false);
		entry.view.setBounds(OFFSCREEN_BOUNDS);
		options.mainWindow.contentView.removeChildView?.(entry.view);
		entry.view.webContents.close?.();
	};

	const invokeNav = (
		viewId: string,
		action: (contents: BrowserWebContents) => void,
		cancelForNavigation = false,
	): BrowserNavState => {
		const entry = entries.get(viewId);
		if (!entry) return emptyNavState(viewId);
		if (cancelForNavigation) cancelAnnotation(options, entry, "navigation");
		try {
			action(entry.view.webContents);
		} catch (error) {
			return failNavState(options, entry, error);
		}
		return pushNavState(options, entry);
	};

	const setAnnotationMode = (event: IpcMainInvokeEvent, input: BrowserAnnotationModeInput): void => {
		if (!isRendererOwnedViewId(event, input.viewId)) return;
		const entry = entries.get(input.viewId);
		if (!entry) return;
		entry.annotationEnabled = input.enabled;
		entry.view.webContents.send("browser:annotation:setMode", { enabled: input.enabled });
	};

	const forwardAnnotationSubmit = (
		event: IpcMainEvent,
		payload: BrowserAnnotationPageSubmitPayload | undefined,
	): void => {
		const viewId = viewIdsByWebContentsId.get(event.sender.id);
		const entry = viewId ? entries.get(viewId) : undefined;
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
		const viewId = viewIdsByWebContentsId.get(event.sender.id);
		const entry = viewId ? entries.get(viewId) : undefined;
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

	handle("browser:ensure", (event, sessionId: string) => pushNavState(options, ensure(scopedViewId(event, sessionId))));
	on("browser:setBounds", (event, input: BrowserBoundsInput) => setBounds(input, event.sender.getZoomFactor()));
	handle("browser:navigate", (_event, input: BrowserNavigateInput) => navigate(input));
	handle("browser:clear", (_event, viewId: string) => clear(viewId));
	handle("browser:goBack", (_event, viewId: string) => invokeNav(viewId, (contents) => contents.goBack(), true));
	handle("browser:goForward", (_event, viewId: string) => invokeNav(viewId, (contents) => contents.goForward(), true));
	handle("browser:reload", (_event, viewId: string) => invokeNav(viewId, (contents) => contents.reload(), true));
	handle("browser:stop", (_event, viewId: string) => invokeNav(viewId, (contents) => contents.stop()));
	handle("browser:annotation:setMode", (event, input: BrowserAnnotationModeInput) => setAnnotationMode(event, input));
	on("browser:destroy", (_event, viewId: string) => destroy(viewId));
	on("browser:annotation:submit", (event, payload: BrowserAnnotationPageSubmitPayload) =>
		forwardAnnotationSubmit(event, payload),
	);
	on("browser:annotation:cancel", (event, payload: BrowserAnnotationPageCancelPayload) =>
		forwardAnnotationCancel(event, payload),
	);

	return {
		dispose: () => {
			ipcDisposers.splice(0).forEach((dispose) => dispose());
			for (const viewId of [...entries.keys()]) {
				destroy(viewId);
			}
		},
		destroy,
		destroyAll: () => {
			for (const viewId of [...entries.keys()]) {
				destroy(viewId);
			}
		},
	};
}

function withDefaultScheme(raw: string): string {
	if (isWindowsAbsolutePath(raw) || isPosixAbsolutePath(raw)) return localPathToFileURL(raw);
	if (/^https?:\/\//i.test(raw)) return raw;
	if (isLocalhostLike(raw)) return `http://${raw}`;
	if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)) return raw;
	return `https://${raw}`;
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

function scopedViewId(event: IpcMainInvokeEvent, sessionId: string): string {
	return `${event.sender.id}:${sessionId}`;
}

function isRendererOwnedViewId(event: IpcMainInvokeEvent, viewId: string): boolean {
	return viewId.startsWith(`${event.sender.id}:`);
}

function hardenWebContents(contents: BrowserWebContents, options: BrowserViewHostOptions, entry: BrowserEntry): void {
	contents.setWindowOpenHandler(({ url }) => {
		if (isAllowedBrowserURL(url, options.rendererOrigin)) {
			// Fire-and-forget would reject unhandled when the OS has no handler for the
			// URL — and the user would watch a click do nothing. Observe it like every
			// other navigation promise and surface the failure in the panel (M14, #293).
			void Promise.resolve(options.shell.openExternal(url)).catch((error: unknown) => {
				failNavState(options, entry, error);
			});
		}
		return { action: "deny" };
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

function wireNavEvents(contents: BrowserWebContents, options: BrowserViewHostOptions, entry: BrowserEntry): void {
	const update = () => {
		pushNavState(options, entry);
	};
	contents.on("did-navigate", update);
	contents.on("did-navigate-in-page", update);
	contents.on("page-title-updated", update);
	contents.on("did-start-loading", () => {
		cancelAnnotation(options, entry, "navigation");
		update();
	});
	contents.on("did-stop-loading", update);
	contents.on("did-fail-load", (_event, errorCode, errorDescription) => {
		// Chromium fires did-fail-load with -3 / ERR_ABORTED for the same stopped,
		// redirected and superseded navigations that reject loadURL — typing a second
		// URL while the first is still loading aborts the first. The rejection path
		// already suppresses those; the event path must too, or the abort still lands
		// in the panel as a visible error (M14 follow-up, #293).
		if (isAbortedLoadFailure(errorCode, errorDescription)) {
			pushNavState(options, entry);
			return;
		}
		entry.state = { ...readNavState(entry), error: String(errorDescription || "Unable to load page") };
		options.mainWindow.webContents.send("browser:navState", entry.state);
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

/**
 * Chromium aborts the in-flight load on a redirect, a user stop, or a second
 * navigation issued while the first is still resolving. loadURL rejects with
 * ERR_ABORTED in all three, none of which is a failure the user must be told
 * about — did-fail-load reports genuine load failures separately.
 */
function isAbortedNavigation(error: unknown): boolean {
	return error instanceof Error && error.message.includes("ERR_ABORTED");
}

/** net::ERR_ABORTED — the did-fail-load event form of the same non-failure. */
const ERR_ABORTED_CODE = -3;

function isAbortedLoadFailure(errorCode: unknown, errorDescription: unknown): boolean {
	if (errorCode === ERR_ABORTED_CODE) return true;
	return typeof errorDescription === "string" && errorDescription.includes("ERR_ABORTED");
}

function navErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error !== "") return error;
	return "Navigation failed";
}

/**
 * Turn a navigation/control failure into the visible nav state (M14, #293): read
 * whatever the page is now, stamp the error, push it to the renderer, return it to
 * the caller. Aborted loads carry no error.
 */
function failNavState(options: BrowserViewHostOptions, entry: BrowserEntry, error: unknown): BrowserNavState {
	if (isAbortedNavigation(error)) return pushNavState(options, entry);
	entry.state = { ...readNavState(entry), error: navErrorMessage(error) };
	options.mainWindow.webContents.send("browser:navState", entry.state);
	return entry.state;
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
