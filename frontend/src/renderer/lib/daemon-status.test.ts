import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiBaseUrl } from "./api-client";
import { readDaemonStatus } from "./daemon-status";

vi.mock("./runtime-environment", () => ({
	hasElectronBridge: () => false,
}));

const originalFetch = globalThis.fetch;

beforeEach(() => {
	setApiBaseUrl("");
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("browser daemon status", () => {
	it("reports ready only when the same-origin health probe matches the AO daemon contract", async () => {
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({
				status: "ok",
				service: "agent-orchestrator-daemon",
				pid: 4242,
				executablePath: "/home/orchestrator/.local/bin/ao",
				workingDirectory: "/home/orchestrator/agent-orchestrator",
			}),
		})) as unknown as typeof fetch;

		await expect(readDaemonStatus()).resolves.toEqual({
			state: "ready",
			pid: 4242,
			executablePath: "/home/orchestrator/.local/bin/ao",
			workingDirectory: "/home/orchestrator/agent-orchestrator",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith("/healthz", { cache: "no-store" });
	});

	it("rejects HTTP-ready health responses from non-AO services", async () => {
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ status: "ok", service: "other-service", pid: 4242 }),
		})) as unknown as typeof fetch;

		await expect(readDaemonStatus()).resolves.toEqual({
			state: "error",
			code: "identity_mismatch",
			message: "AO daemon health check returned an invalid payload.",
		});
	});
});
