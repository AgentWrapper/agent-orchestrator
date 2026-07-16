// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from "vitest";

const { exposeInMainWorld, invoke } = vi.hoisted(() => ({
	exposeInMainWorld: vi.fn(),
	invoke: vi.fn(async () => undefined),
}));

vi.mock("electron", () => ({
	contextBridge: { exposeInMainWorld },
	ipcRenderer: {
		invoke,
		on: vi.fn(),
		off: vi.fn(),
		send: vi.fn(),
	},
}));

describe("preload remoteServer bridge", () => {
	let remoteServer: {
		get(): Promise<unknown>;
		revealPassword(): Promise<unknown>;
	};
	let locale: {
		get(): Promise<unknown>;
		set(preference: string): Promise<unknown>;
	};

	beforeAll(async () => {
		await import("./preload");
		remoteServer = exposeInMainWorld.mock.calls[0][1].remoteServer;
		locale = exposeInMainWorld.mock.calls[0][1].locale;
	});

	it("uses a separate IPC call for explicit password reveal", async () => {
		await remoteServer.get();
		expect(invoke).toHaveBeenLastCalledWith("remoteServer:get");

		await remoteServer.revealPassword();
		expect(invoke).toHaveBeenLastCalledWith("remoteServer:revealPassword");
	});

	it("uses the locale IPC channels exactly", async () => {
		await locale.get();
		expect(invoke).toHaveBeenLastCalledWith("locale:get");

		await locale.set("zh-CN");
		expect(invoke).toHaveBeenLastCalledWith("locale:set", "zh-CN");
	});
});
