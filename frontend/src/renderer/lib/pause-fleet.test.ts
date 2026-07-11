import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./api-client";
import { getFleetPaused, pauseFleet, pauseProject, resumeFleet, resumeProject } from "./pause-fleet";

vi.mock("./api-client", () => ({
	apiClient: { GET: vi.fn(), POST: vi.fn() },
	apiErrorMessage: (error: unknown, fallback = "Request failed") => {
		if (typeof error === "object" && error !== null && "message" in error) {
			return String((error as { message: unknown }).message);
		}
		return fallback;
	},
}));

const post = apiClient.POST as ReturnType<typeof vi.fn>;
const get = apiClient.GET as ReturnType<typeof vi.fn>;

describe("pause-fleet", () => {
	beforeEach(() => vi.clearAllMocks());

	it("pauseProject posts to the project pause route (soft by default)", async () => {
		post.mockResolvedValue({
			data: { project: { id: "mer", paused: true } },
			error: undefined,
			response: { status: 200 },
		});
		await pauseProject("mer");
		expect(post).toHaveBeenCalledWith("/api/v1/projects/{id}/pause", {
			params: { path: { id: "mer" }, query: { hard: false } },
		});
	});

	it("pauseProject forwards --hard", async () => {
		post.mockResolvedValue({ data: {}, error: undefined, response: { status: 200 } });
		await pauseProject("mer", true);
		expect(post).toHaveBeenCalledWith("/api/v1/projects/{id}/pause", {
			params: { path: { id: "mer" }, query: { hard: true } },
		});
	});

	it("resumeProject posts to the resume route", async () => {
		post.mockResolvedValue({ data: {}, error: undefined, response: { status: 200 } });
		await resumeProject("mer");
		expect(post).toHaveBeenCalledWith("/api/v1/projects/{id}/resume", { params: { path: { id: "mer" } } });
	});

	it("getFleetPaused returns the flag", async () => {
		get.mockResolvedValue({ data: { paused: true }, error: undefined, response: { status: 200 } });
		await expect(getFleetPaused()).resolves.toBe(true);
		expect(get).toHaveBeenCalledWith("/api/v1/fleet");
	});

	it("pauseFleet posts and returns the new flag", async () => {
		post.mockResolvedValue({ data: { paused: true }, error: undefined, response: { status: 200 } });
		await expect(pauseFleet()).resolves.toBe(true);
		expect(post).toHaveBeenCalledWith("/api/v1/fleet/pause", { params: { query: { hard: false } } });
	});

	it("resumeFleet posts and returns the new flag", async () => {
		post.mockResolvedValue({ data: { paused: false }, error: undefined, response: { status: 200 } });
		await expect(resumeFleet()).resolves.toBe(false);
		expect(post).toHaveBeenCalledWith("/api/v1/fleet/resume", {});
	});

	it("throws with the server message on error", async () => {
		post.mockResolvedValue({ data: undefined, error: { message: "boom" }, response: { status: 500 } });
		await expect(pauseFleet()).rejects.toThrow("boom");
	});
});
