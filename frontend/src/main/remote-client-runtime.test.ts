// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteClientRuntime, type RemoteClientRuntimeDeps } from "./remote-client-runtime";
import type { RemoteForwarder } from "./remote-forwarder";
import type { RemoteServerConfig, RemoteServerConfigInput } from "./remote-server-config";

function saved(input: RemoteServerConfigInput): RemoteServerConfig {
	return { ...input, updatedAt: "2026-07-15T00:00:00.000Z" };
}

function forwarder(port: number): RemoteForwarder & { close: ReturnType<typeof vi.fn> } {
	return { port, close: vi.fn(async () => undefined) };
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

		expect(await runtime.start()).toMatchObject({ state: "error", code: "not_configured" });
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

		expect(result).toMatchObject({ state: "error", code: "not_configured", message: "secure storage unavailable" });
		expect(created[0].close).not.toHaveBeenCalled();
		expect(created[1].close).toHaveBeenCalledOnce();
		expect(runtime.getStatus()).toEqual({ state: "ready", port: 4100 });
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

	it("stops only its local proxy", async () => {
		current = saved({ host: "server", port: 3011, password: "secret" });
		const runtime = new RemoteClientRuntime(deps);
		await runtime.start();

		expect(await runtime.stop()).toEqual({ state: "stopped" });
		expect(created[0].close).toHaveBeenCalledOnce();
		expect(runtime.getStatus()).toEqual({ state: "stopped" });
	});
});
