import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "./ui-store";

describe("ui-store detectedUrlsBySession", () => {
	beforeEach(() => {
		useUiStore.setState({ detectedUrlsBySession: {} });
	});

	it("retains a URL detected for a session", () => {
		useUiStore.getState().addDetectedUrl("sess-1", "http://localhost:5173/");
		expect(useUiStore.getState().detectedUrlsBySession["sess-1"]).toEqual(["http://localhost:5173/"]);
	});

	it("keeps sessions' URL lists independent", () => {
		useUiStore.getState().addDetectedUrl("sess-1", "http://localhost:5173/");
		useUiStore.getState().addDetectedUrl("sess-2", "http://localhost:4173/");
		expect(useUiStore.getState().detectedUrlsBySession["sess-1"]).toEqual(["http://localhost:5173/"]);
		expect(useUiStore.getState().detectedUrlsBySession["sess-2"]).toEqual(["http://localhost:4173/"]);
	});

	it("orders the most recently detected URL first", () => {
		useUiStore.getState().addDetectedUrl("sess-1", "http://localhost:3000/");
		useUiStore.getState().addDetectedUrl("sess-1", "http://localhost:4000/");
		expect(useUiStore.getState().detectedUrlsBySession["sess-1"]).toEqual([
			"http://localhost:4000/",
			"http://localhost:3000/",
		]);
	});

	it("moves a repeated URL back to the front instead of duplicating it", () => {
		useUiStore.getState().addDetectedUrl("sess-1", "http://localhost:3000/");
		useUiStore.getState().addDetectedUrl("sess-1", "http://localhost:4000/");
		useUiStore.getState().addDetectedUrl("sess-1", "http://localhost:3000/");
		expect(useUiStore.getState().detectedUrlsBySession["sess-1"]).toEqual([
			"http://localhost:3000/",
			"http://localhost:4000/",
		]);
	});

	it("caps the retained list at 20 URLs per session, dropping the oldest", () => {
		for (let i = 0; i < 25; i++) {
			useUiStore.getState().addDetectedUrl("sess-1", `http://localhost:3000/${i}`);
		}
		const urls = useUiStore.getState().detectedUrlsBySession["sess-1"];
		expect(urls).toHaveLength(20);
		expect(urls[0]).toBe("http://localhost:3000/24");
		expect(urls.at(-1)).toBe("http://localhost:3000/5");
	});
});

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
