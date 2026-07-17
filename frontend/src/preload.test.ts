import { beforeEach, describe, expect, it, vi } from "vitest";
import { NEW_SESSION_SHORTCUT_CHANNEL } from "./shared/shortcuts";
import type { AoBridge } from "./preload";

const electronMocks = vi.hoisted(() => {
	const listeners = new Map<string, (...args: unknown[]) => void>();
	return {
		exposeInMainWorld: vi.fn(),
		invoke: vi.fn(),
		listeners,
		off: vi.fn(),
		on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
			listeners.set(channel, listener);
		}),
		send: vi.fn(),
	};
});

vi.mock("electron", () => ({
	contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
	ipcRenderer: {
		invoke: electronMocks.invoke,
		off: electronMocks.off,
		on: electronMocks.on,
		send: electronMocks.send,
	},
}));

await import("./preload");

function exposedBridge(): AoBridge {
	const call = electronMocks.exposeInMainWorld.mock.calls.find(([key]) => key === "ao");
	if (!call) throw new Error("preload bridge was not exposed");
	return call[1] as AoBridge;
}

beforeEach(() => {
	electronMocks.listeners.clear();
	electronMocks.off.mockClear();
	electronMocks.on.mockClear();
});

describe("preload new-session shortcut bridge", () => {
	it("delivers the IPC event and removes the exact wrapped listener", () => {
		const listener = vi.fn();
		const dispose = exposedBridge().app.onNewSessionShortcut(listener);
		const wrapped = electronMocks.listeners.get(NEW_SESSION_SHORTCUT_CHANNEL);
		expect(wrapped).toBeTypeOf("function");

		wrapped?.({});
		expect(listener).toHaveBeenCalledTimes(1);

		dispose();
		expect(electronMocks.off).toHaveBeenCalledWith(NEW_SESSION_SHORTCUT_CHANNEL, wrapped);
	});
});
