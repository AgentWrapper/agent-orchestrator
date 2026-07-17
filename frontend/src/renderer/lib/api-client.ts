import createClient from "openapi-fetch";
import type { paths } from "../../api/schema";
import { i18n } from "../i18n";
import { TOKEN_VALUE_PATTERN } from "../../shared/credential-patterns";
import { captureRendererEvent } from "./telemetry";

function devApiBaseUrl(): string {
	return typeof window === "undefined" ? "http://127.0.0.1:3001" : window.location.origin;
}

const explicitApiBaseUrl = import.meta.env.VITE_AO_API_BASE_URL;
const initialApiBaseUrl = explicitApiBaseUrl ?? (import.meta.env.DEV ? devApiBaseUrl() : "http://127.0.0.1:3001");

let runtimeApiBaseUrl: string | null = explicitApiBaseUrl ?? null;

const baseUrlListeners = new Set<() => void>();
const daemonNotReadyCode = "DAEMON_NOT_READY";

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

// Route templates from the generated OpenAPI schema (frontend/src/api/schema.ts).
// Operation strings sent to telemetry must never contain raw IDs (project IDs
// are user-chosen strings), so we match each request path against these
// templates and report the template — collapsing `{param}` to `:id` — rather
// than guessing which segments are identifiers. Matching from the schema keeps
// static child routes (notifications/read-all, sessions/cleanup) intact and
// still normalizes IDs for every resource, including ones a segment heuristic
// would miss (orchestrators/{id}). Keep in sync with schema.ts.
const ROUTE_TEMPLATES = [
	"/api/v1/events",
	"/api/v1/filesystem/directories",
	"/api/v1/import",
	"/api/v1/notifications",
	"/api/v1/notifications/{id}",
	"/api/v1/notifications/read-all",
	"/api/v1/notifications/stream",
	"/api/v1/orchestrators",
	"/api/v1/orchestrators/{id}",
	"/api/v1/projects",
	"/api/v1/projects/{id}",
	"/api/v1/projects/{id}/config",
	"/api/v1/prs/{id}/merge",
	"/api/v1/prs/{id}/resolve-comments",
	"/api/v1/scm/connections",
	"/api/v1/scm/connections/{id}",
	"/api/v1/scm/connections/{id}/test",
	"/api/v1/sessions",
	"/api/v1/sessions/{sessionId}",
	"/api/v1/sessions/{sessionId}/activity",
	"/api/v1/sessions/{sessionId}/kill",
	"/api/v1/sessions/{sessionId}/pr",
	"/api/v1/sessions/{sessionId}/pr/claim",
	"/api/v1/sessions/{sessionId}/preview",
	"/api/v1/sessions/{sessionId}/preview/files/*",
	"/api/v1/sessions/{sessionId}/restore",
	"/api/v1/sessions/{sessionId}/reviews",
	"/api/v1/sessions/{sessionId}/reviews/cancel",
	"/api/v1/sessions/{sessionId}/reviews/publish",
	"/api/v1/sessions/{sessionId}/reviews/submit",
	"/api/v1/sessions/{sessionId}/reviews/trigger",
	"/api/v1/sessions/{sessionId}/rollback",
	"/api/v1/sessions/{sessionId}/send",
	"/api/v1/sessions/cleanup",
] as const;

// Resource collections whose next path segment is an identifier. Only used as a
// defensive fallback for paths not covered by ROUTE_TEMPLATES; keeps IDs out of
// telemetry for known collections even if a route is ever missed above.
const RESOURCE_SEGMENTS = new Set(["projects", "sessions", "notifications", "workspaces", "prs", "orchestrators"]);

// Match a path against one template. `{param}` matches any single segment
// (reported as `:id`), a trailing `*` matches the remaining path, and every
// other segment must match literally. Returns the normalized template plus a
// score = number of literal segments matched, so the most specific template
// wins when several match (e.g. `read-all` beats `{id}`).
function matchRouteTemplate(pathname: string, template: string): { normalized: string; score: number } | null {
	const pathSegs = pathname.split("/");
	const tmplSegs = template.split("/");
	const out: string[] = [];
	let score = 0;
	for (let i = 0; i < tmplSegs.length; i += 1) {
		const t = tmplSegs[i];
		if (t === "*") {
			out.push("*");
			return { normalized: out.join("/"), score };
		}
		const p = pathSegs[i];
		if (p === undefined) return null;
		if (t.startsWith("{") && t.endsWith("}")) {
			out.push(":id");
		} else if (t === p) {
			out.push(t);
			score += 1;
		} else {
			return null;
		}
	}
	if (pathSegs.length !== tmplSegs.length) return null;
	return { normalized: out.join("/"), score };
}

function fallbackNormalize(pathname: string): string {
	const segments = pathname.split("/");
	for (let i = 0; i < segments.length - 1; i += 1) {
		if (RESOURCE_SEGMENTS.has(segments[i]) && segments[i + 1]) {
			segments[i + 1] = ":id";
			i += 1;
		}
	}
	return segments.join("/");
}

export function normalizeApiOperation(method: string, pathname: string): string {
	let best: { normalized: string; score: number } | null = null;
	for (const template of ROUTE_TEMPLATES) {
		const match = matchRouteTemplate(pathname, template);
		if (match && (best === null || match.score > best.score)) best = match;
	}
	return `${method.toUpperCase()} ${best?.normalized ?? fallbackNormalize(pathname)}`;
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
		return new Response(
			JSON.stringify({ error: "unavailable", code: daemonNotReadyCode, message: daemonNotReadyCode }),
			{
				status: 503,
				headers: { "Content-Type": "application/json" },
			},
		);
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

/** Extract the stable code from a daemon API error envelope. */
export function apiErrorCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null) {
		const body = error as { code?: unknown };
		if (typeof body.code === "string" && body.code !== "") return body.code;
	}
	return undefined;
}

const STABLE_API_ERROR_CODES = [
	"DAEMON_NOT_READY",
	"REMOTE_DAEMON_UNAVAILABLE",
	"BAD_PASSWORD",
	"LOCKED_OUT",
	"ORIGIN_FORBIDDEN",
	"ROUTE_NOT_FOUND",
	"METHOD_NOT_ALLOWED",
	"NOT_IMPLEMENTED",
	"INTERNAL_ERROR",
	"INVALID_JSON",
	"INVALID_BODY",
	"INVALID_AFTER",
	"SSE_UNSUPPORTED",
	"ABSOLUTE_PATH_REQUIRED",
	"INVALID_DIRECTORY_NAME",
	"DIRECTORY_ALREADY_EXISTS",
	"DIRECTORY_PERMISSION_DENIED",
	"DIRECTORY_NOT_FOUND",
	"NOT_A_DIRECTORY",
	"DIRECTORY_READ_FAILED",
	"DIRECTORY_CREATE_FAILED",
	"PROJECTS_LIST_FAILED",
	"PROJECT_LOAD_FAILED",
	"PROJECT_NOT_FOUND",
	"PATH_REQUIRED",
	"INVALID_PATH",
	"PATH_ALREADY_REGISTERED",
	"ID_ALREADY_REGISTERED",
	"INVALID_PROJECT_CONFIG",
	"PROJECT_ADD_FAILED",
	"NOT_A_GIT_REPO",
	"PROJECT_UNBORN",
	"GIT_INIT_FAILED",
	"GIT_ADD_FAILED",
	"INITIAL_COMMIT_FAILED",
	"PROJECT_BARE_REPOSITORY",
	"PROJECT_ALREADY_INITIALIZED",
	"PROJECT_PATH_NOT_REPO_ROOT",
	"UNSUPPORTED_GIT_REPO",
	"PROJECT_SETUP_PATH_UNSAFE",
	"PROJECT_NESTED_REPO_SCAN_FAILED",
	"PROJECT_NESTED_GIT_REPOSITORY",
	"PROJECT_CONFIG_UPDATE_FAILED",
	"PROJECT_REMOVE_FAILED",
	"INVALID_PROJECT_ID",
	"WORKSPACE_REPOS_REQUIRED",
	"WORKSPACE_PARENT_IS_WORKTREE",
	"WORKSPACE_PARENT_BARE",
	"WORKSPACE_CHILD_RESERVED_NAME",
	"INVALID_WORKSPACE_CHILD",
	"WORKSPACE_CHILD_IS_WORKTREE",
	"WORKSPACE_CHILD_BARE",
	"WORKSPACE_CHILD_UNBORN",
	"WORKSPACE_CHILD_DEFAULT_BRANCH_UNKNOWN",
	"WORKSPACE_CHILD_ORIGIN_REQUIRED",
	"WORKSPACE_PARENT_GITIGNORE_FAILED",
	"WORKSPACE_PARENT_COMMIT_FAILED",
	"WORKSPACE_PARENT_INIT_FAILED",
	"WORKSPACE_PARENT_ADD_FAILED",
	"WORKSPACE_PARENT_INDEX_FAILED",
	"WORKSPACE_PARENT_GITLINK",
	"PROJECT_ID_REQUIRED",
	"PR_REQUIRED",
	"PROMPT_TOO_LONG",
	"DISPLAY_NAME_TOO_LONG",
	"BRANCH_CHECKED_OUT_ELSEWHERE",
	"BRANCH_NOT_FETCHED",
	"INVALID_BRANCH",
	"AGENT_BINARY_NOT_FOUND",
	"RUNTIME_PREREQUISITE_MISSING",
	"UNKNOWN_HARNESS",
	"AGENT_REQUIRED",
	"PROJECT_NOT_RESOLVABLE",
	"SESSION_NOT_FOUND",
	"SESSION_NOT_RESTORABLE",
	"SESSION_TERMINATED",
	"SESSION_AWAITING_DECISION",
	"SESSION_INCOMPLETE_HANDLE",
	"SESSION_NOT_RESUMABLE",
	"DISPLAY_NAME_REQUIRED",
	"MESSAGE_REQUIRED",
	"MESSAGE_TOO_LONG",
	"NO_PREVIEW_ENTRY",
	"PREVIEW_FILE_NOT_FOUND",
	"INVALID_QUERY",
	"INVALID_ACTIVITY_STATE",
	"INVALID_PR_REF",
	"PR_NOT_OPEN",
	"PR_CLAIMED_BY_ACTIVE_SESSION",
	"SESSION_NOT_CLAIMABLE",
	"SESSION_NO_WORKSPACE",
	"PR_PROJECT_MISMATCH",
	"INVALID_PR_ACTION",
	"SCM_CONNECTIONS_LIST_FAILED",
	"RESERVED_SCM_CONNECTION_ID",
	"SCM_CONNECTION_CREATE_FAILED",
	"SCM_CONNECTION_ALREADY_EXISTS",
	"INVALID_SCM_CONNECTION_ID",
	"SCM_CONNECTION_UPDATE_FAILED",
	"SCM_CREDENTIAL_CLEANUP_FAILED",
	"SCM_CONNECTION_REFERENCED",
	"SCM_CONNECTION_DELETE_FAILED",
	"SCM_REPOSITORY_REQUIRED",
	"SCM_CONNECTION_TEST_UNAVAILABLE",
	"SCM_CONNECTION_TEST_FAILED",
	"SCM_CONNECTION_LOAD_FAILED",
	"SCM_CONNECTION_TEST_STATUS_SAVE_FAILED",
	"SCM_CONNECTION_TEST_STALE",
	"INVALID_SCM_PROVIDER",
	"SCM_CONNECTION_DISPLAY_NAME_REQUIRED",
	"SCM_CREDENTIAL_STORE_FAILED",
	"SCM_CONNECTION_NOT_FOUND",
	"INVALID_SCM_CONNECTION_URL",
	"SCM_AUTH_FAILED",
	"SCM_FORBIDDEN",
	"SCM_INSTANCE_UNREACHABLE",
	"SCM_TLS_FAILED",
	"SCM_RATE_LIMITED",
	"SCM_REPO_NOT_FOUND",
	"SCM_WRITE_SCOPE_MISSING",
	"SCM_UNAVAILABLE",
	"PR_NOT_FOUND",
	"PR_NOT_MERGEABLE",
	"PR_PRECONDITIONS_UNMET",
	"PR_ACTION_FORBIDDEN",
	"NOTHING_TO_RESOLVE",
	"PR_OPERATION_FAILED",
	"REVIEW_INVALID",
	"REVIEW_NOT_FOUND",
	"REVIEWER_BINARY_NOT_FOUND",
	"INVALID_NOTIFICATION_ID",
	"INVALID_NOTIFICATION_STATUS",
	"NOTIFICATION_NOT_FOUND",
	"MOBILE_ENABLE",
	"MOBILE_DISABLE",
	"MOBILE_REGEN",
] as const;

type StableAPIErrorCode = (typeof STABLE_API_ERROR_CODES)[number];
type ErrorCodeKey = `errors.codes.${StableAPIErrorCode}`;

export const ERROR_CODE_KEYS = Object.fromEntries(
	STABLE_API_ERROR_CODES.map((code) => [code, `errors.codes.${code}`]),
) as Record<StableAPIErrorCode, ErrorCodeKey>;

const URL_CREDENTIAL_PATTERN = /:\/\/[^/\s:]+:[^@/\s]+@/;
const NORMALIZED_CREDENTIAL_MARKER =
	/(?:token|credential|secret|passphrase|password|passwd|authorization|bearer|apikey|privatekey|oauthkey)/;

function containsCredential(message: string): boolean {
	const normalized = message.toLowerCase().replace(/[^a-z0-9]/g, "");
	return (
		NORMALIZED_CREDENTIAL_MARKER.test(normalized) ||
		URL_CREDENTIAL_PATTERN.test(message) ||
		TOKEN_VALUE_PATTERN.test(message)
	);
}

function structuredAPIMessage(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const body = error as { error?: unknown; code?: unknown; message?: unknown };
	if (
		typeof body.error !== "string" ||
		body.error.trim() === "" ||
		typeof body.code !== "string" ||
		body.code.trim() === "" ||
		typeof body.message !== "string" ||
		body.message.trim() === ""
	) {
		return undefined;
	}
	const message = body.message.trim();
	if (containsCredential(message)) return undefined;
	return message;
}

export interface APIErrorSnapshot {
	code?: string;
	detail?: string;
}

/** Return only locale-neutral API error data that is safe to persist. */
export function apiErrorSnapshot(error: unknown): APIErrorSnapshot {
	const code = apiErrorCode(error);
	if (code && Object.hasOwn(ERROR_CODE_KEYS, code)) return { code };
	const detail = structuredAPIMessage(error);
	return detail ? { detail } : {};
}

/** Preserve useful local operation failures without exposing credential-bearing text. */
export function safeExternalErrorMessage(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	const message = error.message.trim();
	return message && !containsCredential(message) ? message : undefined;
}

export function apiErrorMessage(error: unknown, fallback: string = i18n.t("errors.generic")): string {
	const code = apiErrorCode(error);
	if (code && Object.hasOwn(ERROR_CODE_KEYS, code)) {
		return i18n.t(ERROR_CODE_KEYS[code as StableAPIErrorCode]);
	}
	const message = structuredAPIMessage(error);
	return message ? i18n.t("errors.withDetail", { summary: fallback, detail: message }) : fallback;
}
