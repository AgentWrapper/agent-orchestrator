import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { i18n, initializeRendererI18n } from "../i18n";
import { ReportProblemDialog } from "./ReportProblemDialog";

describe("ReportProblemDialog", () => {
	beforeEach(() => {
		window.ao!.app.getVersion = vi.fn(async () => "1.2.3-test");
		window.ao!.app.openExternal = vi.fn(async () => undefined);
		window.ao!.clipboard.writeText = vi.fn(async () => undefined);
		window.ao!.daemon.getStatus = vi.fn(async () => ({ state: "ready" as const }));
	});

	it("localizes its controls while preserving user text and the external draft format", async () => {
		await initializeRendererI18n("zh-CN");
		const user = userEvent.setup();
		render(<ReportProblemDialog open onOpenChange={vi.fn()} />);

		expect(screen.getByRole("dialog", { name: "报告问题" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "关闭问题报告" })).toBeInTheDocument();
		expect(screen.getByText("发送到")).toBeInTheDocument();
		await user.type(screen.getByLabelText("摘要"), "终端断开后没有恢复");
		await user.type(screen.getByLabelText("详细信息"), "保留这段用户输入 raw-detail-42");
		await user.click(screen.getByRole("button", { name: "复制并创建 GitHub 问题" }));

		await waitFor(() => expect(window.ao!.clipboard.writeText).toHaveBeenCalledOnce());
		const draft = vi.mocked(window.ao!.clipboard.writeText).mock.calls[0][0];
		expect(draft).toContain("# 终端断开后没有恢复");
		expect(draft).toContain("## Summary");
		expect(draft).toContain("保留这段用户输入 raw-detail-42");
		const destination = new URL(vi.mocked(window.ao!.app.openExternal).mock.calls[0][0]);
		expect(destination.searchParams.get("body")).toBe(draft);
		expect(await screen.findByText("GitHub 草稿已复制。")).toBeInTheDocument();

		await act(async () => i18n.changeLanguage("en"));
		expect(screen.getByText("GitHub draft copied.")).toBeInTheDocument();
	});

	it("updates an application fallback immediately when the language changes", async () => {
		window.ao!.clipboard.writeText = vi.fn(async () => Promise.reject(null));
		const user = userEvent.setup();
		render(<ReportProblemDialog open onOpenChange={vi.fn()} />);

		await user.click(screen.getByRole("button", { name: "Copy and raise GitHub issue" }));
		expect(await screen.findByText("Could not copy report draft")).toBeInTheDocument();

		await act(async () => i18n.changeLanguage("zh-CN"));
		expect(screen.getByText("无法复制问题报告草稿")).toBeInTheDocument();
		expect(screen.queryByText("Could not copy report draft")).not.toBeInTheDocument();
	});

	it("keeps raw external failure detail unchanged across language changes", async () => {
		window.ao!.clipboard.writeText = vi.fn(async () => Promise.reject(new Error("clipboard raw detail")));
		const user = userEvent.setup();
		render(<ReportProblemDialog open onOpenChange={vi.fn()} />);

		await user.click(screen.getByRole("button", { name: "Copy and raise GitHub issue" }));
		expect(await screen.findByText("clipboard raw detail")).toBeInTheDocument();

		await act(async () => i18n.changeLanguage("zh-CN"));
		expect(screen.getByText("clipboard raw detail")).toBeInTheDocument();
	});

	it("distinguishes an open failure after the draft was copied and updates its fallback language", async () => {
		window.ao!.app.openExternal = vi.fn(async () => Promise.reject(null));
		const user = userEvent.setup();
		render(<ReportProblemDialog open onOpenChange={vi.fn()} />);

		await user.click(screen.getByRole("button", { name: "Copy and raise GitHub issue" }));
		expect(await screen.findByText("Draft copied, but the destination could not be opened.")).toBeInTheDocument();
		expect(window.ao!.clipboard.writeText).toHaveBeenCalledOnce();

		await act(async () => i18n.changeLanguage("zh-CN"));
		expect(screen.getByText("草稿已复制，但无法打开目标。")).toBeInTheDocument();
	});
});
