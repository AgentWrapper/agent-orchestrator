import { beforeEach, describe, expect, it, vi } from "vitest";

// developerMode initializes from localStorage at module load, so each case resets
// modules and re-imports to exercise the real initialization path.
describe("ui-store developerMode persistence", () => {
	beforeEach(() => {
		window.localStorage.clear();
		vi.resetModules();
	});

	it("defaults to off when nothing is stored", async () => {
		const { useUiStore } = await import("./ui-store");
		expect(useUiStore.getState().developerMode).toBe(false);
	});

	it("restores an enabled flag from stored ao.developerMode=true", async () => {
		window.localStorage.setItem("ao.developerMode", "true");
		const { useUiStore } = await import("./ui-store");
		expect(useUiStore.getState().developerMode).toBe(true);
	});

	it('treats any non-"true" stored value as off', async () => {
		window.localStorage.setItem("ao.developerMode", "1");
		const { useUiStore } = await import("./ui-store");
		expect(useUiStore.getState().developerMode).toBe(false);
	});

	it("setDeveloperMode writes localStorage and updates state", async () => {
		const { useUiStore } = await import("./ui-store");
		useUiStore.getState().setDeveloperMode(true);
		expect(useUiStore.getState().developerMode).toBe(true);
		expect(window.localStorage.getItem("ao.developerMode")).toBe("true");
		useUiStore.getState().setDeveloperMode(false);
		expect(useUiStore.getState().developerMode).toBe(false);
		expect(window.localStorage.getItem("ao.developerMode")).toBe("false");
	});
});
