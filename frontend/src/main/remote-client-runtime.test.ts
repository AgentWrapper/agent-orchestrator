// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeRemoteForwarder, RemoteClientRuntime, type RemoteClientRuntimeDeps } from "./remote-client-runtime";
import { RemoteForwarderStartError, type RemoteForwarder } from "./remote-forwarder";
import type { RemoteServerConfig, RemoteServerConfigInput } from "./remote-server-config";

function saved(input: RemoteServerConfigInput): RemoteServerConfig {
	return { ...input, updatedAt: "2026-07-15T00:00:00.000Z" };
}

function forwarder(port: number) {
	return {
		port,
		resolvePreviewURL: vi.fn((_ownerId: string, _sessionId: string, url: string) => `forwarded:${port}:${url}`),
		releasePreview: vi.fn((_ownerId: string) => undefined),
		originalPreviewURL: vi.fn((url: string) => `original:${port}:${url}`),
		close: vi.fn(async () => undefined),
	} satisfies RemoteForwarder;
}

type ForwarderMock = ReturnType<typeof forwarder>;

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("RemoteClientRuntime", () => {
	let current: RemoteServerConfig | null;
	let created: ForwarderMock[];
	let statuses: unknown[];
	let deps: RemoteClientRuntimeDeps;

	beforeEach(() => {
		current = null;
		created = [];
		statuses = [];
		deps = {
			readConfig: vi.fn(async () => current),
			writeConfig: vi.fn(async (input) => {
				current = saved(input);
				return current;
			}),
			startForwarder: vi.fn(async () => {
				const next = forwarder(4100 + created.length);
				created.push(next);
				return next;
			}),
			probe: vi.fn(async () => undefined),
			onStatus: (status) => statuses.push(status),
			onForwarderChanged: vi.fn(async () => undefined),
		};
	});

	it("reports not configured without starting a proxy", async () => {
		const runtime = new RemoteClientRuntime(deps);

		expect(await runtime.start()).toEqual({ state: "error", code: "not_configured" });
		expect(deps.startForwarder).not.toHaveBeenCalled();
		expect(runtime.getConfig()).toBeNull();
	});

	it("loads a saved configuration and reports the loopback proxy port", async () => {
		current = saved({ host: "server", port: 3011, password: "secret" });
		const runtime = new RemoteClientRuntime(deps);

		expect(await runtime.start()).toEqual({ state: "ready", port: 4100 });
		expect(deps.probe).toHaveBeenCalledWith(4100);
		expect(runtime.getConfig()).toEqual({ host: "server", port: 3011 });
		expect(runtime.getConfig()).not.toHaveProperty("password");
		expect(runtime.getEditableConfig()).toEqual({ host: "server", port: 3011, passwordConfigured: true });
		expect(runtime.getEditableConfig()).not.toHaveProperty("password");
		expect(runtime.revealPassword()).toBe("secret");
		expect(deps.onForwarderChanged).toHaveBeenCalledOnce();
	});

	it("delegates preview URL operations only while a forwarder is active", async () => {
		current = saved({ host: "server", port: 3011, password: "secret" });
		const runtime = new RemoteClientRuntime(deps);

		expect(runtime.resolvePreviewURL("owner", "session", "http://localhost:5173/app")).toBe(
			"http://localhost:5173/app",
		);
		expect(runtime.originalPreviewURL("http://opaque.local/app")).toBe("http://opaque.local/app");
		expect(() => runtime.releasePreview("owner")).not.toThrow();

		await runtime.start();

		expect(runtime.resolvePreviewURL("owner", "session", "http://localhost:5173/app")).toBe(
			"forwarded:4100:http://localhost:5173/app",
		);
		expect(runtime.originalPreviewURL("http://opaque.local/app")).toBe(
			"original:4100:http://opaque.local/app",
		);
		runtime.releasePreview("owner");
		expect(created[0].releasePreview).toHaveBeenCalledWith("owner");
	});

	it("awaits BrowserView refresh after startup activates the forwarder", async () => {
		current = saved({ host: "server", port: 3011, password: "secret" });
		const refreshed = deferred();
		vi.mocked(deps.onForwarderChanged).mockImplementationOnce(() => refreshed.promise);
		const runtime = new RemoteClientRuntime(deps);

		const starting = runtime.start();
		await vi.waitFor(() => expect(deps.onForwarderChanged).toHaveBeenCalledOnce());
		expect(runtime.resolvePreviewURL("owner", "session", "source")).toBe("forwarded:4100:source");
		let settled = false;
		void starting.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		refreshed.resolve();
		expect(await starting).toEqual({ state: "ready", port: 4100 });
	});

	it("retains persisted settings for recovery when the startup probe fails", async () => {
		current = saved({ host: "offline-server", port: 4011, password: "rotated-secret" });
		vi.mocked(deps.probe).mockRejectedValueOnce(new Error("connection refused"));
		const runtime = new RemoteClientRuntime(deps);

		expect(await runtime.start()).toEqual({
			state: "error",
			code: "daemon_unreachable",
			message: "connection refused",
		});
		expect(runtime.getEditableConfig()).toEqual({ host: "offline-server", port: 4011, passwordConfigured: true });
		expect(runtime.revealPassword()).toBe("rotated-secret");
	});

	it("reuses the persisted password when a settings save omits it", async () => {
		current = saved({ host: "first", port: 3011, password: "saved-secret" });
		const runtime = new RemoteClientRuntime(deps);
		await runtime.start();

		await runtime.saveConfig({ host: "second", port: 3012 });

		expect(deps.writeConfig).toHaveBeenCalledWith({ host: "second", port: 3012, password: "saved-secret" });
	});

	it("rejects an unreachable candidate and keeps the working proxy active", async () => {
		current = saved({ host: "first", port: 3011, password: "first-secret" });
		const runtime = new RemoteClientRuntime(deps);
		await runtime.start();
		vi.mocked(deps.probe).mockRejectedValueOnce(new Error("connection refused"));

		const result = await runtime.saveConfig({ host: "second", port: 3012, password: "second-secret" });

		expect(result).toMatchObject({ state: "error", code: "daemon_unreachable", message: "connection refused" });
		expect(created[0].close).not.toHaveBeenCalled();
		expect(created[1].close).toHaveBeenCalledOnce();
		expect(runtime.getStatus()).toEqual({ state: "ready", port: 4100 });
		expect(runtime.getConfig()).toEqual({ host: "first", port: 3011 });
		expect(deps.writeConfig).not.toHaveBeenCalled();
	});

	it("keeps the working proxy when persistence fails", async () => {
		current = saved({ host: "first", port: 3011, password: "first-secret" });
		const runtime = new RemoteClientRuntime(deps);
		await runtime.start();
		vi.mocked(deps.onForwarderChanged).mockImplementationOnce(async () => {
			expect(runtime.resolvePreviewURL("owner", "session", "source")).toBe("forwarded:4101:source");
		}).mockImplementationOnce(async () => {
			expect(runtime.resolvePreviewURL("owner", "session", "source")).toBe("forwarded:4100:source");
			expect(created[1].close).not.toHaveBeenCalled();
		});
		vi.mocked(deps.writeConfig).mockRejectedValueOnce(new Error("secure storage unavailable"));

		const result = await runtime.saveConfig({ host: "second", port: 3012, password: "second-secret" });

		expect(result).toEqual({
			state: "error",
			code: "remote_config_save_failed",
			message: "secure storage unavailable",
		});
		expect(created[0].close).not.toHaveBeenCalled();
		expect(created[1].close).toHaveBeenCalledOnce();
		expect(runtime.getStatus()).toEqual({ state: "ready", port: 4100 });
		expect(current).toEqual(saved({ host: "first", port: 3011, password: "first-secret" }));
		expect(deps.onForwarderChanged).toHaveBeenCalledTimes(3);
	});

	it("rolls BrowserView and runtime back before closing a candidate whose refresh fails", async () => {
		current = saved({ host: "first", port: 3011, password: "first-secret" });
		const runtime = new RemoteClientRuntime(deps);
		await runtime.start();
		vi.mocked(deps.onForwarderChanged)
			.mockImplementationOnce(async () => {
				expect(runtime.resolvePreviewURL("owner", "session", "source")).toBe("forwarded:4101:source");
				throw new Error("preview refresh failed");
			})
			.mockImplementationOnce(async () => {
				expect(runtime.resolvePreviewURL("owner", "session", "source")).toBe("forwarded:4100:source");
				expect(created[1].close).not.toHaveBeenCalled();
			});

		const result = await runtime.saveConfig({ host: "second", port: 3012, password: "second-secret" });

		expect(result).toEqual({
			state: "error",
			code: "daemon_unreachable",
			message: "preview refresh failed",
		});
		expect(deps.writeConfig).not.toHaveBeenCalled();
		expect(current).toEqual(saved({ host: "first", port: 3011, password: "first-secret" }));
		expect(runtime.getConfig()).toEqual({ host: "first", port: 3011 });
		expect(runtime.resolvePreviewURL("owner", "session", "source")).toBe("forwarded:4100:source");
		expect(created[0].close).not.toHaveBeenCalled();
		expect(created[1].close).toHaveBeenCalledOnce();
		expect(deps.onForwarderChanged).toHaveBeenCalledTimes(3);
	});

	it("returns semantic validation failures without replacing the working proxy", async () => {
		current = saved({ host: "first", port: 3011, password: "first-secret" });
		const runtime = new RemoteClientRuntime(deps);
		await runtime.start();

		const result = await runtime.saveConfig({ host: " ", port: 3012, password: "second-secret" });

		expect(result).toEqual({ state: "error", code: "remote_host_required" });
		expect(runtime.getStatus()).toEqual({ state: "ready", port: 4100 });
		expect(created).toHaveLength(1);
		expect(created[0].close).not.toHaveBeenCalled();
	});

	it("filters credential-bearing and non-Error network failures", async () => {
		current = saved({ host: "server", port: 3011, password: "secret" });
		vi.mocked(deps.probe)
			.mockRejectedValueOnce(new Error("Authorization: Bearer do-not-show"))
			.mockRejectedValueOnce({ reason: "ECONNREFUSED" });
		const runtime = new RemoteClientRuntime(deps);

		expect(await runtime.start()).toEqual({ state: "error", code: "daemon_unreachable" });
		expect(await runtime.start()).toEqual({ state: "error", code: "daemon_unreachable" });
	});

	it("returns a semantic failure without raw text when the local forwarder cannot bind", async () => {
		current = saved({ host: "server", port: 3011, password: "secret" });
		vi.mocked(deps.startForwarder).mockRejectedValueOnce(new RemoteForwarderStartError());
		const runtime = new RemoteClientRuntime(deps);

		expect(await runtime.start()).toEqual({ state: "error", code: "remote_forwarder_bind_failed" });
	});

	it("persists and swaps a validated candidate before closing the old proxy", async () => {
		current = saved({ host: "first", port: 3011, password: "first-secret" });
		const runtime = new RemoteClientRuntime(deps);
		await runtime.start();

		const result = await runtime.saveConfig({ host: " second ", port: 3012, password: "second-secret" });

		expect(result).toEqual({ state: "ready", port: 4101 });
		expect(runtime.getConfig()).toEqual({ host: "second", port: 3012 });
		expect(created[0].close).toHaveBeenCalledOnce();
		expect(created[1].close).not.toHaveBeenCalled();
		expect(statuses.at(-1)).toEqual({ state: "ready", port: 4101 });
	});

	it("refreshes previews on the candidate port before closing the old forwarder", async () => {
		current = saved({ host: "first", port: 3011, password: "first-secret" });
		const runtime = new RemoteClientRuntime(deps);
		await runtime.start();
		const refreshed = deferred();
		vi.mocked(deps.onForwarderChanged).mockImplementationOnce(() => {
			expect(runtime.resolvePreviewURL("owner", "session", "source")).toBe("forwarded:4101:source");
			expect(created[0].close).not.toHaveBeenCalled();
			return refreshed.promise;
		});

		const saving = runtime.saveConfig({ host: "second", port: 3012, password: "second-secret" });
		await vi.waitFor(() => expect(deps.onForwarderChanged).toHaveBeenCalledTimes(2));
		expect(created[0].close).not.toHaveBeenCalled();

		refreshed.resolve();
		expect(await saving).toEqual({ state: "ready", port: 4101 });
		expect(created[0].close).toHaveBeenCalledOnce();
	});

	it("serializes a settings save behind a slow startup probe", async () => {
		current = saved({ host: "startup", port: 3011, password: "startup-secret" });
		const startupProbe = deferred();
		vi.mocked(deps.probe)
			.mockImplementationOnce(() => startupProbe.promise)
			.mockResolvedValueOnce(undefined);
		const runtime = new RemoteClientRuntime(deps);

		const starting = runtime.start();
		await vi.waitFor(() => expect(deps.probe).toHaveBeenCalledWith(4100));
		const saving = runtime.saveConfig({ host: "saved", port: 3012, password: "saved-secret" });
		await Promise.resolve();
		expect(deps.startForwarder).toHaveBeenCalledTimes(1);
		expect(deps.writeConfig).not.toHaveBeenCalled();

		startupProbe.resolve();
		expect(await starting).toEqual({ state: "ready", port: 4100 });
		expect(await saving).toEqual({ state: "ready", port: 4101 });
		expect(created).toHaveLength(2);
		expect(created[0].close).toHaveBeenCalledOnce();
		expect(created[1].close).not.toHaveBeenCalled();
		expect(runtime.getConfig()).toEqual({ host: "saved", port: 3012 });
		expect(runtime.getStatus()).toEqual({ state: "ready", port: 4101 });
		expect(statuses.at(-1)).toEqual({ state: "ready", port: 4101 });
	});

	it("stops only its local proxy", async () => {
		current = saved({ host: "server", port: 3011, password: "secret" });
		const runtime = new RemoteClientRuntime(deps);
		await runtime.start();

		expect(await runtime.stop()).toEqual({ state: "stopped" });
		expect(created[0].close).toHaveBeenCalledOnce();
		expect(runtime.getStatus()).toEqual({ state: "stopped" });
		expect(deps.onForwarderChanged).toHaveBeenCalledOnce();
	});
});

describe("probeRemoteForwarder", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		[401, "remote_bad_password", undefined],
		[429, "remote_rate_limited", undefined],
		[503, "remote_http_error", 503],
	] as const)("classifies HTTP %s without an English message", async (status, code, httpStatus) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status }));

		try {
			await probeRemoteForwarder(4100);
			throw new Error("expected probe to fail");
		} catch (error) {
			expect(error).toMatchObject({ code, ...(httpStatus === undefined ? {} : { httpStatus }) });
			expect((error as Error).message).toBe(code);
		}
	});

	it("classifies a non-AO endpoint as an identity mismatch", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ service: "some-other-service" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		await expect(probeRemoteForwarder(4100)).rejects.toMatchObject({ code: "identity_mismatch" });
	});

	it("propagates probe classifications through runtime status", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 401 }));
		const config = saved({ host: "server", port: 3011, password: "secret" });
		const runtime = new RemoteClientRuntime({
			readConfig: async () => config,
			writeConfig: async (input) => saved(input),
			startForwarder: async () => forwarder(4100),
			probe: probeRemoteForwarder,
			onStatus: () => undefined,
			onForwarderChanged: async () => undefined,
		});

		expect(await runtime.start()).toEqual({ state: "error", code: "remote_bad_password" });
	});
});
