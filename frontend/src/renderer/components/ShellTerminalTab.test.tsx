import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellTerminal } from "../hooks/useShellTerminals";
import { ShellTerminalTab } from "./ShellTerminalTab";

const { isWindowsPlatform } = vi.hoisted(() => ({ isWindowsPlatform: vi.fn(() => false) }));
vi.mock("../lib/platform", () => ({ isWindowsPlatform }));

afterEach(() => isWindowsPlatform.mockReturnValue(false));

const shell: ShellTerminal = {
	handleId: "shellterm-1",
	projectId: "ao",
	workingDir: "/repos/ao",
	title: "ao",
	createdAt: "2026-07-24T10:00:00Z",
};

function renderTab(overrides: Partial<Parameters<typeof ShellTerminalTab>[0]> = {}) {
	const onSelect = vi.fn();
	const onClose = vi.fn();
	const onRename = vi.fn();
	render(
		<ShellTerminalTab
			isActive={false}
			onClose={onClose}
			onRename={onRename}
			onSelect={onSelect}
			shell={shell}
			{...overrides}
		/>,
	);
	return { onSelect, onClose, onRename };
}

describe("ShellTerminalTab rename", () => {
	it("commits a new title on Enter", () => {
		const { onRename } = renderTab();
		fireEvent.doubleClick(screen.getByRole("tab", { name: "ao" }));
		const input = screen.getByRole("textbox", { name: /rename terminal/i });
		fireEvent.change(input, { target: { value: "deploy" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onRename).toHaveBeenCalledWith("deploy");
	});

	it("commits on blur", () => {
		const { onRename } = renderTab();
		fireEvent.doubleClick(screen.getByRole("tab", { name: "ao" }));
		const input = screen.getByRole("textbox", { name: /rename terminal/i });
		fireEvent.change(input, { target: { value: "logs" } });
		fireEvent.blur(input);
		expect(onRename).toHaveBeenCalledWith("logs");
	});

	it("discards on Escape and leaves the title unchanged", () => {
		const { onRename } = renderTab();
		fireEvent.doubleClick(screen.getByRole("tab", { name: "ao" }));
		const input = screen.getByRole("textbox", { name: /rename terminal/i });
		fireEvent.change(input, { target: { value: "throwaway" } });
		fireEvent.keyDown(input, { key: "Escape" });
		expect(onRename).not.toHaveBeenCalled();
		expect(screen.getByRole("tab", { name: "ao" })).toBeInTheDocument();
	});

	it("discards an empty or unchanged title", () => {
		const { onRename } = renderTab();
		fireEvent.doubleClick(screen.getByRole("tab", { name: "ao" }));
		const input = screen.getByRole("textbox", { name: /rename terminal/i });
		fireEvent.change(input, { target: { value: "   " } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onRename).not.toHaveBeenCalled();
	});

	it("does not enter edit mode when rename is not wired", () => {
		renderTab({ onRename: undefined });
		fireEvent.doubleClick(screen.getByRole("tab", { name: "ao" }));
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	});

	it("selects the tab on single click", () => {
		const { onSelect } = renderTab();
		fireEvent.click(screen.getByRole("tab", { name: "ao" }));
		expect(onSelect).toHaveBeenCalled();
	});

	it("selects from the full connected tab, not only its title", () => {
		const { onSelect } = renderTab({ appearance: "connected" });
		fireEvent.click(screen.getByRole("tab", { name: "ao" }).parentElement as HTMLElement);
		expect(onSelect).toHaveBeenCalledOnce();
	});

	it("overlays the close affordance without changing an active tab's width", () => {
		renderTab({ appearance: "connected", isActive: true });
		const close = screen.getByRole("button", { name: "Close terminal ao" });
		expect(close).toHaveClass("size-control-xs", "session-pane-tab__action-button");
		expect(close.closest(".session-pane-tab__actions")).toHaveClass(
			"absolute",
			"opacity-0",
			"group-hover:opacity-100",
		);
		expect(screen.getByRole("tab", { name: "ao" })).toHaveAttribute("aria-selected", "true");
	});

	it("uses the same compact frame as a pinned session tab", () => {
		renderTab({ appearance: "connected", isActive: false });

		const close = screen.getByRole("button", { name: "Close terminal ao" });
		expect(close.closest(".session-pane-tab__actions")).toHaveClass(
			"opacity-0",
			"group-hover:opacity-100",
			"group-hover:translate-x-0",
		);
		expect(close).not.toHaveClass("w-0", "group-hover:w-control-sm");
		expect(close.closest(".session-pane-tab__actions")).toHaveClass("absolute");
		expect(screen.getByRole("tab", { name: "ao" })).toHaveClass(
			"w-full",
			"min-w-0",
			"text-left",
			"session-pane-tab__label",
		);
		expect(screen.getByRole("tab", { name: "ao" }).parentElement).toHaveClass(
			"flex",
			"session-pane-tab",
		);
	});

	it("uses a shorter rectangular active surface with a subtle selection underline", () => {
		renderTab({ appearance: "connected", isActive: true });

		expect(screen.getByRole("tab", { name: "ao" }).parentElement).toHaveClass(
			"h-control-md",
			"self-end",
			"bg-interactive-active",
			"after:h-px",
			"after:bg-foreground/65",
		);
		expect(screen.getByRole("tab", { name: "ao" }).parentElement).not.toHaveClass("rounded-md", "self-stretch");
		expect(screen.getByRole("tab", { name: "ao" }).parentElement).not.toHaveClass("before:bg-accent");
		expect(screen.getByRole("tab", { name: "ao" }).parentElement).not.toHaveClass("after:h-0.5");
	});

	it("optically centers the auxiliary terminal glyph with its label", () => {
		renderTab({ appearance: "connected" });

		expect(screen.getByRole("tab", { name: "ao" }).parentElement?.querySelector("svg")).toHaveClass(
			"size-icon-xs",
			"translate-y-px",
		);
	});
});

describe("ShellTerminalTab rename gesture per platform", () => {
	it("macOS/Linux: double-click enters edit, right-click does not", () => {
		renderTab(); // isWindowsPlatform() defaults to false
		const tab = screen.getByRole("tab", { name: "ao" });
		fireEvent.contextMenu(tab);
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		fireEvent.doubleClick(tab);
		expect(screen.getByRole("textbox", { name: /rename terminal/i })).toBeInTheDocument();
	});

	it("macOS/Linux: two quick clicks enter edit even without a native dblclick (trackpad)", () => {
		renderTab();
		const tab = screen.getByRole("tab", { name: "ao" });
		// Two plain clicks, no dblclick event — mimics a trackpad double-tap that
		// the OS delivers as separate clicks.
		fireEvent.click(tab, { detail: 1 });
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		fireEvent.click(tab, { detail: 1 });
		expect(screen.getByRole("textbox", { name: /rename terminal/i })).toBeInTheDocument();
	});

	it("Windows: right-click enters edit, double-click does not", () => {
		isWindowsPlatform.mockReturnValue(true);
		renderTab();
		const tab = screen.getByRole("tab", { name: "ao" });
		fireEvent.doubleClick(tab);
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		fireEvent.contextMenu(tab);
		expect(screen.getByRole("textbox", { name: /rename terminal/i })).toBeInTheDocument();
	});
});
