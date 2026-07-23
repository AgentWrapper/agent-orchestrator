// @vitest-environment node
import {
	DaytonaAuthenticationError,
	DaytonaConnectionError,
} from "@daytona/sdk";
import { describe, expect, it, vi } from "vitest";
import { DaytonaSupervisor, type DaytonaClient } from "./daytona-supervisor";

function iteratorThat(result: IteratorResult<unknown> = { done: true, value: undefined }): AsyncIterableIterator<unknown> {
	return {
		next: vi.fn().mockResolvedValue(result),
		return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
		throw: vi.fn(),
		[Symbol.asyncIterator]() {
			return this;
		},
	};
}

describe("DaytonaSupervisor", () => {
	it("validates with one read-only list request and retains the client in main memory", async () => {
		const iterator = iteratorThat();
		const client: DaytonaClient = { list: vi.fn(() => iterator) };
		const createClient = vi.fn(() => client);
		const supervisor = new DaytonaSupervisor(createClient);

		await expect(supervisor.validateApiKey("  dtn_test  ")).resolves.toEqual({ ok: true });

		expect(createClient).toHaveBeenCalledWith("dtn_test");
		expect(client.list).toHaveBeenCalledWith({ limit: 1 });
		expect(iterator.next).toHaveBeenCalledTimes(1);
		expect(supervisor.isConfigured()).toBe(true);
	});

	it("rejects an empty key without creating a client", async () => {
		const createClient = vi.fn();
		const supervisor = new DaytonaSupervisor(createClient);

		await expect(supervisor.validateApiKey("  ")).rejects.toThrow("Enter a Daytona API key.");
		expect(createClient).not.toHaveBeenCalled();
	});

	it("returns a safe authentication error without exposing the SDK message", async () => {
		const iterator = iteratorThat();
		vi.mocked(iterator.next).mockRejectedValue(new DaytonaAuthenticationError("secret-bearing SDK response", 401));
		const supervisor = new DaytonaSupervisor(() => ({ list: () => iterator }));

		await expect(supervisor.validateApiKey("dtn_bad")).rejects.toThrow(
			"Daytona API key is invalid or does not have access.",
		);
		expect(supervisor.isConfigured()).toBe(false);
	});

	it("clears a previously validated client when replacement validation fails", async () => {
		const validIterator = iteratorThat();
		const invalidIterator = iteratorThat();
		vi.mocked(invalidIterator.next).mockRejectedValue(new DaytonaAuthenticationError("invalid", 401));
		const createClient = vi
			.fn((_apiKey: string): DaytonaClient => ({ list: () => validIterator }))
			.mockReturnValueOnce({ list: () => validIterator })
			.mockReturnValueOnce({ list: () => invalidIterator });
		const supervisor = new DaytonaSupervisor(createClient);

		await supervisor.validateApiKey("dtn_valid");
		expect(supervisor.isConfigured()).toBe(true);
		await expect(supervisor.validateApiKey("dtn_invalid")).rejects.toThrow(
			"Daytona API key is invalid or does not have access.",
		);
		expect(supervisor.isConfigured()).toBe(false);
	});

	it("distinguishes a connection failure from an invalid key", async () => {
		const iterator = iteratorThat();
		vi.mocked(iterator.next).mockRejectedValue(new DaytonaConnectionError("offline"));
		const supervisor = new DaytonaSupervisor(() => ({ list: () => iterator }));

		await expect(supervisor.validateApiKey("dtn_test")).rejects.toThrow(
			"Could not reach Daytona. Check your connection and try again.",
		);
	});
});
