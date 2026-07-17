// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from "vitest";

const { exposeInMainWorld, invoke } = vi.hoisted(() => ({
	exposeInMainWorld: vi.fn(),
	invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined),
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
	let app: {
		scanImportFolder(input: { path: string; mode: "project" | "workspace" }): Promise<{
			path: string;
			repos: Array<{ setupCode?: "PROJECT_UNBORN" }>;
		}>;
	};
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
		app = exposeInMainWorld.mock.calls[0][1].app;
		remoteServer = exposeInMainWorld.mock.calls[0][1].remoteServer;
		locale = exposeInMainWorld.mock.calls[0][1].locale;
	});

	it("preserves the optional stable repository setup code from the scan IPC", async () => {
		invoke.mockResolvedValueOnce({
			path: "/repo/unborn",
			repos: [{ setupCode: "PROJECT_UNBORN", reason: "该仓库还没有提交" }],
		});

		const result = await app.scanImportFolder({ path: "/repo/unborn", mode: "project" });

		expect(invoke).toHaveBeenLastCalledWith("app:scanImportFolder", {
			path: "/repo/unborn",
			mode: "project",
		});
		expect(result.repos[0]?.setupCode).toBe("PROJECT_UNBORN");
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
