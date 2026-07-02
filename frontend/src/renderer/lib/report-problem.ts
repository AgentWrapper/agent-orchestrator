import { aoBridge } from "./bridge";
import { routeSurface } from "./telemetry";

export type ReportProblemType = "bug" | "feature" | "feedback" | "question";
export type ReportProblemOutput = "github" | "discord" | "email";

export type ReportProblemInput = {
	type: ReportProblemType;
	summary: string;
	details: string;
	expected: string;
	includeDiagnostics: boolean;
};

export type ReportProblemDiagnostics = {
	appVersion: string;
	buildMode: string;
	daemonMessage?: string;
	daemonState: string;
	generatedAt: string;
	platform: string;
	routeSurface: string;
};

const REDACTED_LOCAL_PATH = "[redacted-local-path]";
const REDACTED_LOCAL_URL = "[redacted-local-url]";
const REDACTED_SECRET = "[redacted-secret]";

const REPORT_TYPE_LABELS: Record<ReportProblemType, string> = {
	bug: "Bug report",
	feature: "Feature request",
	feedback: "Feedback",
	question: "Setup question",
};

const LOCAL_URL_PATTERN =
	/(?:\bfile:\/\/\/\S+|\bapp:\/\/renderer\/\S+|\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\S*)/gi;
const LOCAL_PATH_PATTERN = /(?:\/Users\/|\/home\/|\/tmp\/|\/private\/var\/|\/var\/folders\/)\S+|\b[A-Za-z]:\\[^\s)]+/g;
const QUERY_SECRET_PATTERN =
	/([?&](?:api[_-]?key|token|secret|password|access[_-]?token|refresh[_-]?token|auth)=)[^&\s)]+/gi;
const ASSIGNMENT_SECRET_PATTERN =
	/(\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|AUTH)[A-Z0-9_]*\s*[:=]\s*)(["']?)[^\s"',)]+/gi;
const BEARER_SECRET_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/-]+/gi;
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]+/g;

export function sanitizeReportText(value: string): string {
	if (!value) return "";
	return value
		.replace(LOCAL_URL_PATTERN, REDACTED_LOCAL_URL)
		.replace(LOCAL_PATH_PATTERN, REDACTED_LOCAL_PATH)
		.replace(QUERY_SECRET_PATTERN, `$1${REDACTED_SECRET}`)
		.replace(ASSIGNMENT_SECRET_PATTERN, `$1$2${REDACTED_SECRET}`)
		.replace(BEARER_SECRET_PATTERN, `$1${REDACTED_SECRET}`)
		.replace(OPENAI_KEY_PATTERN, REDACTED_SECRET);
}

export async function collectReportProblemDiagnostics(now = new Date()): Promise<ReportProblemDiagnostics> {
	const [versionResult, daemonResult] = await Promise.allSettled([
		aoBridge.app.getVersion(),
		aoBridge.daemon.getStatus(),
	]);
	const daemonStatus = daemonResult.status === "fulfilled" ? daemonResult.value : undefined;

	return {
		appVersion: versionResult.status === "fulfilled" ? versionResult.value : "unknown",
		buildMode: import.meta.env.DEV ? "dev" : "packaged",
		daemonMessage: daemonStatus?.message,
		daemonState: daemonStatus?.state ?? "unknown",
		generatedAt: now.toISOString(),
		platform: typeof navigator === "undefined" ? "unknown" : navigator.platform || "unknown",
		routeSurface: typeof window === "undefined" ? "unknown" : routeSurface(currentRoutePath()),
	};
}

export function formatReportProblemDraft(
	input: ReportProblemInput,
	diagnostics: ReportProblemDiagnostics,
	output: ReportProblemOutput,
): string {
	const fields = normalizeInput(input);
	const diagnosticsBlock = input.includeDiagnostics
		? formatDiagnostics(diagnostics)
		: "No diagnostics included.";

	if (output === "discord") {
		return [
			`**AO ${fields.typeLabel}**`,
			`Summary: ${fields.summary}`,
			`Details: ${fields.details}`,
			`Expected/request: ${fields.expected}`,
			"",
			"Safe diagnostics:",
			diagnosticsBlock,
			"",
			exclusionNotice(),
		].join("\n");
	}

	if (output === "email") {
		return [
			`Subject: AO feedback: ${fields.summary}`,
			"",
			"AO feedback",
			"",
			`Type: ${fields.typeLabel}`,
			`Summary: ${fields.summary}`,
			"",
			"Details / repro:",
			fields.details,
			"",
			"Expected / request:",
			fields.expected,
			"",
			"Safe diagnostics:",
			diagnosticsBlock,
			"",
			exclusionNotice(),
		].join("\n");
	}

	return [
		`# ${fields.summary === "Not provided" ? fields.typeLabel : fields.summary}`,
		"",
		"## Type",
		fields.typeLabel,
		"",
		"## Summary",
		fields.summary,
		"",
		"## Details / repro",
		fields.details,
		"",
		"## Expected / request",
		fields.expected,
		"",
		"## Safe diagnostics",
		diagnosticsBlock,
		"",
		`_${exclusionNotice()}_`,
	].join("\n");
}

function normalizeInput(input: ReportProblemInput) {
	return {
		typeLabel: REPORT_TYPE_LABELS[input.type],
		summary: valueOrPlaceholder(input.summary),
		details: valueOrPlaceholder(input.details),
		expected: valueOrPlaceholder(input.expected),
	};
}

function valueOrPlaceholder(value: string): string {
	const safe = sanitizeReportText(value.trim());
	return safe || "Not provided";
}

function formatDiagnostics(diagnostics: ReportProblemDiagnostics): string {
	const lines = [
		`AO version: ${sanitizeReportText(diagnostics.appVersion) || "unknown"}`,
		`Build mode: ${sanitizeReportText(diagnostics.buildMode) || "unknown"}`,
		`Platform: ${sanitizeReportText(diagnostics.platform) || "unknown"}`,
		`Route surface: ${sanitizeReportText(diagnostics.routeSurface) || "unknown"}`,
		`Daemon: ${sanitizeReportText(diagnostics.daemonState) || "unknown"}`,
		`Generated: ${sanitizeReportText(diagnostics.generatedAt) || "unknown"}`,
	];
	if (diagnostics.daemonMessage?.trim()) {
		lines.push(`Daemon message: ${sanitizeReportText(diagnostics.daemonMessage.trim())}`);
	}
	return lines.map((line) => `- ${line}`).join("\n");
}

function currentRoutePath(): string {
	const hashPath = window.location.hash.replace(/^#/, "").split("?")[0];
	if (hashPath?.startsWith("/")) return hashPath;
	return window.location.pathname;
}

function exclusionNotice(): string {
	return "Generated locally by AO. No logs, repo contents, prompts, terminal transcript, issue/PR bodies, raw crash dumps, env vars, or SQLite data are included.";
}
