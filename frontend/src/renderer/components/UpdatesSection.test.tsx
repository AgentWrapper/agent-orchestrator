import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../main/update-settings";
import { i18n, initializeRendererI18n } from "../i18n";
import { UpdatesSection } from "./UpdatesSection";

const { getSettings, setSettings, getStatus, check, download, install, onStatus, getVersion } = vi.hoisted(() => ({
	getSettings: vi.fn(),
	setSettings: vi.fn(),
	getStatus: vi.fn(),
	check: vi.fn(),
	download: vi.fn(),
	install: vi.fn(),
	onStatus: vi.fn(),
	getVersion: vi.fn(),
}));

vi.mock("../lib/bridge", () => ({
	aoBridge: {
		app: { getVersion },
		updateSettings: { get: getSettings, set: setSettings },
		updates: { getStatus, check, download, install, onStatus },
	},
}));

function renderSection() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<UpdatesSection />
		</QueryClientProvider>,
	);
}

beforeEach(async () => {
	await initializeRendererI18n("en");
	for (const mock of [getSettings, setSettings, getStatus, check, download, install, onStatus, getVersion]) {
		mock.mockReset();
	}
	getSettings.mockResolvedValue({ enabled: true, channel: "latest", nightlyAck: false });
	setSettings.mockResolvedValue(undefined);
	getStatus.mockResolvedValue({ state: "idle" });
	check.mockResolvedValue(undefined);
	download.mockResolvedValue(undefined);
	install.mockResolvedValue(undefined);
	onStatus.mockReturnValue(() => undefined);
	getVersion.mockResolvedValue("1.4.0-internal");
});

describe("UpdatesSection", () => {
	it("localizes controls and channel labels while preserving the raw version", async () => {
		renderSection();

		expect(await screen.findByText("Updates")).toBeInTheDocument();
		expect(screen.getByText("Automatic updates")).toBeInTheDocument();
		expect(screen.getByText("Update channel")).toBeInTheDocument();
		expect(await screen.findByText("v1.4.0-internal")).toBeInTheDocument();

		await act(async () => i18n.changeLanguage("zh-CN"));

		expect(screen.getByText("更新")).toBeInTheDocument();
		expect(screen.getByText("自动更新")).toBeInTheDocument();
		expect(screen.getByText("更新通道")).toBeInTheDocument();
		expect(screen.getByText("稳定版（最新发布）")).toBeInTheDocument();
		expect(screen.getByText("v1.4.0-internal")).toBeInTheDocument();
	});

	it("renders every update state in the current language without changing machine values", async () => {
		let emit: (status: UpdateStatus) => void = () => undefined;
		onStatus.mockImplementation((listener: (status: UpdateStatus) => void) => {
			emit = listener;
			return () => undefined;
		});
		renderSection();
		await screen.findByText("Updates");

		act(() => emit({ state: "checking" }));
		expect(await screen.findByText("Checking for updates…")).toBeInTheDocument();
		await act(async () => i18n.changeLanguage("zh-CN"));
		expect(screen.getByText("正在检查更新…")).toBeInTheDocument();

		act(() => emit({ state: "available", version: "9.8.7-rc.1" }));
		expect(await screen.findByText("发现可用更新（v9.8.7-rc.1）。")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "更新到 v9.8.7-rc.1" }));
		expect(download).toHaveBeenCalledOnce();

		act(() => emit({ state: "downloading", percent: 37.5 }));
		expect(await screen.findByText("正在下载… 37.5%")).toBeInTheDocument();

		act(() => emit({ state: "downloaded", version: "9.8.7-rc.1" }));
		expect(await screen.findByText("已下载。重启以完成更新。")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "重启并安装" }));
		expect(install).toHaveBeenCalledOnce();

		act(() => emit({ state: "not-available" }));
		expect(await screen.findByText("你使用的已是最新版本。")).toBeInTheDocument();

		act(() => emit({ state: "unsupported", message: "Updates are only available in the installed app." }));
		expect(await screen.findByText("更新功能需要使用已安装的应用。")).toBeInTheDocument();
		expect(screen.queryByText("Updates are only available in the installed app.")).not.toBeInTheDocument();

		act(() => emit({ state: "error" }));
		expect(await screen.findByText("更新失败。")).toBeInTheDocument();

		act(() => emit({ state: "error", message: "HTTP 503 from updates.internal" }));
		expect(await screen.findByText("HTTP 503 from updates.internal")).toBeInTheDocument();
	});

	it("relocalizes the save fallback but keeps a raw save error unchanged", async () => {
		setSettings.mockRejectedValueOnce(null);
		renderSection();
		await userEvent.click(await screen.findByRole("button", { name: "Save changes" }));
		expect(await screen.findByText("Save failed")).toBeInTheDocument();

		await act(async () => i18n.changeLanguage("zh-CN"));
		expect(screen.getByText("保存失败")).toBeInTheDocument();

		setSettings.mockRejectedValueOnce(new Error("read-only filesystem"));
		await userEvent.click(screen.getByRole("button", { name: "保存更改" }));
		expect(await screen.findByText("read-only filesystem")).toBeInTheDocument();
	});

	it("saves the selected machine channel after translating its display label", async () => {
		getSettings.mockResolvedValue({ enabled: true, channel: "nightly", nightlyAck: true });
		await initializeRendererI18n("zh-CN");
		renderSection();

		expect(await screen.findByText("每日构建（预发布）")).toBeInTheDocument();
		expect(screen.getByText(/每日构建每天生成/)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "保存更改" }));
		await waitFor(() =>
			expect(setSettings).toHaveBeenCalledWith({ enabled: true, channel: "nightly", nightlyAck: true }),
		);
	});
});
