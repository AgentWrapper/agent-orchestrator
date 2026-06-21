import posthog from "posthog-js/dist/module.full.no-external";
import { aoBridge } from "./bridge";
import { DEFAULT_POSTHOG_HOST, DEFAULT_POSTHOG_PROJECT_KEY } from "../../shared/posthog-config";

const POSTHOG_KEY = import.meta.env.VITE_AO_POSTHOG_KEY?.trim() || DEFAULT_POSTHOG_PROJECT_KEY;
const POSTHOG_HOST = import.meta.env.VITE_AO_POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST;
const RELEASE_TAG = "2026-01-30";
const REDACTED_LOCAL_URL = "[redacted-local-url]";
const REDACTED_LOCAL_PATH = "[redacted-local-path]";
const EMBEDDED_LOCAL_URL_PATTERN =
	/(?:\bfile:\/\/\/\S+|\bapp:\/\/renderer\/\S+|\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\S*)/gi;

let initPromise: Promise<boolean> | null = null;
let errorHandlersBound = false;

type TelemetryProperties = Record<string, unknown>;

function normalizeException(reason: unknown): Error {
	if (reason instanceof Error) return reason;
	if (typeof reason === "string") return new Error(reason);
	try {
		return new Error(JSON.stringify(reason));
	} catch {
		return new Error("Unknown renderer exception");
	}
}

function routeSurface(pathname: string): string {
	if (pathname === "/") return "home";
	if (/^\/prs(?:\/|$)/.test(pathname)) return "pull_requests";
	if (/^\/projects\/[^/]+\/sessions\/[^/]+$/.test(pathname)) return "session_detail";
	if (/^\/projects\/[^/]+(?:\/|$)/.test(pathname)) {
		if (/\/settings$/.test(pathname)) return "project_settings";
		return "project_board";
	}
	if (/^\/sessions\/[^/]+$/.test(pathname)) return "session_detail";
	return "other";
}

async function sha256Hex(raw: string): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) return "redacted";
	const bytes = new TextEncoder().encode(raw);
	const digest = await subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashedTelemetryID(value: unknown): Promise<string | undefined> {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return sha256Hex(trimmed);
}

function isLocalURL(value: string): boolean {
	try {
		const url = new URL(value);
		const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
		return (
			url.protocol === "file:" ||
			(url.protocol === "app:" && url.host === "renderer") ||
			hostname === "localhost" ||
			hostname === "127.0.0.1" ||
			hostname === "::1"
		);
	} catch {
		return false;
	}
}

function redactEmbeddedLocalURLs(value: string): string {
	return value.replace(EMBEDDED_LOCAL_URL_PATTERN, REDACTED_LOCAL_URL);
}

function redactEmbeddedAbsolutePaths(value: string): string {
	return value
		.replace(/(?:\/Users\/|\/home\/|\/tmp\/|\/private\/var\/|\/var\/folders\/)\S+/g, REDACTED_LOCAL_PATH)
		.replace(/\b[A-Za-z]:\\[^\s)]+/g, REDACTED_LOCAL_PATH);
}

function sanitizeSensitiveString(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return trimmed;
	if (isLocalURL(trimmed)) return REDACTED_LOCAL_URL;
	return redactEmbeddedAbsolutePaths(redactEmbeddedLocalURLs(trimmed));
}

function sanitizePostHogValue(value: unknown): unknown {
	if (typeof value === "string") return sanitizeSensitiveString(value);
	if (Array.isArray(value)) return value.map((item) => sanitizePostHogValue(item));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, sanitizePostHogValue(nested)]));
	}
	return value;
}

export function sanitizePostHogEvent(event: Record<string, unknown>): Record<string, unknown> {
	return sanitizePostHogValue(event) as Record<string, unknown>;
}

export function sanitizeReplayRequestName(name: string): string {
	const withoutQuery = name.split("?")[0] ?? name;
	return sanitizeSensitiveString(withoutQuery);
}

function sanitizePostHogCaptureResult<T>(event: T): T {
	return sanitizePostHogEvent(event as unknown as Record<string, unknown>) as unknown as T;
}

async function sanitizeRendererContextProperties(properties?: TelemetryProperties): Promise<TelemetryProperties> {
	const safe: TelemetryProperties = {};
	if (typeof properties?.source === "string" && properties.source.trim() !== "") {
		safe.source = properties.source;
	}
	if (typeof properties?.operation === "string" && properties.operation.trim() !== "") {
		safe.operation = properties.operation;
	}
	if (typeof properties?.surface === "string" && properties.surface.trim() !== "") {
		safe.surface = properties.surface;
	}
	if (typeof properties?.unhandled === "boolean") {
		safe.unhandled = properties.unhandled;
	}
	const projectIDHash = await hashedTelemetryID(properties?.project_id);
	if (projectIDHash) {
		safe.project_id_hash = projectIDHash;
	}
	return safe;
}

export async function sanitizeRendererProperties(
	event: string,
	properties?: TelemetryProperties,
): Promise<TelemetryProperties> {
	const safe: TelemetryProperties = {};
	switch (event) {
		case "ao.app.active":
			if (properties?.channel === "renderer") safe.channel = "renderer";
			break;
		case "ao.renderer.route_viewed":
			if (typeof properties?.surface === "string" && properties.surface.trim() !== "") {
				safe.surface = properties.surface;
			}
			break;
		case "ao.renderer.project_add_requested":
		case "ao.renderer.loaded":
			break;
		case "ao.renderer.project_add_succeeded":
		case "ao.renderer.project_removed":
		case "ao.renderer.orchestrator_open_requested": {
			const projectIDHash = await hashedTelemetryID(properties?.project_id);
			if (projectIDHash) safe.project_id_hash = projectIDHash;
			break;
		}
	}
	return safe;
}

function exceptionName(error: unknown): string {
	if (error instanceof Error && error.name.trim() !== "") return error.name.trim();
	if (typeof error === "string") return "string";
	return "unknown";
}

export async function sanitizeRendererExceptionProperties(
	error: unknown,
	properties?: TelemetryProperties,
): Promise<TelemetryProperties> {
	const safe: TelemetryProperties = {
		error_name: exceptionName(error),
	};
	return { ...safe, ...(await sanitizeRendererContextProperties(properties)) };
}

function bindErrorHandlers() {
	if (errorHandlersBound) return;
	errorHandlersBound = true;
	window.addEventListener("error", (event) => {
		void captureRendererException(event.error ?? new Error(event.message), {
			source: "window-error",
			unhandled: true,
		});
	});
	window.addEventListener("unhandledrejection", (event) => {
		void captureRendererException(normalizeException(event.reason), {
			source: "unhandledrejection",
			unhandled: true,
		});
	});
}

export async function initTelemetry(): Promise<boolean> {
	if (initPromise) return initPromise;
	initPromise = (async () => {
		if (!POSTHOG_KEY) return false;
		const bootstrap = await aoBridge.telemetry.getBootstrap();
		if (!bootstrap) return false;
		posthog.init(POSTHOG_KEY, {
			api_host: POSTHOG_HOST,
			defaults: RELEASE_TAG,
			autocapture: false,
			capture_pageview: false,
			capture_exceptions: false,
			persistence: "localStorage",
			before_send: (event) => (event ? sanitizePostHogCaptureResult(event) : event),
			session_recording: {
				maskCapturedNetworkRequestFn: (request) => {
					if (request.name) {
						request.name = sanitizeReplayRequestName(request.name);
					}
					return request;
				},
			},
		});
		posthog.identify(bootstrap.distinctId, {
			app_version: bootstrap.appVersion,
			platform: bootstrap.platform,
			surface: "renderer",
		});
		posthog.register({
			app_version: bootstrap.appVersion,
			platform: bootstrap.platform,
			surface: "renderer",
			build_mode: import.meta.env.DEV ? "dev" : "packaged",
		});
		bindErrorHandlers();
		posthog.capture("ao.app.active", await sanitizeRendererProperties("ao.app.active", { channel: "renderer" }));
		posthog.capture("ao.renderer.loaded");
		return true;
	})().catch(() => false);
	return initPromise;
}

export async function captureRendererEvent(event: string, properties?: Record<string, unknown>): Promise<void> {
	if (!(await initTelemetry())) return;
	const safeProperties = await sanitizeRendererProperties(event, properties);
	posthog.capture(event, safeProperties);
}

export async function captureRendererException(error: unknown, properties?: Record<string, unknown>): Promise<void> {
	if (!(await initTelemetry())) return;
	const safeProperties = await sanitizeRendererExceptionProperties(error, properties);
	posthog.captureException(normalizeException(error), safeProperties);
}

export async function addRendererExceptionStep(message: string, properties?: Record<string, unknown>): Promise<void> {
	if (!(await initTelemetry())) return;
	const safeProperties = await sanitizeRendererContextProperties(properties);
	posthog.addExceptionStep(message, safeProperties);
}

export { routeSurface };
