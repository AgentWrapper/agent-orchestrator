import createClient from "openapi-fetch";
import type { paths } from "../../api/schema";
import { captureRendererEvent } from "./telemetry";

function devApiBaseUrl(): string {
	return typeof window === "undefined" ? "http://127.0.0.1:3001" : window.location.origin;
}

const explicitApiBaseUrl = import.meta.env.VITE_AO_API_BASE_URL;
const initialApiBaseUrl = explicitApiBaseUrl ?? (import.meta.env.DEV ? devApiBaseUrl() : "http://127.0.0.1:3001");

let runtimeApiBaseUrl: string | null = explicitApiBaseUrl ?? null;

const baseUrlListeners = new Set<() => void>();

export function getApiBaseUrl(): string {
	return runtimeApiBaseUrl ?? "";
}

export function hasTrustedApiBaseUrl(): boolean {
	return runtimeApiBaseUrl !== null;
}

/**
 * Subscribe to base-URL changes (useSyncExternalStore-compatible). Long-lived
 * connections bound to a specific port — the terminal mux WebSocket, the SSE
 * stream — use this to rebind when the daemon comes back on a different port.
 */
export function subscribeApiBaseUrl(listener: () => void): () => void {
	baseUrlListeners.add(listener);
	return () => {
		baseUrlListeners.delete(listener);
	};
}

export function setApiBaseUrl(nextBaseUrl: string | null): void {
	const normalized = (nextBaseUrl ?? explicitApiBaseUrl ?? null)?.replace(/\/+$/, "") ?? null;
	if (normalized === runtimeApiBaseUrl) return;
	runtimeApiBaseUrl = normalized;
	baseUrlListeners.forEach((listener) => listener());
}

// Resource collections whose next path segment is an identifier. Operation
// strings sent to telemetry must never contain raw IDs (project IDs are
// user-chosen strings), so normalize before reporting.
const RESOURCE_SEGMENTS = new Set(["projects", "sessions", "notifications", "workspaces", "prs", "orchestrators"]);

export function normalizeApiOperation(method: string, pathname: string): string {
	const segments = pathname.split("/");
	for (let i = 0; i < segments.length - 1; i += 1) {
		if (RESOURCE_SEGMENTS.has(segments[i]) && segments[i + 1]) {
			segments[i + 1] = ":id";
			i += 1;
		}
	}
	return `${method.toUpperCase()} ${segments.join("/")}`;
}

type ApiErrorCategory = "daemon_unavailable" | "network_error" | "http_4xx" | "http_5xx";

// One event per (operation, category, status) per window: a daemon outage
// makes every polling query fail at once and on every retry — the failure
// signal matters, the storm does not.
const API_ERROR_DEDUPE_MS = 30_000;
const lastApiErrorAt = new Map<string, number>();

function reportApiError(operation: string, category: ApiErrorCategory, status?: number): void {
	const key = `${operation}|${category}|${status ?? ""}`;
	const now = Date.now();
	const last = lastApiErrorAt.get(key);
	if (last !== undefined && now - last < API_ERROR_DEDUPE_MS) return;
	lastApiErrorAt.set(key, now);
	void captureRendererEvent("ao.renderer.api_error", {
		operation,
		error_category: category,
		status,
	});
}

async function runtimeFetch(input: Request): Promise<Response> {
	const operation = normalizeApiOperation(input.method, new URL(input.url).pathname);
	const baseUrl = runtimeApiBaseUrl;
	if (baseUrl === null) {
		reportApiError(operation, "daemon_unavailable", 503);
		return new Response(JSON.stringify({ message: "AO daemon is not ready." }), {
			status: 503,
			headers: { "Content-Type": "application/json" },
		});
	}

	const send = async (): Promise<Response> => {
		if (!baseUrl) {
			return fetch(input);
		}

		const url = new URL(input.url);
		const target = new URL(url.pathname + url.search + url.hash, baseUrl);
		if (target.href === input.url) {
			return fetch(input);
		}

		// Rebase onto the runtime base URL by copying fields explicitly and
		// buffering the body. `new Request(target, input)` reads the source
		// request's `duplex` getter, which Electron's Chromium lacks — it throws
		// "The duplex member must be specified" for any request with a body, so
		// every POST would fail in the packaged app. API bodies are small JSON;
		// buffering sidesteps streaming-duplex semantics entirely.
		const body = input.method === "GET" || input.method === "HEAD" ? undefined : await input.arrayBuffer();
		return fetch(target, {
			method: input.method,
			headers: input.headers,
			body,
			signal: input.signal,
			credentials: input.credentials,
			cache: input.cache,
			redirect: input.redirect,
			referrerPolicy: input.referrerPolicy,
			integrity: input.integrity,
			keepalive: input.keepalive,
		});
	};

	let response: Response;
	try {
		response = await send();
	} catch (error) {
		// Caller-initiated aborts (unmounted components cancelling queries) are not failures.
		if (!(error instanceof DOMException && error.name === "AbortError")) {
			reportApiError(operation, "network_error");
		}
		throw error;
	}
	if (!response.ok) {
		reportApiError(operation, response.status >= 500 ? "http_5xx" : "http_4xx", response.status);
	}
	return response;
}

export const apiClient = createClient<paths>({
	baseUrl: initialApiBaseUrl,
	fetch: runtimeFetch,
});

/**
 * Human-readable message from an openapi-fetch `error` value. The daemon's
 * error body is `{ error, code, message, requestId }` (backend apierr) — a
 * plain object, so `String(error)` renders "[object Object]". Falls back
 * through Error instances and strings.
 */
export function apiErrorMessage(error: unknown, fallback = "Request failed"): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string" && error !== "") return error;
	if (typeof error === "object" && error !== null) {
		const body = error as { code?: unknown; message?: unknown; error?: unknown };
		const code = typeof body.code === "string" && body.code !== "" ? body.code : "";
		if (typeof body.message === "string" && body.message !== "") {
			return code && !body.message.includes(code) ? `${body.message} (${code})` : body.message;
		}
		if (typeof body.error === "string" && body.error !== "") return body.error;
	}
	return fallback;
}
