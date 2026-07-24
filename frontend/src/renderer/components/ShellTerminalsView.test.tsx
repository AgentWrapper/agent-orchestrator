import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShellTerminalsView } from "./ShellTerminalsView";

vi.mock("../hooks/useShellTerminals", () => ({
	useCloseShellTerminal: () => ({ mutate: vi.fn() }),
	useShellTerminals: () => ({ data: [] }),
}));

vi.mock("../lib/shell-context", () => ({
	useShell: () => ({ daemonStatus: { state: "ready" } }),
}));

vi.mock("./TerminalPane", () => ({ TerminalPane: () => <div>terminal body</div> }));

describe("ShellTerminalsView", () => {
	it("points the empty state at the visible plus tab-strip control", () => {
		render(<ShellTerminalsView />);

		expect(screen.getByText("No terminals open")).toBeInTheDocument();
		expect(screen.getByText(/use the \+ button/i)).toBeInTheDocument();
		expect(screen.queryByText(/terminal button/i)).not.toBeInTheDocument();
	});
});
