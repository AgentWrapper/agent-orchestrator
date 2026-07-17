import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeRendererI18n } from "../i18n";

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return { ...actual, useNavigate: () => navigateMock };
});

beforeAll(() => {
	Object.defineProperty(window.navigator, "platform", { configurable: true, value: "Win32" });
});

afterEach(async () => {
	cleanup();
	await initializeRendererI18n("en");
	vi.clearAllMocks();
});

describe("WindowTitlebar", () => {
	it("shows the Remote product identity in the Windows title bar", async () => {
		vi.spyOn(window.ao!.remoteServer, "isRemoteClient").mockResolvedValueOnce(true);
		const { WindowTitlebar } = await import("./WindowTitlebar");
		render(<WindowTitlebar />);

		expect(await screen.findByText("Agent Orchestrator Remote")).toBeInTheDocument();
		expect(document.title).toBe("Agent Orchestrator Remote");
	});

	it("localizes Windows menus without changing action ids", async () => {
		const menuActionSpy = vi.spyOn(window.ao!.menu!, "action").mockResolvedValue(undefined);
		await initializeRendererI18n("zh-CN");
		const { WindowTitlebar } = await import("./WindowTitlebar");
		render(<WindowTitlebar />);

		expect(screen.getByRole("button", { name: "文件" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "编辑" }));
		await userEvent.click(await screen.findByRole("menuitem", { name: /撤销/ }));

		expect(menuActionSpy).toHaveBeenCalledWith("edit.undo");
	});
});
