import { describe, expect, it } from "vitest";
import {
	defaultStateDir,
	isOutsideInstallDir,
	resolveDataDir,
	resolveElectronUserDataPath,
} from "./durable-state";

describe("durable state reinstall contract", () => {
	it("keeps state and data dirs under ~/.ao, not the install directory", () => {
		const home = "C:/Users/alice";
		const install = "D:/e/agent-orchestrator";

		const state = defaultStateDir(home);
		const data = resolveDataDir(home);
		const userData = resolveElectronUserDataPath(home, true);

		expect(state).toBe("C:/Users/alice/.ao");
		expect(data).toBe("C:/Users/alice/.ao/data");
		expect(userData).toBe("C:/Users/alice/.ao/electron");

		expect(isOutsideInstallDir(data, install)).toBe(true);
		expect(isOutsideInstallDir(userData, install)).toBe(true);
		// A wrongly colocated data dir would fail this contract.
		expect(isOutsideInstallDir(`${install}/data`, install)).toBe(false);
	});

	it("reopen after reinstall still resolves the same data dir for the same home", () => {
		const home = "/Users/bob";
		// Simulate two launches: before uninstall and after a fresh install path.
		const before = resolveDataDir(home, {});
		const after = resolveDataDir(home, {});
		expect(after).toBe(before);
		expect(after).toBe("/Users/bob/.ao/data");
	});

	it("honors AO_DATA_DIR without depending on install location", () => {
		const home = "/home/me";
		const custom = "/var/ao-data";
		expect(resolveDataDir(home, { AO_DATA_DIR: custom })).toBe(custom);
		expect(isOutsideInstallDir(custom, "/opt/Agent Orchestrator")).toBe(true);
	});

	it("isolates dev electron profile under ~/.ao/dev", () => {
		expect(resolveElectronUserDataPath("/Users/dev", false)).toBe("/Users/dev/.ao/dev/electron");
	});
});
