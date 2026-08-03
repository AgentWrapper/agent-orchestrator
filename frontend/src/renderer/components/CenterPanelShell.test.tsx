import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Platform is read at module-load time in CenterPanelShell (top-level const),
// so we must mock before importing the component.
const mockIsMac = vi.hoisted(() => vi.fn(() => false));
vi.mock("../lib/platform", () => ({ isMacPlatform: mockIsMac }));

vi.mock("../hooks/useWindowFullScreen", () => ({ useWindowFullScreen: () => false }));
vi.mock("../stores/ui-store", () => ({
	useUiStore: (sel: (s: { isSidebarOpen: boolean }) => unknown) => sel({ isSidebarOpen: true }),
}));

// Import after mocks are set up.
const { CenterPanelShell } = await import("./CenterPanelShell");

describe("CenterPanelShell platform classes", () => {
	it("applies center-panel-shell--mac on macOS", () => {
		mockIsMac.mockReturnValue(true);
		const { container } = render(<CenterPanelShell>x</CenterPanelShell>);
		expect(container.firstElementChild!.classList.contains("center-panel-shell--mac")).toBe(true);
	});

	it("does not apply center-panel-shell--mac on Linux", () => {
		mockIsMac.mockReturnValue(false);
		const { container } = render(<CenterPanelShell>x</CenterPanelShell>);
		expect(container.firstElementChild!.classList.contains("center-panel-shell--mac")).toBe(false);
	});

	it("does not apply center-panel-shell--mac on Windows", () => {
		mockIsMac.mockReturnValue(false);
		const { container } = render(<CenterPanelShell>x</CenterPanelShell>);
		expect(container.firstElementChild!.classList.contains("center-panel-shell--mac")).toBe(false);
	});
});
