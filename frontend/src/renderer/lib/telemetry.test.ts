import { describe, expect, it } from "vitest";
import {
	routeSurface,
	sanitizePostHogEvent,
	sanitizeReplayRequestName,
	sanitizeRendererExceptionProperties,
	sanitizeRendererProperties,
} from "./telemetry";

describe("telemetry sanitizers", () => {
	it("categorizes routes without exporting raw paths", () => {
		expect(routeSurface("/")).toBe("home");
		expect(routeSurface("/projects/demo")).toBe("project_board");
		expect(routeSurface("/projects/demo/settings")).toBe("project_settings");
		expect(routeSurface("/projects/demo/sessions/demo-1")).toBe("session_detail");
		expect(routeSurface("/prs")).toBe("pull_requests");
	});

	it("hashes renderer ids and drops raw route identifiers", async () => {
		const props = await sanitizeRendererProperties("ao.renderer.project_removed", { project_id: "demo-project" });
		expect(props).toHaveProperty("project_id_hash");
		expect(props).not.toHaveProperty("project_id");

		const routeProps = await sanitizeRendererProperties("ao.renderer.route_viewed", {
			surface: "project_board",
			pathname: "/projects/demo",
			search: "?token=secret",
		});
		expect(routeProps).toEqual({ surface: "project_board" });
	});

	it("strips exception details down to coarse metadata", async () => {
		const props = await sanitizeRendererExceptionProperties(new TypeError("local path /tmp/private"), {
			source: "window-error",
			operation: "project_add",
			unhandled: true,
			project_id: "demo-project",
			component_stack: "App > Shell",
		});
		expect(props).toMatchObject({
			error_name: "TypeError",
			source: "window-error",
			operation: "project_add",
			unhandled: true,
		});
		expect(props).toHaveProperty("project_id_hash");
		expect(props).not.toHaveProperty("project_id");
		expect(props).not.toHaveProperty("component_stack");
	});

	it("sanitizes exception step context", async () => {
		const props = await sanitizeRendererExceptionProperties(new Error("boom"), {
			source: "orchestrator-open",
			operation: "open_orchestrator",
			surface: "session_detail",
			project_id: "demo-project",
		});
		expect(props).toMatchObject({
			source: "orchestrator-open",
			operation: "open_orchestrator",
			surface: "session_detail",
		});
		expect(props).toHaveProperty("project_id_hash");
	});

	it("redacts local urls and filesystem paths from outgoing PostHog payloads", () => {
		const event = sanitizePostHogEvent({
			event: "$exception",
			properties: {
				$current_url: "app://renderer/index.html?token=secret",
				$initial_current_url: "file:///Users/alice/private/index.html",
				message:
					"failed to fetch http://localhost:3037/api/v1/projects?token=secret from app://renderer/index.html?token=secret and open /Users/alice/reverb/file.txt",
				$exception_list: [
					{
						type: "TypeError",
						value:
							"failed to load /home/alice/.config/reverb/settings.json via http://127.0.0.1:3037/api/v1/projects?token=secret",
						stacktrace: {
							frames: [
								{ filename: "file:///Users/alice/reverb/dist/main.js" },
								{ filename: "http://[::1]:3037/api/v1/projects?token=secret" },
							],
						},
					},
				],
			},
		});
		const props = event.properties as Record<string, unknown>;
		expect(props.$current_url).toBe("[redacted-local-url]");
		expect(props.$initial_current_url).toBe("[redacted-local-url]");
		expect(props.message).toBe(
			"failed to fetch [redacted-local-url] from [redacted-local-url] and open [redacted-local-path]",
		);
		const exceptionList = props.$exception_list as Array<Record<string, unknown>>;
		expect(exceptionList[0].value).toBe("failed to load [redacted-local-path] via [redacted-local-url]");
		expect((exceptionList[0].stacktrace as { frames: Array<{ filename: string }> }).frames[0].filename).toBe(
			"[redacted-local-url]",
		);
		expect((exceptionList[0].stacktrace as { frames: Array<{ filename: string }> }).frames[1].filename).toBe(
			"[redacted-local-url]",
		);
	});

	it("redacts replay request names before they leave the renderer", () => {
		expect(sanitizeReplayRequestName("file:///Users/alice/private/index.html?token=secret")).toBe(
			"[redacted-local-url]",
		);
		expect(sanitizeReplayRequestName("http://[::1]:3037/api/v1/projects?token=secret")).toBe("[redacted-local-url]");
		expect(sanitizeReplayRequestName("https://api.example.com/endpoint?token=secret")).toBe(
			"https://api.example.com/endpoint",
		);
	});

	it("hashes project ids and drops everything else on CTA triads", async () => {
		const triads = [
			"ao.renderer.task_create_requested",
			"ao.renderer.task_create_succeeded",
			"ao.renderer.task_create_failed",
			"ao.renderer.session_kill_requested",
			"ao.renderer.session_kill_succeeded",
			"ao.renderer.session_kill_failed",
			"ao.renderer.settings_save_requested",
			"ao.renderer.settings_save_succeeded",
			"ao.renderer.settings_save_failed",
		];
		for (const event of triads) {
			const props = await sanitizeRendererProperties(event, {
				project_id: "demo-project",
				title: "raw user text",
				error: "raw error with /Users/alice/path",
			});
			expect(Object.keys(props)).toEqual(["project_id_hash"]);
		}
	});

	it("keeps only the source enum on orchestrator_spawn events", async () => {
		const props = await sanitizeRendererProperties("ao.renderer.orchestrator_spawn_requested", {
			project_id: "demo-project",
			source: "board",
		});
		expect(Object.keys(props).sort()).toEqual(["project_id_hash", "source"]);
		expect(props.source).toBe("board");

		const badSource = await sanitizeRendererProperties("ao.renderer.orchestrator_spawn_failed", {
			project_id: "demo-project",
			source: "/Users/alice/private",
		});
		expect(badSource).not.toHaveProperty("source");
	});

	it("keeps every whitelisted spawn source, including topbar/sidebar/project_add/settings/restart", async () => {
		for (const source of ["board", "restore_dialog", "topbar", "sidebar", "project_add", "settings", "restart"]) {
			const props = await sanitizeRendererProperties("ao.renderer.orchestrator_spawn_succeeded", {
				project_id: "demo-project",
				source,
			});
			expect(Object.keys(props).sort()).toEqual(["project_id_hash", "source"]);
			expect(props.source).toBe(source);
		}
	});

	it("keeps only enum values on notification events", async () => {
		expect(await sanitizeRendererProperties("ao.renderer.notification_opened", { target: "pr" })).toEqual({
			target: "pr",
		});
		expect(await sanitizeRendererProperties("ao.renderer.notification_opened", { target: "http://x" })).toEqual({});
		expect(await sanitizeRendererProperties("ao.renderer.notification_marked_read", { scope: "all" })).toEqual({
			scope: "all",
		});
		expect(await sanitizeRendererProperties("ao.renderer.notification_marked_read", { scope: "everything" })).toEqual(
			{},
		);
	});

	it("whitelists coarse daemon failure fields and drops messages", async () => {
		const props = await sanitizeRendererProperties("ao.renderer.daemon_failure", {
			daemon_state: "error",
			code: "spawn_failed",
			exit_code: 1,
			signal: "SIGKILL",
			message: "spawn /Users/alice/ao failed",
		});
		expect(props).toEqual({ daemon_state: "error", code: "spawn_failed", exit_code: 1, signal: "SIGKILL" });
	});

	it("whitelists normalized api_error fields", async () => {
		const props = await sanitizeRendererProperties("ao.renderer.api_error", {
			operation: "GET /api/v1/projects/:id",
			error_category: "http_5xx",
			status: 500,
			body: "raw response body",
		});
		expect(props).toEqual({ operation: "GET /api/v1/projects/:id", error_category: "http_5xx", status: 500 });
	});

	it("keeps only the reason enum on terminal_attach_failed", async () => {
		expect(await sanitizeRendererProperties("ao.renderer.terminal_attach_failed", { reason: "open_timeout" })).toEqual({
			reason: "open_timeout",
		});
		expect(
			await sanitizeRendererProperties("ao.renderer.terminal_attach_failed", { reason: "something else" }),
		).toEqual({});
	});
});
