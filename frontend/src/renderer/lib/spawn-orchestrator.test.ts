import { describe, expect, it, vi, beforeEach } from "vitest";
import { spawnOrchestrator } from "./spawn-orchestrator";
import { apiClient } from "./api-client";

vi.mock("./api-client", () => ({
	apiClient: { POST: vi.fn() },
	apiErrorMessage: (error: unknown, fallback = "Request failed") => {
		if (typeof error === "object" && error !== null && "message" in error) {
			const body = error as { code?: unknown; message: unknown };
			const message = String(body.message);
			return typeof body.code === "string" && body.code !== "" ? `${message} (${body.code})` : message;
		}
		return fallback;
	},
}));

describe("spawnOrchestrator", () => {
	beforeEach(() => vi.clearAllMocks());

	it("sends clean:true through to the request body when asked", async () => {
		(apiClient.POST as ReturnType<typeof vi.fn>).mockResolvedValue({
			data: { orchestrator: { id: "proj-9" } },
			error: undefined,
			response: { status: 201 },
		});
		const id = await spawnOrchestrator("proj", true);
		expect(id).toBe("proj-9");
		expect(apiClient.POST).toHaveBeenCalledWith("/api/v1/orchestrators", {
			body: { projectId: "proj", clean: true },
		});
	});

	it("defaults clean to false / omitted for the existing call sites", async () => {
		(apiClient.POST as ReturnType<typeof vi.fn>).mockResolvedValue({
			data: { orchestrator: { id: "proj-1" } },
			error: undefined,
			response: { status: 201 },
		});
		await spawnOrchestrator("proj");
		expect(apiClient.POST).toHaveBeenCalledWith("/api/v1/orchestrators", {
			body: { projectId: "proj", clean: false },
		});
	});

	it("surfaces daemon spawn error messages and codes", async () => {
		(apiClient.POST as ReturnType<typeof vi.fn>).mockResolvedValue({
			data: undefined,
			error: { code: "AGENT_BINARY_NOT_FOUND", message: "agent binary not found on PATH" },
			response: { status: 400 },
		});

		await expect(spawnOrchestrator("proj")).rejects.toThrow("agent binary not found on PATH (AGENT_BINARY_NOT_FOUND)");
	});
});
