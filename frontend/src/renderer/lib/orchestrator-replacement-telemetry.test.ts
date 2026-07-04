import { describe, expect, it, vi } from "vitest";

const { captureRendererExceptionMock } = vi.hoisted(() => ({
	captureRendererExceptionMock: vi.fn(),
}));

vi.mock("./telemetry", () => ({
	captureRendererException: captureRendererExceptionMock,
}));

import { captureOrchestratorReplacementFailure } from "./orchestrator-replacement-telemetry";

describe("captureOrchestratorReplacementFailure", () => {
	it("records the shell restart-failure telemetry payload", () => {
		const error = new Error("missing goose binary");

		captureOrchestratorReplacementFailure(error, "proj-1");

		expect(captureRendererExceptionMock).toHaveBeenCalledWith(error, {
			source: "orchestrator-replace",
			operation: "replace_orchestrator",
			surface: "shell",
			project_id: "proj-1",
		});
	});
});
