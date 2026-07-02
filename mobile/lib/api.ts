import { httpBase, type ServerConfig } from "./config";
import type { AttentionLevel } from "./theme";

// ---- Types (subset of AO's DashboardSession we use on the phone) ------------

export type DashboardPR = {
	number: number;
	url: string;
	title?: string;
	owner?: string;
	repo?: string;
	branch?: string;
	baseBranch?: string;
	isDraft?: boolean;
	state?: "open" | "merged" | "closed";
	additions?: number;
	deletions?: number;
	changedFiles?: number;
	ciStatus?: "pending" | "passing" | "failing" | "none";
	reviewDecision?: "approved" | "changes_requested" | "pending" | "none";
	mergeability?: {
		mergeable?: boolean;
		ciPassing?: boolean;
		approved?: boolean;
		noConflicts?: boolean;
		blockers?: string[];
	};
	unresolvedThreads?: number;
};

export type DashboardSession = {
	id: string;
	projectId: string;
	status: string | null;
	attentionLevel?: AttentionLevel | string | null;
	activity?: string | null;
	branch: string | null;
	issueId: string | null;
	issueUrl?: string | null;
	issueLabel?: string | null;
	issueTitle: string | null;
	userPrompt: string | null;
	displayName: string | null;
	summary: string | null;
	createdAt: string;
	lastActivityAt: string;
	pr?: DashboardPR | null;
	prs?: DashboardPR[];
	metadata?: Record<string, string>;
};

export type OrchestratorLink = {
	id: string;
	projectId: string;
	projectName: string;
	status?: string | null;
	activity?: string | null;
	runtimeState?: string | null;
	hasRuntime?: boolean;
	isTerminal?: boolean;
	isRestorable?: boolean;
};

export type ProjectInfo = {
	id: string;
	name: string;
	sessionPrefix?: string;
};

export type DashboardStats = {
	totalSessions?: number;
	workingSessions?: number;
	openPRs?: number;
	needsReview?: number;
};

export type SessionsResponse = {
	sessions: DashboardSession[];
	orchestrators: OrchestratorLink[];
	orchestratorId: string | null;
	stats: DashboardStats;
};

// ---- Low-level fetch with friendly errors ----------------------------------

const REQUEST_TIMEOUT_MS = 12000;

async function req(cfg: ServerConfig, path: string, init?: RequestInit): Promise<Response> {
	const url = `${httpBase(cfg)}${path}`;
	// Without a timeout a sleeping/unreachable host (common over Tailscale) hangs
	// the call for the OS TCP timeout (~75-120s), freezing Kill/send and the poll.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	let res: Response;
	try {
		res = await fetch(url, {
			...init,
			signal: controller.signal,
			headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
		});
	} catch (e) {
		if ((e as { name?: string })?.name === "AbortError") {
			throw new Error("Request timed out — is the server reachable?", { cause: e });
		}
		throw e;
	} finally {
		clearTimeout(timer);
	}
	if (!res.ok) {
		let detail = "";
		try {
			detail = (await res.json())?.error ?? "";
		} catch {
			/* ignore */
		}
		throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
	}
	return res;
}

// ---- Reads ------------------------------------------------------------------

export async function getProjects(cfg: ServerConfig): Promise<ProjectInfo[]> {
	const res = await req(cfg, "/api/projects");
	const data = await res.json();
	return Array.isArray(data?.projects) ? data.projects : [];
}

export async function getSessions(cfg: ServerConfig, projectId?: string): Promise<SessionsResponse> {
	const q = projectId && projectId !== "all" ? `?project=${encodeURIComponent(projectId)}` : "?project=all";
	const res = await req(cfg, `/api/sessions${q}`);
	const data = await res.json();
	return {
		sessions: Array.isArray(data?.sessions) ? data.sessions : [],
		orchestrators: Array.isArray(data?.orchestrators) ? data.orchestrators : [],
		orchestratorId: data?.orchestratorId ?? null,
		stats: data?.stats ?? {},
	};
}

// ---- Writes / actions -------------------------------------------------------

export async function killSession(cfg: ServerConfig, id: string): Promise<void> {
	await req(cfg, `/api/sessions/${encodeURIComponent(id)}/kill`, { method: "POST" });
}

export async function restoreSession(cfg: ServerConfig, id: string): Promise<void> {
	await req(cfg, `/api/sessions/${encodeURIComponent(id)}/restore`, { method: "POST" });
}

export async function sendMessage(cfg: ServerConfig, id: string, message: string): Promise<void> {
	await req(cfg, `/api/sessions/${encodeURIComponent(id)}/send`, {
		method: "POST",
		body: JSON.stringify({ message }),
	});
}

export async function spawnSession(
	cfg: ServerConfig,
	opts: { projectId: string; prompt?: string; issueId?: string },
): Promise<DashboardSession> {
	const res = await req(cfg, "/api/spawn", {
		method: "POST",
		body: JSON.stringify(opts),
	});
	const data = await res.json();
	return data?.session;
}

export async function launchOrchestrator(
	cfg: ServerConfig,
	projectId: string,
	clean = false,
): Promise<OrchestratorLink> {
	const res = await req(cfg, "/api/orchestrators", {
		method: "POST",
		body: JSON.stringify({ projectId, clean }),
	});
	const data = await res.json();
	return data?.orchestrator;
}

export async function mergePR(cfg: ServerConfig, pr: DashboardPR): Promise<void> {
	const params: string[] = [];
	if (pr.owner) params.push(`owner=${encodeURIComponent(pr.owner)}`);
	if (pr.repo) params.push(`repo=${encodeURIComponent(pr.repo)}`);
	const q = params.length ? `?${params.join("&")}` : "";
	await req(cfg, `/api/prs/${pr.number}/merge${q}`, { method: "POST" });
}

// Quick reachability probe for the Settings "Test connection" button.
export async function pingServer(cfg: ServerConfig): Promise<number> {
	const res = await req(cfg, "/api/sessions?project=all");
	const data = await res.json();
	return Array.isArray(data?.sessions) ? data.sessions.length : 0;
}

// ---- Derived helpers --------------------------------------------------------

const TERMINAL_STATUSES = new Set(["killed", "terminated", "done", "cleanup", "errored", "merged"]);

export function isTerminalStatus(status?: string | null): boolean {
	return !!status && TERMINAL_STATUSES.has(status);
}

// Fallback attention bucket when the server didn't compute attentionLevel.
export function attentionOf(s: DashboardSession): AttentionLevel {
	if (s.attentionLevel) return s.attentionLevel as AttentionLevel;
	const pr = s.pr ?? s.prs?.[0];
	if (s.status === "merged" || s.status === "done" || isTerminalStatus(s.status)) return "done";
	if (pr?.mergeability?.mergeable || s.status === "mergeable" || s.status === "approved") return "merge";
	if (s.status === "needs_input" || s.status === "stuck" || s.status === "errored") return "respond";
	if (
		pr?.ciStatus === "failing" ||
		pr?.reviewDecision === "changes_requested" ||
		s.status === "ci_failed" ||
		s.status === "changes_requested"
	)
		return "review";
	if (s.status === "pr_open" || s.status === "review_pending") return "pending";
	return "working";
}

export function sessionTitle(s: DashboardSession): string {
	return s.displayName || s.issueTitle || s.userPrompt || s.summary || s.id;
}

// All PRs across sessions, de-duplicated by number+repo.
export function collectPRs(sessions: DashboardSession[]): { pr: DashboardPR; session: DashboardSession }[] {
	const seen = new Set<string>();
	const out: { pr: DashboardPR; session: DashboardSession }[] = [];
	for (const s of sessions) {
		const list = s.prs && s.prs.length ? s.prs : s.pr ? [s.pr] : [];
		for (const pr of list) {
			// Real GitHub/GitLab PR numbers are >= 1; 0/missing signals a placeholder.
			if (!pr || !pr.number || pr.number <= 0) continue;
			const key = `${pr.owner ?? ""}/${pr.repo ?? ""}#${pr.number}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ pr, session: s });
		}
	}
	return out;
}
