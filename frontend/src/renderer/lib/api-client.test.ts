import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiClient,
	apiErrorCode,
	apiErrorMessage,
	apiErrorSnapshot,
	ERROR_CODE_KEYS,
	getApiBaseUrl,
	hasTrustedApiBaseUrl,
	normalizeApiOperation,
	setApiBaseUrl,
	safeExternalErrorMessage,
	subscribeApiBaseUrl,
} from "./api-client";
import { i18n } from "../i18n";
import { captureRendererEvent } from "./telemetry";

vi.mock("./telemetry", () => ({
	captureRendererEvent: vi.fn().mockResolvedValue(undefined),
}));

const captureMock = vi.mocked(captureRendererEvent);

describe("apiClient runtime base URL", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		setApiBaseUrl("http://127.0.0.1:3001");
	});

	it("rewrites requests to the current runtime daemon port", async () => {
		const seenUrls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
			seenUrls.push(input instanceof Request ? input.url : input.toString());
			return new Response(JSON.stringify({ projects: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		setApiBaseUrl("http://127.0.0.1:3037/");

		const { error } = await apiClient.GET("/api/v1/projects");

		expect(error).toBeUndefined();
		expect(getApiBaseUrl()).toBe("http://127.0.0.1:3037");
		expect(seenUrls).toEqual(["http://127.0.0.1:3037/api/v1/projects"]);
	});

	it("rebases POSTs without Request-as-init, preserving method, body, and headers", async () => {
		// Regression: `new Request(target, input)` needs the source request's
		// `duplex` getter, which Electron's Chromium lacks — every request with a
		// body threw. The rewrite must copy fields explicitly instead.
		const seen: { url: string; method?: string; body?: string; contentType?: string | null }[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			seen.push({
				url: input instanceof Request ? input.url : input.toString(),
				method: init?.method,
				body: init?.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) : undefined,
				contentType: headers.get("content-type"),
			});
			return new Response(JSON.stringify({ session: { id: "s1" } }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			});
		});

		setApiBaseUrl("http://127.0.0.1:3037");

		const { error } = await apiClient.POST("/api/v1/sessions", {
			body: { projectId: "p1", prompt: "hello" },
		});

		expect(error).toBeUndefined();
		expect(seen).toHaveLength(1);
		expect(seen[0].url).toBe("http://127.0.0.1:3037/api/v1/sessions");
		expect(seen[0].method).toBe("POST");
		expect(seen[0].contentType).toBe("application/json");
		expect(JSON.parse(seen[0].body ?? "{}")).toEqual({ projectId: "p1", prompt: "hello" });
	});

	it("skips the rebase when the request already targets the runtime base URL", async () => {
		const seen: (RequestInfo | URL)[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
			seen.push(input);
			return new Response(JSON.stringify({ projects: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		// Match the base openapi-fetch built the request against (the dev origin
		// in jsdom), so the rewrite has nothing to do.
		setApiBaseUrl(window.location.origin);
		const { error } = await apiClient.GET("/api/v1/projects");

		expect(error).toBeUndefined();
		expect(seen).toHaveLength(1);
		// Untouched pass-through: fetch receives the original Request object.
		expect(seen[0]).toBeInstanceOf(Request);
	});

	it("passes the request through untouched when the base URL is empty", async () => {
		const seen: Request[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
			seen.push(input as Request);
			return new Response(JSON.stringify({ projects: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		setApiBaseUrl("");

		const { error } = await apiClient.GET("/api/v1/projects");

		expect(error).toBeUndefined();
		expect(getApiBaseUrl()).toBe("");
		// Empty base → no rewrite; openapi-fetch's own request reaches fetch as-is.
		expect(seen).toHaveLength(1);
		expect(seen[0].url).toContain("/api/v1/projects");
	});

	it("returns unavailable without fetching when the daemon base URL is untrusted", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		setApiBaseUrl(null);

		const { error } = await apiClient.GET("/api/v1/projects");

		expect(error).toEqual({
			error: "unavailable",
			code: "DAEMON_NOT_READY",
			message: "DAEMON_NOT_READY",
		});
		expect(apiErrorMessage(error)).toBe("The AO daemon is not ready");
		expect(getApiBaseUrl()).toBe("");
		expect(hasTrustedApiBaseUrl()).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("subscribeApiBaseUrl", () => {
	afterEach(() => {
		setApiBaseUrl("http://127.0.0.1:3001");
	});

	it("notifies subscribers when the base URL actually changes", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeApiBaseUrl(listener);
		try {
			setApiBaseUrl("http://127.0.0.1:4555");
			expect(listener).toHaveBeenCalledTimes(1);
			expect(getApiBaseUrl()).toBe("http://127.0.0.1:4555");
		} finally {
			unsubscribe();
		}
	});

	it("does not notify for a no-op set (same URL, trailing slash included)", () => {
		setApiBaseUrl("http://127.0.0.1:4555");
		const listener = vi.fn();
		const unsubscribe = subscribeApiBaseUrl(listener);
		try {
			setApiBaseUrl("http://127.0.0.1:4555");
			setApiBaseUrl("http://127.0.0.1:4555/");
			expect(listener).not.toHaveBeenCalled();
		} finally {
			unsubscribe();
		}
	});

	it("stops notifying after unsubscribe", () => {
		const listener = vi.fn();
		subscribeApiBaseUrl(listener)();

		setApiBaseUrl("http://127.0.0.1:4555");

		expect(listener).not.toHaveBeenCalled();
	});
});

describe("normalizeApiOperation", () => {
	it("replaces identifier segments after resource collections", () => {
		expect(normalizeApiOperation("get", "/api/v1/projects/my project id")).toBe("GET /api/v1/projects/:id");
		expect(normalizeApiOperation("POST", "/api/v1/sessions/ao-42/kill")).toBe("POST /api/v1/sessions/:id/kill");
		expect(normalizeApiOperation("PUT", "/api/v1/projects/p1/config")).toBe("PUT /api/v1/projects/:id/config");
	});

	it("leaves collection and non-resource paths untouched", () => {
		expect(normalizeApiOperation("GET", "/api/v1/projects")).toBe("GET /api/v1/projects");
		expect(normalizeApiOperation("POST", "/api/v1/orchestrators")).toBe("POST /api/v1/orchestrators");
	});

	it("keeps static child routes instead of treating them as ids", () => {
		// These match an exact OpenAPI template, so the trailing segment must not
		// be collapsed to :id (which would break aggregation and hide the route).
		expect(normalizeApiOperation("POST", "/api/v1/notifications/read-all")).toBe("POST /api/v1/notifications/read-all");
		expect(normalizeApiOperation("POST", "/api/v1/sessions/cleanup")).toBe("POST /api/v1/sessions/cleanup");
	});

	it("normalizes ids for resources a collection heuristic would miss", () => {
		expect(normalizeApiOperation("GET", "/api/v1/orchestrators/orch-abc")).toBe("GET /api/v1/orchestrators/:id");
		expect(normalizeApiOperation("POST", "/api/v1/prs/pr-1/merge")).toBe("POST /api/v1/prs/:id/merge");
		expect(normalizeApiOperation("PUT", "/api/v1/scm/connections/gitlab-secret-name")).toBe(
			"PUT /api/v1/scm/connections/:id",
		);
		expect(normalizeApiOperation("POST", "/api/v1/scm/connections/gitlab-secret-name/test")).toBe(
			"POST /api/v1/scm/connections/:id/test",
		);
		expect(normalizeApiOperation("POST", "/api/v1/sessions/private-session/reviews/publish")).toBe(
			"POST /api/v1/sessions/:id/reviews/publish",
		);
	});
});

describe("api error telemetry", () => {
	// The dedupe window keys off Date.now(); jump the clock far past any
	// earlier test's reports so each test starts with a clean window.
	let clock = Date.UTC(2100, 0, 1);
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		clock += 10 * 60_000;
		vi.setSystemTime(clock);
		captureMock.mockClear();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		setApiBaseUrl("http://127.0.0.1:3001");
	});

	it("reports http_5xx with a normalized operation", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("oops", { status: 500 }));
		setApiBaseUrl("http://127.0.0.1:3037");

		await apiClient.GET("/api/v1/projects");

		expect(captureMock).toHaveBeenCalledWith("ao.renderer.api_error", {
			operation: "GET /api/v1/projects",
			error_category: "http_5xx",
			status: 500,
		});
	});

	it("reports http_4xx with ids stripped from the operation", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 404 }));
		setApiBaseUrl("http://127.0.0.1:3037");

		await apiClient.POST("/api/v1/sessions/{sessionId}/kill", {
			params: { path: { sessionId: "ao-raw-id" } },
		});

		expect(captureMock).toHaveBeenCalledWith("ao.renderer.api_error", {
			operation: "POST /api/v1/sessions/:id/kill",
			error_category: "http_4xx",
			status: 404,
		});
	});

	it("reports network_error and rethrows", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
		setApiBaseUrl("http://127.0.0.1:3037");

		await expect(apiClient.GET("/api/v1/projects")).rejects.toThrow("Failed to fetch");

		expect(captureMock).toHaveBeenCalledWith("ao.renderer.api_error", {
			operation: "GET /api/v1/projects",
			error_category: "network_error",
			status: undefined,
		});
	});

	it("does not report caller-initiated aborts", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("Aborted", "AbortError"));
		setApiBaseUrl("http://127.0.0.1:3037");

		await expect(apiClient.GET("/api/v1/projects")).rejects.toThrow("Aborted");

		expect(captureMock).not.toHaveBeenCalled();
	});

	it("reports daemon_unavailable when the base URL is untrusted", async () => {
		setApiBaseUrl(null);

		await apiClient.GET("/api/v1/projects");

		expect(captureMock).toHaveBeenCalledWith("ao.renderer.api_error", {
			operation: "GET /api/v1/projects",
			error_category: "daemon_unavailable",
			status: 503,
		});
	});

	it("dedupes repeated identical failures within the 30s window", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("oops", { status: 502 }));
		setApiBaseUrl("http://127.0.0.1:3037");

		await apiClient.GET("/api/v1/projects");
		await apiClient.GET("/api/v1/projects");
		expect(captureMock).toHaveBeenCalledTimes(1);

		vi.setSystemTime(clock + 31_000);
		await apiClient.GET("/api/v1/projects");
		expect(captureMock).toHaveBeenCalledTimes(2);
	});
});

describe("apiErrorMessage", () => {
	it("keeps apiErrorCode behavior unchanged", () => {
		expect(apiErrorCode({ code: "NOT_A_GIT_REPO" })).toBe("NOT_A_GIT_REPO");
		expect(apiErrorCode({ code: "" })).toBeUndefined();
		expect(apiErrorCode(new Error("failed"))).toBeUndefined();
	});

	it("localizes every explicitly mapped daemon code in both locales", async () => {
		expect(Object.keys(ERROR_CODE_KEYS)).toHaveLength(136);
		expect(Object.keys(ERROR_CODE_KEYS)).toEqual(
			expect.arrayContaining([
				"INVALID_BODY",
				"PR_REQUIRED",
				"INVALID_PR_REF",
				"PR_NOT_OPEN",
				"PR_CLAIMED_BY_ACTIVE_SESSION",
				"SESSION_NOT_CLAIMABLE",
				"SESSION_NO_WORKSPACE",
				"PR_PROJECT_MISMATCH",
				"INVALID_PR_ACTION",
				"PR_ACTION_FORBIDDEN",
				"SCM_UNAVAILABLE",
				"INVALID_ACTIVITY_STATE",
				"SSE_UNSUPPORTED",
				"INVALID_AFTER",
				"DAEMON_NOT_READY",
				"REMOTE_DAEMON_UNAVAILABLE",
			]),
		);

		for (const locale of ["en", "zh-CN"] as const) {
			await i18n.changeLanguage(locale);
			for (const [code, key] of Object.entries(ERROR_CODE_KEYS)) {
				expect(i18n.exists(key), `${locale} is missing ${key}`).toBe(true);
				expect(
					apiErrorMessage({ error: "Bad Request", code, message: "untrusted diagnostic" }),
					`${code} should use ${key}`,
				).toBe(i18n.t(key));
			}
		}
	});

	it("localizes a stable daemon error code without exposing its details", async () => {
		await i18n.changeLanguage("zh-CN");

		expect(
			apiErrorMessage({
				code: "DIRECTORY_PERMISSION_DENIED",
				message: "Directory permission denied; token=do-not-show",
				details: { error: "credential-do-not-show" },
			}),
		).toBe("没有权限访问该目录");
	});

	it("uses the localized generic fallback for arbitrary errors", async () => {
		await i18n.changeLanguage("zh-CN");

		expect(apiErrorMessage(new Error("transport secret"))).toBe("请求失败");
	});

	it("adds only a complete unknown API envelope message to the localized fallback", async () => {
		await i18n.changeLanguage("en");

		expect(
			apiErrorMessage(
				{ error: "Conflict", code: "FUTURE_CODE", message: "The server rejected this state." },
				"Could not continue",
			),
		).toBe("Could not continue: The server rejected this state.");
	});

	it.each([
		new Error("Bearer top-secret"),
		"password=top-secret",
		{ message: "forwarder leaked token=top-secret" },
		{ error: "Conflict", code: "FUTURE_CODE", message: "Authorization: Bearer top-secret" },
		{ error: "Conflict", code: "FUTURE_CODE", message: "glpat-top-secret" },
		{ error: "Conflict", code: "FUTURE_CODE", message: "safe", details: { error: "top-secret" } },
	])("does not expose arbitrary or credential-bearing errors", async (error) => {
		await i18n.changeLanguage("en");
		const message = apiErrorMessage(error, "Could not continue");

		expect(message).not.toContain("top-secret");
		if (typeof error === "object" && error !== null && "details" in error) {
			expect(message).toBe("Could not continue: safe");
		} else {
			expect(message).toBe("Could not continue");
		}
	});

	it.each([
		"access_token=review-secret",
		"accessToken: review-secret",
		"refresh_token=review-secret",
		"refreshToken: review-secret",
		"credential=review-secret",
		"credentials: review-secret",
		"client_secret=review-secret",
		"clientSecret: review-secret",
		"secret=review-secret",
		"passphrase: review-secret",
		"oauth-token=review-secret",
		"oauthToken: review-secret",
		"api_key=review-secret",
		"apiKey: review-secret",
		"private-token=review-secret",
		"privateToken: review-secret",
		"private_key=review-secret",
		"privateKey: review-secret",
	])("rejects unknown envelope details containing credential marker %s", async (detail) => {
		await i18n.changeLanguage("en");

		expect(apiErrorMessage({ error: "Conflict", code: "FUTURE_CODE", message: detail }, "Could not continue")).toBe(
			"Could not continue",
		);
	});
});

describe("apiErrorSnapshot", () => {
	it("serializes a known code without its diagnostic message", () => {
		expect(
			apiErrorSnapshot({
				error: "Forbidden",
				code: "DIRECTORY_PERMISSION_DENIED",
				message: "Directory permission denied; token=do-not-show",
			}),
		).toEqual({ code: "DIRECTORY_PERMISSION_DENIED" });
	});

	it("serializes only a safe detail from an unknown complete envelope", () => {
		expect(apiErrorSnapshot({ error: "Conflict", code: "FUTURE_CODE", message: "disk full on /srv/legacy" })).toEqual({
			detail: "disk full on /srv/legacy",
		});
		expect(
			apiErrorSnapshot({ error: "Conflict", code: "FUTURE_CODE", message: "Authorization: Bearer top-secret" }),
		).toEqual({});
	});
});

describe("safeExternalErrorMessage", () => {
	it("returns a non-sensitive local Error message", () => {
		expect(safeExternalErrorMessage(new Error("connection reset by peer"))).toBe("connection reset by peer");
	});

	it("rejects empty, non-Error, and credential-bearing messages", () => {
		expect(safeExternalErrorMessage(new Error("  "))).toBeUndefined();
		expect(safeExternalErrorMessage("connection reset by peer")).toBeUndefined();
		expect(safeExternalErrorMessage(new Error("token=top-secret"))).toBeUndefined();
	});
});
