export type TrayAttentionZone = "action" | "merge";

export type TraySessionEntry = {
	projectId: string;
	projectName: string;
	sessionId: string;
	title: string;
	zone: TrayAttentionZone;
};

export type TrayAttentionState = {
	sessions: TraySessionEntry[];
};

export type TrayOpenSessionTarget = {
	projectId: string;
	sessionId: string;
};

export const TRAY_SET_ATTENTION_STATE_CHANNEL = "tray:setAttentionState";
export const TRAY_OPEN_SESSION_CHANNEL = "tray:openSession";
export const TRAY_RENDERER_READY_CHANNEL = "tray:rendererReady";
