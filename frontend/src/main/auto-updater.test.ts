// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { showMessageBox } = vi.hoisted(() => ({
	showMessageBox: vi.fn(),
}));

vi.mock("electron", () => ({
	app: {
		getVersion: vi.fn(() => "0.10.3"),
		isPackaged: true,
	},
	BrowserWindow: {
		getAllWindows: vi.fn(() => []),
	},
	dialog: { showMessageBox },
}));

vi.mock("electron-updater", () => ({
	autoUpdater: {
		on: vi.fn(),
	},
}));

import { ensureUpdatePrefs } from "./auto-updater";
import { mainI18n } from "./i18n";
import { readUpdateSettings, writeUpdateSettings } from "./update-settings";

describe("ensureUpdatePrefs", () => {
	let stateDir: string;

	beforeEach(async () => {
		stateDir = await mkdtemp(path.join(os.tmpdir(), "ao-auto-updater-"));
		showMessageBox.mockReset();
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	it("does not prompt or overwrite existing update settings", async () => {
		const settings = { enabled: true, channel: "nightly", nightlyAck: true } as const;
		await writeUpdateSettings(stateDir, settings);

		await ensureUpdatePrefs(stateDir, mainI18n.getFixedT("zh-CN"));

		expect(showMessageBox).not.toHaveBeenCalled();
		expect(await readUpdateSettings(stateDir)).toEqual(settings);
	});

	it("localizes the opt-in prompt and preserves the opt-out settings", async () => {
		showMessageBox.mockResolvedValueOnce({ response: 1 });

		await ensureUpdatePrefs(stateDir, mainI18n.getFixedT("zh-CN"));

		expect(showMessageBox).toHaveBeenCalledWith({
			type: "question",
			buttons: ["启用自动更新", "暂不"],
			defaultId: 0,
			cancelId: 1,
			message: "自动保持 Agent Orchestrator 为最新版本？",
			detail: "你可以稍后在设置中更改此选项。",
		});
		expect(showMessageBox).toHaveBeenCalledTimes(1);
		expect(await readUpdateSettings(stateDir)).toEqual({
			enabled: false,
			channel: "latest",
			nightlyAck: false,
		});
	});

	it("localizes the channel prompt and preserves the Stable response", async () => {
		showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 0 });

		await ensureUpdatePrefs(stateDir, mainI18n.getFixedT("zh-CN"));

		expect(showMessageBox).toHaveBeenNthCalledWith(2, {
			type: "question",
			buttons: ["稳定版", "每夜构建版"],
			defaultId: 0,
			cancelId: 0,
			message: "选择哪个更新通道？",
			detail: "稳定版经过发布和测试。每夜构建版是每天生成的最新版本。",
		});
		expect(await readUpdateSettings(stateDir)).toEqual({
			enabled: true,
			channel: "latest",
			nightlyAck: false,
		});
	});

	it("localizes the warning and preserves acknowledgement of Nightly", async () => {
		showMessageBox
			.mockResolvedValueOnce({ response: 0 })
			.mockResolvedValueOnce({ response: 1 })
			.mockResolvedValueOnce({ response: 0 });

		await ensureUpdatePrefs(stateDir, mainI18n.getFixedT("zh-CN"));

		expect(showMessageBox).toHaveBeenNthCalledWith(3, {
			type: "warning",
			buttons: ["我已了解，使用每夜构建版", "改用稳定版"],
			defaultId: 1,
			cancelId: 1,
			message: "每夜构建版可能不稳定",
			detail: "每夜构建版每天生成，可能无法使用或造成数据丢失。请仅在你能够接受这些风险时使用。",
		});
		expect(await readUpdateSettings(stateDir)).toEqual({
			enabled: true,
			channel: "nightly",
			nightlyAck: true,
		});
	});

	it("preserves the Stable fallback when Nightly is not acknowledged", async () => {
		showMessageBox
			.mockResolvedValueOnce({ response: 0 })
			.mockResolvedValueOnce({ response: 1 })
			.mockResolvedValueOnce({ response: 1 });

		await ensureUpdatePrefs(stateDir, mainI18n.getFixedT("zh-CN"));

		expect(await readUpdateSettings(stateDir)).toEqual({
			enabled: true,
			channel: "latest",
			nightlyAck: false,
		});
	});
});
