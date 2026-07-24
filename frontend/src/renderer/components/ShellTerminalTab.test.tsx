import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ShellTerminal } from "../hooks/useShellTerminals";
import { ShellTerminalTab } from "./ShellTerminalTab";

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
		fireEvent.doubleClick(screen.getByRole("button", { name: "ao" }));
		const input = screen.getByRole("textbox", { name: /rename terminal/i });
		fireEvent.change(input, { target: { value: "deploy" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onRename).toHaveBeenCalledWith("deploy");
	});

	it("commits on blur", () => {
		const { onRename } = renderTab();
		fireEvent.doubleClick(screen.getByRole("button", { name: "ao" }));
		const input = screen.getByRole("textbox", { name: /rename terminal/i });
		fireEvent.change(input, { target: { value: "logs" } });
		fireEvent.blur(input);
		expect(onRename).toHaveBeenCalledWith("logs");
	});

	it("discards on Escape and leaves the title unchanged", () => {
		const { onRename } = renderTab();
		fireEvent.doubleClick(screen.getByRole("button", { name: "ao" }));
		const input = screen.getByRole("textbox", { name: /rename terminal/i });
		fireEvent.change(input, { target: { value: "throwaway" } });
		fireEvent.keyDown(input, { key: "Escape" });
		expect(onRename).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "ao" })).toBeInTheDocument();
	});

	it("discards an empty or unchanged title", () => {
		const { onRename } = renderTab();
		fireEvent.doubleClick(screen.getByRole("button", { name: "ao" }));
		const input = screen.getByRole("textbox", { name: /rename terminal/i });
		fireEvent.change(input, { target: { value: "   " } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(onRename).not.toHaveBeenCalled();
	});

	it("does not enter edit mode when rename is not wired", () => {
		renderTab({ onRename: undefined });
		fireEvent.doubleClick(screen.getByRole("button", { name: "ao" }));
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	});

	it("selects the tab on single click", () => {
		const { onSelect } = renderTab();
		fireEvent.click(screen.getByRole("button", { name: "ao" }));
		expect(onSelect).toHaveBeenCalled();
	});
});
