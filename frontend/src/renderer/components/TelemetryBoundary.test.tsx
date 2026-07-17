import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeRendererI18n } from "../i18n";
import { captureRendererException } from "../lib/telemetry";
import { TelemetryBoundary } from "./TelemetryBoundary";

vi.mock("../lib/telemetry", () => ({ captureRendererException: vi.fn() }));

const renderError = new Error("expected render failure");

function BrokenChild(): never {
	throw renderError;
}

afterEach(async () => {
	cleanup();
	vi.restoreAllMocks();
	await initializeRendererI18n("en");
});

describe("TelemetryBoundary", () => {
	it("updates an already-mounted error fallback when the language changes", async () => {
		await initializeRendererI18n("en");
		const originalConsoleError = console.error;
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
			const expected = args.some(
				(arg) => arg === renderError || (typeof arg === "string" && arg.includes(renderError.message)),
			);
			if (!expected) originalConsoleError(...args);
		});

		try {
			render(
				<TelemetryBoundary>
					<BrokenChild />
				</TelemetryBoundary>,
			);

			expect(await screen.findByText("The app hit an unexpected error.")).toBeInTheDocument();
			await waitFor(() => expect(captureRendererException).toHaveBeenCalledWith(renderError, expect.any(Object)));

			await act(async () => {
				await initializeRendererI18n("zh-CN");
			});

			expect(screen.getByText("应用遇到意外错误。")).toBeInTheDocument();
			expect(screen.queryByText("The app hit an unexpected error.")).not.toBeInTheDocument();
		} finally {
			consoleErrorSpy.mockRestore();
		}
	});
});
