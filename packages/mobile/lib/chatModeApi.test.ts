import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() } }));
vi.mock("expo-secure-store", () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));

import { ApiError, apiRequest, getPreview, getSettings, launchOrchestrator, mobileReachablePreviewURL, restoreSession, resumeSessionAgent, spawnSession } from "./api";
import { getConversationPage, getWorkspacePaths } from "./chat/api";
import type { ServerConfig } from "./config";

const cfg: ServerConfig = { host: "ao.test", httpPort: "3011", muxPort: "3011", secure: false, password: "secret12" };

describe("mobile Chat API boundaries", () => {
	beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
	afterEach(() => vi.unstubAllGlobals());

	it("explicitly creates workers in Chat mode by default", async () => {
		vi.mocked(fetch).mockResolvedValue(response({ session: { id: "w-1", projectId: "p-1", mode: "chat" } }, 201));
		const session = await spawnSession(cfg, { projectId: "p-1", harness: "codex" });
		const [, init] = vi.mocked(fetch).mock.calls[0];
		expect(JSON.parse(String(init?.body))).toMatchObject({ projectId: "p-1", harness: "codex", kind: "worker", mode: "chat" });
		expect(session.mode).toBe("chat");
		expect(init?.headers).toMatchObject({ Authorization: "Bearer secret12" });
	});

	it("keeps an explicit TUI orchestrator request explicit", async () => {
		vi.mocked(fetch).mockResolvedValue(response({ orchestrator: { id: "o-1", projectId: "p-1", mode: "tui" } }, 201));
		const orchestrator = await launchOrchestrator(cfg, "p-1", true, "tui");
		const [, init] = vi.mocked(fetch).mock.calls[0];
		expect(JSON.parse(String(init?.body))).toMatchObject({ projectId: "p-1", clean: true, mode: "tui" });
		expect(orchestrator.mode).toBe("tui");
	});

	it("resumes a stopped Chat controller without restoring the AO session", async () => {
		vi.mocked(fetch).mockResolvedValue(response({ ok: true }));
		await resumeSessionAgent(cfg, "chat-1");
		const [url, init] = vi.mocked(fetch).mock.calls[0];
		expect(url).toBe("http://ao.test:3011/api/v1/sessions/chat-1/resume-agent");
		expect(init?.method).toBe("POST");
	});

	it("keeps terminated-session restoration as a distinct lifecycle operation", async () => {
		vi.mocked(fetch).mockResolvedValue(response({ ok: true }));
		await restoreSession(cfg, "chat-terminated");
		const [url, init] = vi.mocked(fetch).mock.calls[0];
		expect(url).toBe("http://ao.test:3011/api/v1/sessions/chat-terminated/restore");
		expect(init?.method).toBe("POST");
	});

	it("preserves daemon request IDs on API errors", async () => {
		vi.mocked(fetch).mockResolvedValue(response({
			error: "conflict",
			code: "SWITCH_IN_PROGRESS",
			message: "A controller switch is already running.",
			requestId: "request-mobile-1",
		}, 409));
		let thrown: unknown;
		try {
			await apiRequest(cfg, "/api/v1/sessions/w-1/interface-transition", { method: "POST" });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ApiError);
		expect(thrown).toMatchObject({
			status: 409,
			code: "SWITCH_IN_PROGRESS",
			requestId: "request-mobile-1",
		});
	});

	it("uses daemon-advertised Chat harnesses and preserves workspace truncation", async () => {
		vi.mocked(fetch)
			.mockResolvedValueOnce(response({ defaultSessionMode: "tui", chatHarnesses: ["codex", "claude-code", 42] }))
			.mockResolvedValueOnce(response({ files: [{ path: "src/app.ts", status: "modified" }, { path: "old.ts", status: "deleted" }], truncated: true }));
		expect(await getSettings(cfg)).toEqual({ defaultSessionMode: "tui", chatHarnesses: ["codex", "claude-code"] });
		expect(await getWorkspacePaths(cfg, "w-1")).toEqual({ paths: ["src/app.ts"], truncated: true });
	});

	it("keeps explicit README previews and never authenticates external preview origins", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(response({ entry: "README.md" }));
		expect(await getPreview(cfg, "w-1")).toEqual({
			entry: "README.md",
			url: "http://ao.test:3011/api/v1/sessions/w-1/preview/files/README.md",
			authenticated: true,
		});
		vi.mocked(fetch).mockResolvedValueOnce(response({}));
		expect(await getPreview(cfg, "w-1", "https://example.com/demo")).toMatchObject({
			url: "https://example.com/demo",
			authenticated: false,
		});
		expect(mobileReachablePreviewURL("http://127.0.0.1:5173", "ao.test")?.href).toBe("http://ao.test:5173/");
		expect(mobileReachablePreviewURL("http://localhost:5173", "2001:db8::5")?.href).toBe("http://[2001:db8::5]:5173/");
		expect(mobileReachablePreviewURL("http://127.0.0.1:5173", "https://macbook.local/")?.href).toBe("http://macbook.local:5173/");
		expect(mobileReachablePreviewURL("file:///tmp/demo.html", "ao.test")).toBeUndefined();
	});

	it("maps the provider-neutral conversation wire model without inventing protocol state", async () => {
		vi.mocked(fetch).mockResolvedValue(response({
			conversationId: "c-1", sessionId: "w-1", harness: "claude-code", mode: "chat", controller: "busy",
			latestSequence: 2, oldestSequence: 1, hasMoreBefore: false, settings: {}, turns: [], messages: [],
			capabilities: ["config_options", "steer"],
			activities: [{ kind: "activity", id: "a-1", sequence: 2, revision: 1, activityKind: "approval", status: "pending", summary: "Run command", requestId: "req-1", detail: { output: { text: "legacy" }, decisions: [{ id: "accept" }] }, createdAt: "2026-08-05T00:00:00Z" }],
		}));
		const page = await getConversationPage(cfg, "w-1");
		expect(page.controller).toEqual({ state: "busy" });
		expect(page.capabilities).toEqual(["config_options", "steer"]);
		expect(page.items[0]).toMatchObject({ activityKind: "approval", requestId: "req-1", decisions: [{ id: "accept", label: "accept" }], detail: { output: { text: "legacy" } } });
	});
});

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
