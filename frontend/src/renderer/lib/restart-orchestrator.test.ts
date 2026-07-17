import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { i18n } from "../i18n";

const { spawnMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
}));

vi.mock("./spawn-orchestrator", async (importOriginal) => ({
	...(await importOriginal<typeof import("./spawn-orchestrator")>()),
	spawnOrchestrator: spawnMock,
}));

import { restartProjectOrchestrator } from "./restart-orchestrator";

describe("restartProjectOrchestrator", () => {
	beforeEach(() => {
		spawnMock.mockReset();
	});

	it("invalidates workspace state and records an error when clean restart fails", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
		const navigate = vi.fn();
		const setProjectRestarting = vi.fn();
		const setOrchestratorReplacementError = vi.fn();
		const onError = vi.fn();
		const failure = new Error("missing goose binary");
		spawnMock.mockRejectedValue(failure);

		await restartProjectOrchestrator({
			projectId: "proj-1",
			queryClient,
			navigate,
			setProjectRestarting,
			setOrchestratorReplacementError,
			onError,
		});

		expect(spawnMock).toHaveBeenCalledWith("proj-1", "restart", true);
		expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: workspaceQueryKey });
		expect(setOrchestratorReplacementError).toHaveBeenNthCalledWith(1, "proj-1", null);
		expect(setOrchestratorReplacementError).toHaveBeenNthCalledWith(2, "proj-1", {
			kind: "detail",
			detail: "missing goose binary",
		});
		expect(setProjectRestarting).toHaveBeenNthCalledWith(1, "proj-1", true);
		expect(setProjectRestarting).toHaveBeenLastCalledWith("proj-1", false);
		expect(onError).toHaveBeenCalledWith(failure);
		expect(navigate).not.toHaveBeenCalled();
	});

	it("still records the replacement error when workspace invalidation fails", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		vi.spyOn(queryClient, "invalidateQueries").mockRejectedValue(new Error("refetch failed"));
		const navigate = vi.fn();
		const setProjectRestarting = vi.fn();
		const setOrchestratorReplacementError = vi.fn();
		const onError = vi.fn();
		const failure = new Error("missing goose binary");
		spawnMock.mockRejectedValue(failure);

		await restartProjectOrchestrator({
			projectId: "proj-1",
			queryClient,
			navigate,
			setProjectRestarting,
			setOrchestratorReplacementError,
			onError,
		});

		expect(setOrchestratorReplacementError).toHaveBeenLastCalledWith("proj-1", {
			kind: "detail",
			detail: "missing goose binary",
		});
		expect(setProjectRestarting).toHaveBeenLastCalledWith("proj-1", false);
		expect(onError).toHaveBeenCalledWith(failure);
		expect(navigate).not.toHaveBeenCalled();
	});

	it("uses a localized safe fallback for an unknown restart failure", async () => {
		await i18n.changeLanguage("zh-CN");
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
		const setOrchestratorReplacementError = vi.fn();
		spawnMock.mockRejectedValue({ diagnostic: "Bearer secret" });

		await restartProjectOrchestrator({
			projectId: "proj-1",
			queryClient,
			navigate: vi.fn(),
			setProjectRestarting: vi.fn(),
			setOrchestratorReplacementError,
		});

		expect(setOrchestratorReplacementError).toHaveBeenLastCalledWith("proj-1", { kind: "fallback" });
		expect(setOrchestratorReplacementError.mock.calls.flat().join(" ")).not.toContain("secret");
	});
});
