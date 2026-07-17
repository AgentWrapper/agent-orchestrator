// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUpdateIpcHandlers, type UpdateIpcDeps } from "./update-ipc";

describe("createUpdateIpcHandlers", () => {
	let deps: UpdateIpcDeps;

	beforeEach(() => {
		deps = {
			isRemoteClientBuild: false,
			stateDir: vi.fn(() => "/state"),
			readSettings: vi.fn(async () => ({ enabled: true, channel: "nightly" as const, nightlyAck: true })),
			writeSettings: vi.fn(async () => undefined),
			getStatus: vi.fn(() => ({ state: "available" as const, version: "1.2.3" })),
			check: vi.fn(async () => undefined),
			download: vi.fn(async () => undefined),
			install: vi.fn(),
		};
	});

	it("disables every update operation in remote builds without touching updater state", async () => {
		deps.isRemoteClientBuild = true;
		const handlers = createUpdateIpcHandlers(deps);

		expect(await handlers.getSettings()).toEqual({ enabled: false, channel: "latest", nightlyAck: false });
		await handlers.setSettings({ enabled: true, channel: "nightly", nightlyAck: true });
		expect(handlers.getStatus()).toEqual({ state: "unsupported" });
		await handlers.check();
		await handlers.download();
		handlers.install();

		expect(deps.stateDir).not.toHaveBeenCalled();
		expect(deps.readSettings).not.toHaveBeenCalled();
		expect(deps.writeSettings).not.toHaveBeenCalled();
		expect(deps.getStatus).not.toHaveBeenCalled();
		expect(deps.check).not.toHaveBeenCalled();
		expect(deps.download).not.toHaveBeenCalled();
		expect(deps.install).not.toHaveBeenCalled();
	});

	it("preserves every update operation in local builds", async () => {
		const handlers = createUpdateIpcHandlers(deps);
		const settings = { enabled: true, channel: "latest" as const, nightlyAck: false };

		expect(await handlers.getSettings()).toEqual({ enabled: true, channel: "nightly", nightlyAck: true });
		await handlers.setSettings(settings);
		expect(handlers.getStatus()).toEqual({ state: "available", version: "1.2.3" });
		await handlers.check();
		await handlers.download();
		handlers.install();

		expect(deps.readSettings).toHaveBeenCalledWith("/state");
		expect(deps.writeSettings).toHaveBeenCalledWith("/state", settings);
		expect(deps.getStatus).toHaveBeenCalledOnce();
		expect(deps.check).toHaveBeenCalledWith("/state");
		expect(deps.download).toHaveBeenCalledOnce();
		expect(deps.install).toHaveBeenCalledOnce();
	});
});
