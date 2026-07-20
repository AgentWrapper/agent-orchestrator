import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";

describe("KeyboardShortcutsDialog", () => {
	it("shows the application shortcut catalog with Windows/Linux keys", () => {
		render(<KeyboardShortcutsDialog open onOpenChange={vi.fn()} isMac={false} />);

		expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
		expect(screen.getByText("New session")).toBeInTheDocument();
		expect(screen.getByText("Toggle sidebar")).toBeInTheDocument();
		expect(screen.getByText("Open project 1–9")).toBeInTheDocument();
		expect(screen.getByText("Toggle inspector")).toBeInTheDocument();
		expect(screen.getByLabelText("Ctrl+/")).toBeInTheDocument();
	});

	it("uses macOS key labels when requested", () => {
		render(<KeyboardShortcutsDialog open onOpenChange={vi.fn()} isMac />);

		expect(screen.getByLabelText("⌘+/")).toBeInTheDocument();
		expect(screen.getByLabelText("⌘+Shift+B")).toBeInTheDocument();
	});
});
