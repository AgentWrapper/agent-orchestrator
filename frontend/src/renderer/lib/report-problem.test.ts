import { afterEach, describe, expect, it, vi } from "vitest";
import {
	collectReportProblemDiagnostics,
	formatReportProblemDraft,
	reportProblemDestinationUrl,
	type ReportProblemDiagnostics,
	type ReportProblemInput,
	type ReportProblemOutput,
} from "./report-problem";

const diagnostics: ReportProblemDiagnostics = {
	appVersion: "1.2.3-test",
	buildMode: "dev",
	daemonState: "ready",
	generatedAt: "2026-07-02T00:00:00.000Z",
	platform: "darwin-arm64",
	routeSurface: "session_detail",
};

const completeInput: ReportProblemInput = {
	type: "bug",
	summary: "Terminal keeps reconnecting after daemon restart",
	details: "Open /Users/alice/work/secret-app and visit http://127.0.0.1:5173/?token=secret-token.",
	expected: "The app should reconnect without losing the current route.",
	includeDiagnostics: true,
};

describe("report problem drafts", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		window.location.hash = "";
	});

	it("formats GitHub, Discord, and email drafts with user text plus safe diagnostics", () => {
		const outputs: ReportProblemOutput[] = ["github", "discord", "email"];

		for (const output of outputs) {
			const draft = formatReportProblemDraft(completeInput, diagnostics, output);

			expect(draft).toContain("Terminal keeps reconnecting after daemon restart");
			expect(draft).toContain("The app should reconnect without losing the current route.");
			expect(draft).toContain("AO version: 1.2.3-test");
			expect(draft).toContain("Daemon: ready");
			expect(draft).toContain("Route surface: session_detail");
		}
	});

	it("redacts local paths, local URLs, and token-like values from drafts", () => {
		const draft = formatReportProblemDraft(
			{
				type: "question",
				summary: "Setup fails with OPENAI_API_KEY=sk-proj-secret and password=hunter2",
				details: "Repo is C:\\Users\\alice\\repo and file:///Users/alice/private/index.html?api_key=abc failed.",
				expected: "Tell me what prerequisite is missing.",
				includeDiagnostics: true,
			},
			{
				...diagnostics,
				daemonMessage: "Serving http://localhost:31001/api/v1/sessions?access_token=local-secret",
			},
			"github",
		);

		expect(draft).toContain("[redacted-local-path]");
		expect(draft).toContain("[redacted-local-url]");
		expect(draft).toContain("[redacted-secret]");
		expect(draft).not.toContain("/Users/alice");
		expect(draft).not.toContain("C:\\Users\\alice");
		expect(draft).not.toContain("localhost:31001");
		expect(draft).not.toContain("sk-proj-secret");
		expect(draft).not.toContain("hunter2");
	});

	it("produces a useful draft when user input is partial", () => {
		const draft = formatReportProblemDraft(
			{ type: "feedback", summary: "", details: "", expected: "", includeDiagnostics: false },
			diagnostics,
			"email",
		);

		expect(draft).toContain("Feedback");
		expect(draft).toContain("Not provided");
		expect(draft).toContain("No diagnostics included");
	});

	it("builds copy handoff destinations for GitHub, Discord, and email", () => {
		const github = new URL(reportProblemDestinationUrl(completeInput, diagnostics, "github"));
		expect(`${github.origin}${github.pathname}`).toBe(
			"https://github.com/AgentWrapper/agent-orchestrator/issues/new",
		);
		expect(github.searchParams.get("title")).toBe("Terminal keeps reconnecting after daemon restart");
		expect(github.searchParams.get("body")).toContain("[redacted-local-path]");
		expect(github.searchParams.get("body")).toContain("[redacted-local-url]");

		expect(reportProblemDestinationUrl(completeInput, diagnostics, "discord")).toBe(
			"https://discord.com/invite/UZv7JjxbwG",
		);

		const email = reportProblemDestinationUrl(completeInput, diagnostics, "email");
		const params = new URLSearchParams(email.replace(/^mailto:\?/, ""));
		expect(params.get("subject")).toBe("AO feedback: Terminal keeps reconnecting after daemon restart");
		expect(params.get("body")).toContain("[redacted-local-path]");
		expect(params.get("body")).toContain("[redacted-local-url]");
	});

	it("derives route surface from the hash-history route", async () => {
		window.ao!.app.getVersion = vi.fn().mockResolvedValue("1.2.3-test");
		window.ao!.daemon.getStatus = vi.fn().mockResolvedValue({ state: "ready" });
		window.location.hash = "#/projects/demo/sessions/demo-1";

		const nextDiagnostics = await collectReportProblemDiagnostics(new Date("2026-07-02T00:00:00.000Z"));

		expect(nextDiagnostics.routeSurface).toBe("session_detail");
	});
});
