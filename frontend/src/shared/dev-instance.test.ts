// @vitest-environment node
import { describe, expect, it } from "vitest";
import { devDaemonPort, devStateSubdir, normalizeDevInstance } from "./dev-instance";

describe("normalizeDevInstance", () => {
	it("normalizes a safe worktree id", () => {
		expect(normalizeDevInstance(" WT-AbC123 ")).toBe("wt-abc123");
	});

	it.each([undefined, "", "../escape", "spaces are unsafe", "a".repeat(65)])(
		"rejects an unsafe worktree id",
		(value) => {
			expect(normalizeDevInstance(value)).toBeNull();
		},
	);
});

describe("dev worktree isolation", () => {
	it("keeps the legacy defaults when no instance is set", () => {
		expect(devStateSubdir(undefined)).toBe("dev");
		expect(devDaemonPort(undefined)).toBe(3002);
	});

	it("gives each worktree stable, separate state and ports", () => {
		expect(devStateSubdir("wt-one")).toBe("dev/worktrees/wt-one");
		expect(devStateSubdir("wt-two")).toBe("dev/worktrees/wt-two");
		expect(devDaemonPort("wt-one")).toBe(devDaemonPort("wt-one"));
		expect(devDaemonPort("wt-one")).not.toBe(devDaemonPort("wt-two"));
	});
});
