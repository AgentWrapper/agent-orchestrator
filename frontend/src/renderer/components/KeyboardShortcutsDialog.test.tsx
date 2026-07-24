import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";

const ctx = vi.hoisted(() => ({ commandPaletteEnabled: true }));

vi.mock("../hooks/useCommandPaletteEnabled", () => ({
	useCommandPaletteEnabled: () => ctx.commandPaletteEnabled,
}));

describe("KeyboardShortcutsDialog", () => {
	beforeEach(() => {
		ctx.commandPaletteEnabled = true;
	});

	it("shows the application shortcut catalog with Windows/Linux keys", () => {
		render(<KeyboardShortcutsDialog open onOpenChange={vi.fn()} isMac={false} />);

		expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
		expect(screen.getByText("New session")).toBeInTheDocument();
		expect(screen.getByText("Toggle sidebar")).toBeInTheDocument();
		expect(screen.getByText("Open project 1–9")).toBeInTheDocument();
		expect(screen.getByText("Toggle inspector")).toBeInTheDocument();
		expect(screen.getByText("Open command palette")).toBeInTheDocument();
		expect(screen.getByLabelText("Ctrl+/")).toBeInTheDocument();
		expect(screen.getByLabelText("Ctrl+PageUp")).toBeInTheDocument();
		expect(screen.getByLabelText("Ctrl+PageDown")).toBeInTheDocument();
	});

	it("uses macOS key labels when requested", () => {
		render(<KeyboardShortcutsDialog open onOpenChange={vi.fn()} isMac />);

		expect(screen.getByLabelText("⌘+/")).toBeInTheDocument();
		expect(screen.getByLabelText("⌘+Shift+B")).toBeInTheDocument();
	});

	it("hides the command palette shortcut when the feature is disabled", () => {
		ctx.commandPaletteEnabled = false;
		render(<KeyboardShortcutsDialog open onOpenChange={vi.fn()} isMac={false} />);

		expect(screen.queryByText("Open command palette")).not.toBeInTheDocument();
	});
});
