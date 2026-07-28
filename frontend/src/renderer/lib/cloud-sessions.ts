// Per-session cloud registry (renderer side). A cloud worker is a normal card in
// the LOCAL board; only its terminal stream comes from its own sandbox. This
// store holds the association the renderer needs: cloud sessionId →
// { localProjectId, previewUrl }, so the board can merge the card and the
// terminal can route its mux to the sandbox.
//
// The cloud provisioning/supervisor logic lives in the Go daemon; the renderer
// reaches it over the same HTTP API (apiClient) it uses for local sessions —
// /api/v1/cloud/*. The app's global API base URL NEVER changes, which is what
// makes local and cloud sessions indistinguishable in the UI.
import { apiClient } from "./api-client";

export type CloudSessionRef = {
	sessionId: string;
	localProjectId: string;
	harness: string;
	sandboxId: string;
	previewUrl: string;
	/** Async provisioning state: "provisioning" | "ready" | "failed". Owned cloud
	 *  sessions start "provisioning"; imported shared sessions are always ready. */
	status?: string;
	error?: string;
	/** Task title, shown on the provisioning placeholder card before the sandbox
	 *  session exists. */
	displayName?: string;
	/** Imported from a teammate's share token — rendered read-only. */
	shared?: boolean;
	readonly?: boolean;
	/** Owner-supplied display name (imported sessions have no local project). */
	projectName?: string;
};

// A share token's decoded payload (mirrors the Go SharePayload). Model A carries
// the signed preview URL as a bearer secret; model B swaps in a scoped token.
export type SharePayload = {
	v: 1;
	previewUrl: string;
	sandboxId: string;
	sessionId: string;
	harness: string;
	projectName?: string;
	mode: "readonly";
};

// Synthetic board group that holds sessions teammates shared with this user —
// they belong to no local project, so mergeCloudSessions materializes this group.
export const SHARED_PROJECT_ID = "shared-with-me";
export const SHARED_PROJECT_NAME = "Shared with me";

const SHARED_STORE_KEY = "ao.sharedSessions";

// A cloud session's LOCAL board id must be globally unique — the sandbox-local
// sessionId ("<project>-1") collides with local session ids and across sandboxes.
// The sandboxId is unique, so namespace the board id with it.
export function cloudBoardId(sandboxId: string): string {
	return `cloud-${sandboxId}`;
}

// A session you OWN and one a teammate SHARED can point at the same sandbox. They
// must be distinct board cards, so shared imports get their own prefix.
export function sharedBoardId(sandboxId: string): string {
	return `shared-${sandboxId}`;
}

/** The board id for a ref, honoring the owned vs shared distinction. */
export function boardIdForRef(ref: CloudSessionRef): string {
	return ref.shared ? sharedBoardId(ref.sandboxId) : cloudBoardId(ref.sandboxId);
}

/** Reverse of cloud/sharedBoardId: a board id → its sandboxId, or null for a local id. */
export function sandboxIdFromBoardId(boardSessionId: string): string | null {
	if (boardSessionId.startsWith("cloud-")) return boardSessionId.slice("cloud-".length);
	if (boardSessionId.startsWith("shared-")) return boardSessionId.slice("shared-".length);
	return null;
}

let refs: CloudSessionRef[] = [];
const listeners = new Set<() => void>();

function emit() {
	listeners.forEach((l) => l());
}

export function subscribeCloudSessions(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function getCloudSessions(): CloudSessionRef[] {
	return refs;
}

export function cloudPreviewUrlFor(sessionId: string): string | undefined {
	return refs.find((r) => r.sessionId === sessionId)?.previewUrl;
}

// Resolve a board session id to its sandbox target, or null for local sessions.
export function cloudTargetFor(
	boardSessionId: string,
): { previewUrl: string; sessionId: string; shared: boolean } | null {
	const ref = refs.find((r) => boardIdForRef(r) === boardSessionId);
	return ref ? { previewUrl: ref.previewUrl, sessionId: ref.sessionId, shared: Boolean(ref.shared) } : null;
}

/** Whether cloud sandboxes are usable + which harnesses (drives the New Task
 *  Local/Cloud toggle). Reports not-configured on any error. */
export async function cloudCapabilities(): Promise<{ configured: boolean; harnesses: string[] }> {
	try {
		const { data } = await apiClient.GET("/api/v1/cloud/capabilities");
		return { configured: Boolean(data?.configured), harnesses: data?.harnesses ?? [] };
	} catch {
		return { configured: false, harnesses: [] };
	}
}

// ── Imported shared sessions (viewer side, model A) ─────────────────────────
// Owned cloud sessions come from the Go daemon; sessions a teammate shared with
// us are stored here (localStorage) and merged into the same `refs` list, so
// board-merge, terminal routing, and session-api all treat them uniformly.

function decodeShareToken(input: string): SharePayload {
	// Accept a raw token or a full ao://share/<token> deep link.
	let raw = input.trim();
	if (/^ao:\/\//i.test(raw)) {
		try {
			const u = new URL(raw);
			raw = u.searchParams.get("token") || u.pathname.replace(/^\/+/, "");
		} catch {
			throw new Error("Invalid or unsupported share link.");
		}
	}
	raw = raw.replace(/^ao-share:/i, "");
	const b64 = raw.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (raw.length % 4)) % 4);
	let json: SharePayload;
	try {
		json = JSON.parse(atob(b64)) as SharePayload;
	} catch {
		throw new Error("Invalid or unsupported share link.");
	}
	if (json.v !== 1 || !json.previewUrl || !json.sandboxId || !json.sessionId) {
		throw new Error("Invalid or unsupported share link.");
	}
	return json;
}

function loadSharedPayloads(): SharePayload[] {
	if (typeof localStorage === "undefined") return [];
	try {
		const rows = JSON.parse(localStorage.getItem(SHARED_STORE_KEY) ?? "[]") as SharePayload[];
		return Array.isArray(rows) ? rows.filter((r) => r?.v === 1 && r.sandboxId && r.previewUrl) : [];
	} catch {
		return [];
	}
}

function saveSharedPayloads(rows: SharePayload[]): void {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(SHARED_STORE_KEY, JSON.stringify(rows));
}

function sharedRef(p: SharePayload): CloudSessionRef {
	return {
		sessionId: p.sessionId,
		localProjectId: SHARED_PROJECT_ID,
		harness: p.harness,
		sandboxId: p.sandboxId,
		previewUrl: p.previewUrl,
		shared: true,
		readonly: p.mode === "readonly",
		projectName: p.projectName,
	};
}

/** Import a teammate's share token. Idempotent per sandbox. Returns the payload. */
export function importSharedSession(token: string): SharePayload {
	const payload = decodeShareToken(token);
	const rows = loadSharedPayloads().filter((r) => r.sandboxId !== payload.sandboxId);
	rows.push(payload);
	saveSharedPayloads(rows);
	void refreshCloudSessions();
	return payload;
}

/** Drop an imported shared session. */
export function removeSharedSession(sandboxId: string): void {
	saveSharedPayloads(loadSharedPayloads().filter((r) => r.sandboxId !== sandboxId));
	void refreshCloudSessions();
}

/** Pull the live cloud-session registry from the Go daemon, plus any imported
 *  shared sessions. */
export async function refreshCloudSessions(): Promise<void> {
	let owned: CloudSessionRef[] = [];
	try {
		const { data } = await apiClient.GET("/api/v1/cloud/sessions");
		owned = (data?.sessions ?? []).map((s) => ({
			sessionId: s.sessionId,
			localProjectId: s.localProjectId,
			harness: s.harness,
			sandboxId: s.sandboxId,
			previewUrl: s.previewUrl,
			status: s.status,
			error: s.error,
			displayName: s.displayName,
		}));
	} catch {
		owned = refs.filter((r) => !r.shared); // keep last known owned set
	}
	const shared = loadSharedPayloads().map(sharedRef);
	refs = [...owned, ...shared];
	emit();
}

/** Refresh a sandbox's signed preview URL before it expires (per-session). */
export async function refreshPreviewUrl(sandboxId: string): Promise<string | undefined> {
	try {
		const { data } = await apiClient.GET("/api/v1/cloud/sessions/{sandboxId}/view-url", {
			params: { path: { sandboxId } },
		});
		if (data?.url) {
			refs = refs.map((r) => (r.sandboxId === sandboxId ? { ...r, previewUrl: data.url } : r));
			emit();
			return data.url;
		}
	} catch {
		/* keep the current url */
	}
	return undefined;
}
