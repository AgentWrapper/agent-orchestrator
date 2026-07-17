import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";

const { patchMock } = vi.hoisted(() => ({ patchMock: vi.fn() }));

vi.mock("./api-client", () => ({
	apiClient: { PATCH: (...args: unknown[]) => patchMock(...args) },
	apiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

import { renameSession } from "./rename-session";

describe("renameSession", () => {
	beforeEach(() => patchMock.mockReset());

	it("uses a localized safe fallback and preserves the rename request", async () => {
		await i18n.changeLanguage("zh-CN");
		patchMock.mockResolvedValue({ error: {}, response: { status: 500 } });

		await expect(renameSession("会话-1", "新的显示名称")).rejects.toThrow("无法重命名会话（500）");
		expect(patchMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}", {
			params: { path: { sessionId: "会话-1" } },
			body: { displayName: "新的显示名称" },
		});
	});
});
