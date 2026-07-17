// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeRemoteForwarder, RemoteClientRuntime, type RemoteClientRuntimeDeps } from "./remote-client-runtime";
import { RemoteForwarderStartError, type RemoteForwarder } from "./remote-forwarder";
import type { RemoteServerConfig, RemoteServerConfigInput } from "./remote-server-config";

function saved(input: RemoteServerConfigInput): RemoteServerConfig {
	return { ...input, updatedAt: "2026-07-15T00:00:00.000Z" };
}

function forwarder(port: number): RemoteForwarder & { close: ReturnType<typeof vi.fn> } {
	return { port, close: vi.fn(async () => undefined) };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("RemoteClientRuntime", () => {
	let current: RemoteServerConfig | null;
	let created: Array<RemoteForwarder & { close: ReturnType<typeof vi.fn> }>;
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
		});

		expect(await runtime.start()).toEqual({ state: "error", code: "remote_bad_password" });
	});
});
