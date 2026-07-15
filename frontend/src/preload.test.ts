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

	beforeAll(async () => {
		await import("./preload");
		remoteServer = exposeInMainWorld.mock.calls[0][1].remoteServer;
	});

	it("uses a separate IPC call for explicit password reveal", async () => {
		await remoteServer.get();
		expect(invoke).toHaveBeenLastCalledWith("remoteServer:get");

		await remoteServer.revealPassword();
		expect(invoke).toHaveBeenLastCalledWith("remoteServer:revealPassword");
	});
});
