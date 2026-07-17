import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
	const listeners = new Map<string, (event: unknown, input: unknown) => void>();
	return {
		listeners,
		ipcRenderer: {
			on: vi.fn((channel: string, listener: (event: unknown, input: unknown) => void) => {
				listeners.set(channel, listener);
			}),
			send: vi.fn(),
		},
	};
});

vi.mock("electron", () => ({ ipcRenderer: electron.ipcRenderer }));

import "./annotate-preload";

describe("annotation page overlay", () => {
	beforeEach(() => {
		document.body.replaceChildren();
		electron.ipcRenderer.send.mockClear();
	});

	it("localizes the prompt and updates visible copy without losing the draft", () => {
		const setMode = electron.listeners.get("browser:annotation:setMode")!;
		const target = document.createElement("button");
		target.textContent = "Target";
		document.body.appendChild(target);

		setMode({}, { enabled: true, locale: "zh-CN" });

		const overlay = document.querySelector<HTMLDivElement>("[data-ao-annotation-root]")!;
		expect(overlay.shadowRoot?.querySelector(".hint")).toHaveTextContent("点击元素添加批注。按 Esc 取消。");

		target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
		const textarea = overlay.shadowRoot?.querySelector<HTMLTextAreaElement>("textarea")!;
		expect(textarea).toHaveAttribute("aria-label", "批注要求");
		expect(textarea).toHaveAttribute("placeholder", "描述需要修改的内容");
		expect(overlay.shadowRoot?.querySelector('[data-action="cancel"]')).toHaveTextContent("取消");
		expect(overlay.shadowRoot?.querySelector('button[type="submit"]')).toHaveTextContent("发送");
		textarea.value = "Keep this draft";

		setMode({}, { enabled: true, locale: "en" });

		expect(overlay.shadowRoot?.querySelector("textarea")).toBe(textarea);
		expect(textarea).toHaveValue("Keep this draft");
		expect(textarea).toHaveAttribute("aria-label", "Annotation request");
		expect(textarea).toHaveAttribute("placeholder", "Describe what to change");
		expect(overlay.shadowRoot?.querySelector('[data-action="cancel"]')).toHaveTextContent("Cancel");
		expect(overlay.shadowRoot?.querySelector('button[type="submit"]')).toHaveTextContent("Send");
	});
});
