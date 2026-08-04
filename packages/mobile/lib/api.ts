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
	// Which agent CLI drives this session (claude-code, codex, …). Parsed off the
	// wire but discarded until the orchestrator tab needed it for brand marks.
	harness?: string | null;
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
	// Whether the runtime is dead. The board archives on this rather than on a
	// finished status: a merged session whose agent is still running belongs on
	// the board, only a terminated one belongs in the archive.
	isTerminated?: boolean;
};

export type OrchestratorLink = {
	id: string;
	projectId: string;
	projectName: string;
	status?: string | null;
	activity?: string | null;
	/** Agent CLI driving this orchestrator — drives its brand mark. */
	harness?: string | null;
	updatedAt?: string | null;
	runtimeState?: string | null;
	hasRuntime?: boolean;
	isTerminal?: boolean;
	isRestorable?: boolean;
};

export type ProjectInfo = {
	id: string;
	name: string;
	kind?: "single_repo" | "workspace" | "scratch";
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
	// Returned here so callers don't fetch /projects a second time — getSessions
	// already needs it to label orchestrators.
	projects: ProjectInfo[];
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

type WireProject = {
	id: string;
	name: string;
	kind?: string;
	sessionPrefix?: string;
};

function mapProjectKind(kind?: string): ProjectInfo["kind"] {
	switch (kind) {
		case "single_repo":
		case "workspace":
		case "scratch":
			return kind;
		default:
			return undefined;
	}
}

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
		harness: s.harness ?? null,
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
		isTerminated: !!s.isTerminated,
	};
}

function mapOrchestrator(s: WireSession, projectName: string): OrchestratorLink {
	return {
		id: s.id,
		projectId: s.projectId,
		projectName,
		status: s.status ?? null,
		activity: activityString(s.activity),
		harness: s.harness ?? null,
		updatedAt: s.updatedAt ?? null,
		hasRuntime: !s.isTerminated,
		isTerminal: !!s.isTerminated,
		isRestorable: !!s.isTerminated,
	};
}

// ---- Low-level fetch with friendly errors ----------------------------------

const REQUEST_TIMEOUT_MS = 12000;

// The server answered, but with an error status. Distinct from the errors fetch
// itself throws (DNS/refused/timeout), which mean the server was never reached —
// a difference callers must be able to act on, since "wrong password" and "your
// server is unreachable" need very different advice. The message keeps the
// `${status} ${statusText}` prefix that call sites already match on.
export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		// The daemon's machine-readable error code (e.g. SESSION_AWAITING_DECISION).
		// Carried separately from `message` so callers can branch on the exact
		// condition instead of pattern-matching human-facing prose.
		readonly code?: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

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
		let code: string | undefined;
		try {
			const body = await res.json();
			detail = body?.message ?? body?.error ?? "";
			code = typeof body?.code === "string" ? body.code : undefined;
		} catch {
			/* ignore */
		}
		throw new ApiError(res.status, `${res.status} ${res.statusText}${detail ? ` - ${detail}` : ""}`, code);
	}
	return res;
}

// ---- Reads ------------------------------------------------------------------

export async function getProjects(cfg: ServerConfig): Promise<ProjectInfo[]> {
	const res = await req(cfg, `${API}/projects`);
	const data = await res.json();
	const projects = Array.isArray(data?.projects) ? data.projects : [];
	return projects.map((p: WireProject) => ({
		id: p.id,
		name: p.name,
		kind: mapProjectKind(p.kind),
		sessionPrefix: p.sessionPrefix,
	}));
}

export async function getSessions(cfg: ServerConfig, _projectId?: string): Promise<SessionsResponse> {
	// The daemon exposes sessions and orchestrators as two lists. Fetch both,
	// keep worker sessions for the board, and map orchestrators for their screen.
	//
	// /sessions is probed FIRST, alone, rather than fanning out in one Promise.all.
	// The daemon locks a device out for a minute after 5 failed auths, so a stale
	// password used to cost 4 failures per poll tick (this call's three requests
	// plus the caller's own /projects) — enough to arm the lockout in one or two
	// ticks and make the user's next action, typically scanning a fresh pairing
	// code, fail with 429 before the new password was ever checked. Probing first
	// caps a bad-credential tick at a single failed attempt.
	const sessRes = await req(cfg, `${API}/sessions`);
	const [orchRes, projects] = await Promise.all([
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

	return { sessions, orchestrators, orchestratorId: null, stats: {}, projects };
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

// ---- Push notifications -----------------------------------------------------

// Register (idempotent upsert) this device's Expo push token with the daemon so
// its dispatcher can deliver OS push notifications. Keyed daemon-side by token.
export async function registerPushDevice(
	cfg: ServerConfig,
	device: { token: string; platform?: string; deviceName?: string },
): Promise<void> {
	await req(cfg, `${API}/push/devices`, {
		method: "POST",
		body: JSON.stringify(device),
	});
}

// Unregister this device's push token (best-effort on disconnect/unpair). The
// token's [ ] brackets must be URL-encoded for the path segment.
export async function unregisterPushDevice(cfg: ServerConfig, token: string): Promise<void> {
	await req(cfg, `${API}/push/devices/${encodeURIComponent(token)}`, { method: "DELETE" });
}

// Mark a notification read (best-effort on notification tap) so unread counts
// stay consistent with the web dashboard.
export async function markNotificationRead(cfg: ServerConfig, id: string): Promise<void> {
	await req(cfg, `${API}/notifications/${encodeURIComponent(id)}`, {
		method: "PATCH",
		body: JSON.stringify({ status: "read" }),
	});
}

// ---- Notification history ---------------------------------------------------

export type NotificationType = "needs_input" | "ready_to_merge" | "pr_merged" | "pr_closed_unmerged";

export type NotificationRecord = {
	id: string;
	sessionId: string;
	projectId: string;
	prUrl: string;
	type: NotificationType | string;
	title: string;
	body: string;
	status: "unread" | "read" | string;
	createdAt: string;
};

export type NotificationPage = {
	notifications: NotificationRecord[];
	nextCursor?: string;
	unreadCount: number;
};

// History behind the Settings → Notifications row. Push only ever surfaces the
// notifications that arrive while the phone is reachable; this is the durable
// record the daemon keeps either way.
export async function getNotifications(
	cfg: ServerConfig,
	opts: { status?: "unread" | "all"; limit?: number; cursor?: string } = {},
): Promise<NotificationPage> {
	const qs = new URLSearchParams();
	if (opts.status) qs.set("status", opts.status);
	if (opts.limit) qs.set("limit", String(opts.limit));
	if (opts.cursor) qs.set("cursor", opts.cursor);
	const suffix = qs.toString() ? `?${qs}` : "";
	const res = await req(cfg, `${API}/notifications${suffix}`);
	const data = await res.json();
	return {
		notifications: Array.isArray(data?.notifications) ? data.notifications : [],
		nextCursor: typeof data?.nextCursor === "string" && data.nextCursor ? data.nextCursor : undefined,
		unreadCount: typeof data?.unreadCount === "number" ? data.unreadCount : 0,
	};
}

export async function markAllNotificationsRead(cfg: ServerConfig): Promise<void> {
	await req(cfg, `${API}/notifications/read-all`, { method: "POST" });
}

// ---- Pull request detail ----------------------------------------------------

// The rich per-PR view, from GET /sessions/{id}/pr. The board poll (GET
// /sessions) carries only PR *facts* — number, state, ci, review, mergeability —
// with no title, author, branches or diff stats, which is why the PR list can
// only show what a session already knows. This is the endpoint that has the
// rest, so it is fetched on demand when a PR is opened rather than on every
// 8s poll. Shape mirrors SessionPRSummary in
// backend/internal/httpd/controllers/dto.go.

export type PRFailingCheck = { name: string; status?: string; conclusion?: string; url?: string };
export type PRConflictFile = { path: string; url?: string };
export type PRUnresolvedReviewer = { reviewerId: string; count: number; reviewUrl?: string; isBot?: boolean };

export type SessionPRSummary = {
	url: string;
	htmlUrl?: string;
	number: number;
	title: string;
	state: "draft" | "open" | "merged" | "closed";
	repo: string;
	author: string;
	sourceBranch: string;
	targetBranch: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	ci: { state: "unknown" | "pending" | "passing" | "failing"; failingChecks: PRFailingCheck[] };
	review: {
		decision: "none" | "approved" | "changes_requested" | "review_required";
		hasUnresolvedHumanComments: boolean;
		unresolvedBy: PRUnresolvedReviewer[];
	};
	mergeability: {
		state: "unknown" | "mergeable" | "conflicting" | "blocked" | "unstable";
		reasons: string[];
		prUrl?: string;
		conflictFiles?: PRConflictFile[];
	};
	updatedAt?: string;
};

export async function getSessionPR(cfg: ServerConfig, sessionId: string): Promise<SessionPRSummary[]> {
	const res = await req(cfg, `${API}/sessions/${encodeURIComponent(sessionId)}/pr`);
	const data = await res.json();
	return Array.isArray(data?.prs) ? data.prs : [];
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

// Derived status helpers live in sessionStatus.ts so pure modules can import
// them; re-exported here because call sites reach for them via api.
export { attentionOf, isTerminalStatus, sessionTitle } from "./sessionStatus";

// Project ids carry a generated hash suffix (`my-app_98d163a851`), which is
// wider than a phone card. Middle-truncate: a plain tail-cut would drop the hash
// and make two projects sharing a base name render identically, so keep the head
// (the readable part) AND the tail (the part that disambiguates).
const MAX_LABEL = 20;

export function shortLabel(value: string, max = MAX_LABEL): string {
	if (value.length <= max) return value;
	const keep = max - 1; // room for the ellipsis
	const head = Math.ceil(keep / 2);
	const tail = Math.floor(keep / 2);
	return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}
