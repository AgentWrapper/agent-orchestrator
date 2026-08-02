import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => {
	const listeners = new Map<string, (...args: unknown[]) => void>();
	return {
		listeners,
		on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
			listeners.set(channel, listener);
		}),
		send: vi.fn(),
	};
});

vi.mock("electron", () => ({
	ipcRenderer: {
		on: electronMocks.on,
		send: electronMocks.send,
	},
}));

async function loadAnnotatePreload() {
	vi.resetModules();
	electronMocks.listeners.clear();
	electronMocks.on.mockClear();
	electronMocks.send.mockClear();
	document.body.innerHTML = `<main><h1>Draft copy</h1></main>`;
	await import("./annotate-preload");
}

function setTextEditMode(enabled: boolean): void {
	electronMocks.listeners.get("browser:textEdit:setMode")?.({}, { enabled });
}

describe("annotate preload text edit overlay", () => {
	beforeEach(() => {
		document.body.replaceChildren();
	});

	it("uses a closed shadow root so page scripts cannot rewrite the prompt", async () => {
		await loadAnnotatePreload();

		setTextEditMode(true);

		const host = document.querySelector<HTMLElement>("[data-ao-annotation-root]");
		expect(host).toBeTruthy();
		expect(host?.shadowRoot).toBeNull();
		setTextEditMode(false);
	});

	it("ignores synthetic page events for text edit selection and cancellation", async () => {
		await loadAnnotatePreload();
		setTextEditMode(true);

		document.querySelector("h1")?.dispatchEvent(
			new MouseEvent("click", {
				bubbles: true,
				cancelable: true,
				composed: true,
			}),
		);
		document.dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				key: "Escape",
			}),
		);

		expect(electronMocks.send).not.toHaveBeenCalledWith("browser:textEdit:submit", expect.anything());
		expect(electronMocks.send).not.toHaveBeenCalledWith("browser:textEdit:cancel", expect.anything());
		setTextEditMode(false);
	});
});
