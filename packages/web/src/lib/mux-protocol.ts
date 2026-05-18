import type {
  Artifact,
  DashboardNotificationRecord,
  SerializedDashboardAction as DashboardNotificationAction,
  SerializedDashboardEvent as DashboardNotificationEvent,
} from "@aoagents/ao-core";
import type { AttentionLevel } from "./types";

export type {
  DashboardNotificationAction,
  DashboardNotificationEvent,
  DashboardNotificationRecord,
};

// ── Client → Server ──

export type ClientMessage =
  | { ch: "terminal"; id: string; type: "data"; data: string; projectId?: string }
  | { ch: "terminal"; id: string; type: "resize"; cols: number; rows: number; projectId?: string }
  | { ch: "terminal"; id: string; type: "open"; projectId?: string; tmuxName?: string }
  | { ch: "terminal"; id: string; type: "close"; projectId?: string }
  | { ch: "system"; type: "ping" }
  | { ch: "subscribe"; topics: Array<"sessions" | "artifacts" | "notifications"> };

// ── Server → Client ──

export type ServerMessage =
  | { ch: "terminal"; id: string; type: "data"; data: string; projectId?: string }
  | { ch: "terminal"; id: string; type: "exited"; code: number; projectId?: string }
  | { ch: "terminal"; id: string; type: "opened"; projectId?: string }
  | { ch: "terminal"; id: string; type: "error"; message: string; projectId?: string }
  | { ch: "sessions"; type: "snapshot"; sessions: SessionPatch[] }
  | { ch: "sessions"; type: "error"; error: string }
  | {
      ch: "notifications";
      type: "snapshot" | "append";
      notifications: DashboardNotificationRecord[];
      limit: number;
    }
  | { ch: "notifications"; type: "error"; error: string }
  | ArtifactUpdateEvent
  | ArtifactErrorEvent
  | ArtifactDeleteEvent
  | { ch: "system"; type: "pong" }
  | { ch: "system"; type: "error"; message: string };

// ── Artifact events (server → client) ──
// Mirror of ArtifactEvent from @aoagents/ao-core's artifact-watcher, wrapped with
// `ch: "artifacts"` for mux protocol routing. Emitted by the server when the
// artifact watcher observes staging-file changes.

export type ArtifactUpdateEvent = {
  ch: "artifacts";
  type: "artifact-update";
  sessionId: string;
  artifact: Artifact;
};

export type ArtifactErrorEvent = {
  ch: "artifacts";
  type: "artifact-error";
  sessionId: string;
  artifactId: string;
  errors: { path: string[]; message: string }[];
};

export type ArtifactDeleteEvent = {
  ch: "artifacts";
  type: "artifact-delete";
  sessionId: string;
  artifactId: string;
};

export interface SessionPatch {
  id: string;
  status: string;
  activity: string | null;
  /** Tight union — server-computed via getAttentionLevel. Unvalidated strings
   *  (e.g. "none") would lookup-miss downstream in DynamicFavicon and silently
   *  drop urgent sessions from the favicon count. */
  attentionLevel: AttentionLevel;
  lastActivityAt: string;
}
