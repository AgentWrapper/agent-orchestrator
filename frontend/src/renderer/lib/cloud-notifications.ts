// Cloud notification fan-out (closes the last "everything internal" gap).
//
// Each cloud session runs a full daemon in its sandbox, which produces its own
// notifications (needs_input, ready_to_merge, …). The notification center only
// talks to the LOCAL daemon, so cloud notifications would never surface. This
// module fetches each cloud sandbox's notifications (through the Go daemon's
// /cloud/proxy — the sandbox preview host's duplicate CORS header blocks a direct
// browser fetch) and remaps them into board-space so they merge into the one
// unified list, badge, and click-to-navigate flow — identical to local.
//
// Remapping (a sandbox notification → board-space):
//   id        → cloud:<sandboxId>:<originalId>   (unique; lets read-routing find the sandbox)
//   sessionId → the merged board card's id (cloud-/shared-<sandboxId>)
//   projectId → the LOCAL project id             (cloud card lives under the local project)
import type { components } from "../../api/schema";
import { apiClient } from "./api-client";
import { getCloudSessions, boardIdForRef, type CloudSessionRef } from "./cloud-sessions";

type NotificationDTO = components["schemas"]["NotificationResponse"];

const ID_PREFIX = "cloud:";

function remap(dto: NotificationDTO, ref: CloudSessionRef): NotificationDTO {
	const boardId = boardIdForRef(ref);
	return {
		...dto,
		id: `${ID_PREFIX}${ref.sandboxId}:${dto.id}`,
		sessionId: boardId,
		projectId: ref.localProjectId,
		target: dto.target?.kind === "session" ? { ...dto.target, sessionId: boardId } : dto.target,
	};
}

/** Parse a cloud-namespaced id back to {sandboxId, originalId} for read-routing;
 *  null for a local notification id. */
export function parseCloudNotifId(id: string): { sandboxId: string; originalId: string } | null {
	if (!id.startsWith(ID_PREFIX)) return null;
	const rest = id.slice(ID_PREFIX.length);
	const sep = rest.indexOf(":");
	if (sep < 0) return null;
	return { sandboxId: rest.slice(0, sep), originalId: rest.slice(sep + 1) };
}

function previewUrlForSandbox(sandboxId: string): string | undefined {
	return getCloudSessions().find((r) => r.sandboxId === sandboxId)?.previewUrl;
}

/** Fetch + remap notifications from every live cloud sandbox (best-effort),
 *  each relayed through the daemon proxy. */
export async function fetchCloudNotifications(status: "unread" | "all"): Promise<NotificationDTO[]> {
	const refs = getCloudSessions();
	const perSandbox = await Promise.all(
		refs.map(async (ref) => {
			try {
				const { data } = await apiClient.POST("/api/v1/cloud/proxy", {
					body: { previewUrl: ref.previewUrl, method: "GET", path: `/api/v1/notifications?status=${status}&limit=100` },
				});
				if (!data?.ok) return [];
				const j = (data.json ?? {}) as { notifications?: NotificationDTO[] };
				return (j.notifications ?? []).map((n) => remap(n, ref));
			} catch {
				return [];
			}
		}),
	);
	return perSandbox.flat();
}

/** Mark a cloud notification read on its own sandbox daemon (via the proxy). */
export async function markCloudNotificationRead(id: string): Promise<boolean> {
	const parsed = parseCloudNotifId(id);
	if (!parsed) return false;
	const previewUrl = previewUrlForSandbox(parsed.sandboxId);
	if (!previewUrl) return true; // sandbox gone; treat as handled
	try {
		await apiClient.POST("/api/v1/cloud/proxy", {
			body: { previewUrl, method: "PATCH", path: `/api/v1/notifications/${parsed.originalId}`, body: { status: "read" } },
		});
	} catch {
		/* best-effort */
	}
	return true;
}

/** Mark-all-read across every cloud sandbox (paired with the local mark-all). */
export async function markAllCloudNotificationsRead(): Promise<void> {
	await Promise.all(
		getCloudSessions().map(async (ref) => {
			try {
				await apiClient.POST("/api/v1/cloud/proxy", {
					body: { previewUrl: ref.previewUrl, method: "POST", path: "/api/v1/notifications/read-all" },
				});
			} catch {
				/* best-effort */
			}
		}),
	);
}
