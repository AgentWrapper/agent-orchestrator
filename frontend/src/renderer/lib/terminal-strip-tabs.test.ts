import { describe, expect, it } from "vitest";
import {
	adjacentShellStripTab,
	buildTerminalStripTabs,
	previousShellStripTab,
	previousTerminalStripTab,
} from "./terminal-strip-tabs";

describe("terminal strip tab navigation", () => {
	const tabs = buildTerminalStripTabs(["owner", "pinned"], ["sh-1", "sh-2"]);

	it("returns the session tab to the left of a pinned session", () => {
		expect(previousTerminalStripTab(tabs, { kind: "session", sessionId: "pinned" })).toEqual({
			kind: "session",
			sessionId: "owner",
		});
	});

	it("returns the last session tab to the left of the first shell", () => {
		expect(previousTerminalStripTab(tabs, { kind: "shell", handleId: "sh-1" })).toEqual({
			kind: "session",
			sessionId: "pinned",
		});
	});

	it("returns the shell tab to the left of a later shell", () => {
		expect(previousTerminalStripTab(tabs, { kind: "shell", handleId: "sh-2" })).toEqual({
			kind: "shell",
			handleId: "sh-1",
		});
	});

	it("returns undefined when there is no tab to the left", () => {
		expect(previousTerminalStripTab(tabs, { kind: "session", sessionId: "owner" })).toBeUndefined();
		expect(previousShellStripTab(["only"], "only")).toBeUndefined();
	});

	it("falls back to the next shell when closing the leftmost shell tab", () => {
		expect(adjacentShellStripTab(["sh-1", "sh-2", "sh-3"], "sh-1")).toBe("sh-2");
		expect(adjacentShellStripTab(["sh-1", "sh-2", "sh-3"], "sh-3")).toBe("sh-2");
		expect(adjacentShellStripTab(["only"], "only")).toBeUndefined();
	});
});
