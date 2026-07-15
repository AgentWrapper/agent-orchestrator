import { authHeaders, httpBase, type ServerConfig } from "./config";
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
	// Browser-preview target the daemon detected/served for this session (e.g. a
	// dist/index.html entrypoint). Consumed by the in-app browser.
	previewUrl?: string | null;
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

// ---- Wire types (this repo's Go daemon, /api/v1/*) --------------------------
//
// The app UI speaks AO's OG "DashboardSession" shape; this daemon speaks a
// leaner read model. The maps below translate the daemon's SessionView/PR facts
// into the shapes the screens expect, so the rest of the app is unchanged.

const API = "/api/v1";

type WirePR = {
	url: string;
	number: number;
	state?: string; // draft | open | merged | closed
	ci?: string; // unknown | pending | passing | failing
	review?: string; // none | approved | changes_requested | review_required
	mergeability?: string; // unknown | mergeable | conflicting | blocked | unstable
	reviewComments?: boolean;
};

type WireSession = {
	id: string;
	projectId: string;
	issueId?: string;
	kind?: string; // worker | orchestrator
	harness?: string;
	displayName?: string;
	activity?: unknown;
	isTerminated?: boolean;
	status?: string | null;
	branch?: string;
	createdAt?: string;
	updatedAt?: string;
	previewUrl?: string;
	prs?: WirePR[];
};

function mapPR(pr: WirePR): DashboardPR {
	const ci = pr.ci === "passing" || pr.ci === "failing" || pr.ci === "pending" ? pr.ci : "none";
	const review =
		pr.review === "approved"
			? "approved"
			: pr.review === "changes_requested"
				? "changes_requested"
				: pr.review === "review_required"
					? "pending"
					: "none";
	const state = pr.state === "merged" ? "merged" : pr.state === "closed" ? "closed" : "open";
	return {
		number: pr.number,
		url: pr.url,
		state,
		isDraft: pr.state === "draft",
		ciStatus: ci,
		reviewDecision: review,
		mergeability: { mergeable: pr.mergeability === "mergeable" },
		unresolvedThreads: pr.reviewComments ? 1 : 0,
	};
}

function activityString(a: unknown): string | null {
	if (typeof a === "string") return a || null;
	if (a && typeof a === "object" && "state" in a && typeof (a as { state: unknown }).state === "string") {
		return (a as { state: string }).state || null;
	}
	return null;
}

function mapSession(s: WireSession): DashboardSession {
	const prs = (s.prs ?? []).map(mapPR);
	return {
		id: s.id,
		projectId: s.projectId,
		status: s.status ?? null,
		activity: activityString(s.activity),
		branch: s.branch ?? null,
		issueId: s.issueId ?? null,
		issueTitle: null,
		userPrompt: null,
		displayName: s.displayName ?? null,
		summary: null,
		createdAt: s.createdAt ?? "",
		lastActivityAt: s.updatedAt ?? s.createdAt ?? "",
		pr: prs[0] ?? null,
		prs,
		previewUrl: s.previewUrl ?? null,
	};
}

function mapOrchestrator(s: WireSession, projectName: string): OrchestratorLink {
	return {
		id: s.id,
		projectId: s.projectId,
		projectName,
		status: s.status ?? null,
		activity: activityString(s.activity),
		hasRuntime: !s.isTerminated,
		isTerminal: !!s.isTerminated,
		isRestorable: !!s.isTerminated,
	};
}

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
			headers: { ...authHeaders(cfg), "Content-Type": "application/json", ...(init?.headers ?? {}) },
		});
	} catch (e) {
		if ((e as { name?: string })?.name === "AbortError") {
			throw new Error("Request timed out - is the server reachable?", { cause: e });
		}
		throw e;
	} finally {
		clearTimeout(timer);
	}
	if (!res.ok) {
		// The daemon returns a locked JSON envelope: { error, code, message, requestId }.
		let detail = "";
		try {
			const body = await res.json();
			detail = body?.message ?? body?.error ?? "";
		} catch {
			/* ignore */
		}
		throw new Error(`${res.status} ${res.statusText}${detail ? ` - ${detail}` : ""}`);
	}
	return res;
}

// ---- Reads ------------------------------------------------------------------

export async function getProjects(cfg: ServerConfig): Promise<ProjectInfo[]> {
	const res = await req(cfg, `${API}/projects`);
	const data = await res.json();
	const projects = Array.isArray(data?.projects) ? data.projects : [];
	return projects.map((p: { id: string; name: string; sessionPrefix?: string }) => ({
		id: p.id,
		name: p.name,
		sessionPrefix: p.sessionPrefix,
	}));
}

export async function getSessions(cfg: ServerConfig, _projectId?: string): Promise<SessionsResponse> {
	// The daemon exposes sessions and orchestrators as two lists. Fetch both,
	// keep worker sessions for the board, and map orchestrators for their screen.
	const [sessRes, orchRes, projects] = await Promise.all([
		req(cfg, `${API}/sessions`),
		req(cfg, `${API}/orchestrators`),
		getProjects(cfg).catch(() => [] as ProjectInfo[]),
	]);
	const sessData = await sessRes.json();
	const orchData = await orchRes.json();
	const nameOf = new Map(projects.map((p) => [p.id, p.name]));

	const rawSessions: WireSession[] = Array.isArray(sessData?.sessions) ? sessData.sessions : [];
	const rawOrchestrators: WireSession[] = Array.isArray(orchData?.sessions) ? orchData.sessions : [];

	const sessions = rawSessions.filter((s) => s.kind !== "orchestrator").map(mapSession);

	// The daemon returns EVERY orchestrator session per project (one per past
	// kill/respawn), so pick a single one per project - preferring the live
	// (non-terminated) one, else the most recent. Otherwise the screen would
	// grab a stale terminated orchestrator and show "Restart" while a live one
	// is actually running.
	const bestByProject = new Map<string, WireSession>();
	for (const s of rawOrchestrators) {
		const cur = bestByProject.get(s.projectId);
		// Keep a live orchestrator once found; otherwise take the later entry
		// (the daemon lists them oldest to newest).
		if (!cur || cur.isTerminated) bestByProject.set(s.projectId, s);
	}
	const orchestrators = [...bestByProject.values()].map((s) =>
		mapOrchestrator(s, nameOf.get(s.projectId) ?? s.projectId),
	);

	return { sessions, orchestrators, orchestratorId: null, stats: {} };
}

// ---- Preview (in-app browser) ----------------------------------------------

// Ask the daemon whether this session has a detectable static preview entry
// (index.html, or dist/build/public/index.html). Returns a URL the in-app
// WebView can load, or null when no entry exists yet - the button then reports
// "no preview". We build the URL from our own base (httpBase honors the TLS
// toggle) rather than the daemon's `previewUrl`, which hardcodes http:// + its
// request host and would break over a TLS tunnel (e.g. tailscale serve).
export async function getPreview(cfg: ServerConfig, id: string): Promise<{ entry: string; url: string } | null> {
	const res = await req(cfg, `${API}/sessions/${encodeURIComponent(id)}/preview`);
	const data = await res.json();
	const entry = typeof data?.entry === "string" ? data.entry.trim() : "";
	if (!entry) return null;
	// Mirror the daemon's files route: /preview/files/<entry>, each segment escaped.
	const escaped = entry.split("/").map(encodeURIComponent).join("/");
	const url = `${httpBase(cfg)}${API}/sessions/${encodeURIComponent(id)}/preview/files/${escaped}`;
	return { entry, url };
}

// ---- Agent catalog ----------------------------------------------------------

export type AgentInfo = {
	id: string;
	label: string;
	authStatus?: "authorized" | "unauthorized" | "unknown";
};

export type AgentCatalog = {
	supported: AgentInfo[];
	installed: AgentInfo[];
	authorized: AgentInfo[];
};

export async function getAgents(cfg: ServerConfig): Promise<AgentCatalog> {
	const res = await req(cfg, `${API}/agents`);
	const data = await res.json();
	return {
		supported: Array.isArray(data?.supported) ? data.supported : [],
		installed: Array.isArray(data?.installed) ? data.installed : [],
		authorized: Array.isArray(data?.authorized) ? data.authorized : [],
	};
}

export async function refreshAgents(cfg: ServerConfig): Promise<AgentCatalog> {
	const res = await req(cfg, `${API}/agents/refresh`, { method: "POST" });
	const data = await res.json();
	return {
		supported: Array.isArray(data?.supported) ? data.supported : [],
		installed: Array.isArray(data?.installed) ? data.installed : [],
		authorized: Array.isArray(data?.authorized) ? data.authorized : [],
	};
}

// ---- Writes / actions -------------------------------------------------------

export async function killSession(cfg: ServerConfig, id: string): Promise<void> {
	await req(cfg, `${API}/sessions/${encodeURIComponent(id)}/kill`, { method: "POST" });
}

export async function restoreSession(cfg: ServerConfig, id: string): Promise<void> {
	await req(cfg, `${API}/sessions/${encodeURIComponent(id)}/restore`, { method: "POST" });
}

export async function sendMessage(cfg: ServerConfig, id: string, message: string): Promise<void> {
	await req(cfg, `${API}/sessions/${encodeURIComponent(id)}/send`, {
		method: "POST",
		body: JSON.stringify({ message }),
	});
}

export async function spawnSession(
	cfg: ServerConfig,
	opts: { projectId: string; prompt?: string; issueId?: string; harness?: string },
): Promise<DashboardSession> {
	const res = await req(cfg, `${API}/sessions`, {
		method: "POST",
		body: JSON.stringify({
			projectId: opts.projectId,
			prompt: opts.prompt,
			issueId: opts.issueId,
			// The daemon needs an agent harness unless the project configures a
			// default worker.agent; the spawn screen lets the user pick one.
			harness: opts.harness || undefined,
			kind: "worker",
		}),
	});
	const data = await res.json();
	return mapSession(data?.session ?? data);
}

export async function launchOrchestrator(
	cfg: ServerConfig,
	projectId: string,
	clean = false,
): Promise<OrchestratorLink> {
	const res = await req(cfg, `${API}/orchestrators`, {
		method: "POST",
		body: JSON.stringify({ projectId, clean }),
	});
	const data = await res.json();
	const o = data?.orchestrator ?? {};
	return {
		id: o.id,
		projectId: o.projectId ?? projectId,
		projectName: o.projectName ?? projectId,
		hasRuntime: true,
		isTerminal: false,
	};
}

export async function mergePR(cfg: ServerConfig, pr: DashboardPR): Promise<void> {
	await req(cfg, `${API}/prs/${pr.number}/merge`, { method: "POST" });
}

// Quick reachability probe for the Settings "Test connection" button.
export async function pingServer(cfg: ServerConfig): Promise<number> {
	const res = await req(cfg, `${API}/sessions`);
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

// Project ids/names carry a generated hash suffix (`my-app_98d163a851`) and
// session ids are minted as `<projectId>-<n>`. Printed in full on a phone that's
// the same slug twice, wider than the card. These two helpers shorten each label
// to something that still identifies it — only when it's actually too long.

const MAX_LABEL = 20;

// Middle-truncate. A plain tail-cut would drop the hash and make two projects
// that share a base name render identically, so keep the head (the readable
// part) AND the tail (the part that disambiguates).
export function shortLabel(value: string, max = MAX_LABEL): string {
	if (value.length <= max) return value;
	const keep = max - 1; // room for the ellipsis
	const head = Math.ceil(keep / 2);
	const tail = Math.floor(keep / 2);
	return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

// A session id is its project id plus a `-n` discriminator, so when that holds
// the only new information is the discriminator — show `#n` rather than
// reprinting the project slug. Ids that don't follow the convention fall back to
// a middle-truncated label.
export function shortSessionId(s: DashboardSession): string {
	const { projectId, id } = s;
	// The separator is required: a bare `startsWith(projectId)` would also match a
	// longer sibling slug (project `app`, session `apple-1`) and print `#le-1`.
	const prefixed = projectId && (id.startsWith(`${projectId}-`) || id.startsWith(`${projectId}_`));
	const rest = prefixed ? id.slice(projectId.length + 1) : "";
	return rest ? `#${rest}` : shortLabel(id);
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
