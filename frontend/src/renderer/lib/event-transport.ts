import type { QueryClient } from "@tanstack/react-query";
import { aoBridge } from "./bridge";
import { getApiBaseUrl, hasTrustedApiBaseUrl, subscribeApiBaseUrl } from "./api-client";
import { setEventsConnectionState } from "./events-connection";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { sessionScmSummaryQueryKey } from "../hooks/useSessionScmSummary";
import { pipelinesEnabledQueryKey } from "../hooks/usePipelinesEnabled";

export type EventTransport = {
	connect: () => () => void;
};

const INVALIDATE_DEBOUNCE_MS = 150;
// How long to wait before rebuilding an EventSource the browser gave up on
// (readyState CLOSED — e.g. the daemon answered with a non-SSE response).
const SSE_RETRY_MS = 5_000;
// EventSource.CLOSED, referenced numerically so test stubs without the static
// constants still work.
const EVENTSOURCE_CLOSED = 2;

// CDC event types the daemon pushes over the SSE stream (see
// backend/internal/cdc/event.go). The SSE writer tags each frame with
// `event: <type>`, so named events bypass EventSource.onmessage and must be
// subscribed explicitly. Every one of these can change the project/session list
// the sidebar renders, so they all trigger a (debounced) workspace refetch.
const CDC_EVENT_TYPES = [
	"session_created",
	"session_updated",
	"pr_created",
	"pr_updated",
	"pr_check_recorded",
	"pr_session_changed",
	"pr_review_thread_added",
	"pr_review_thread_resolved",
] as const;

// Pipeline CDC events (backend/internal/cdc/event.go) ride the same SSE stream
// but change only pipeline state, so they invalidate the pipeline query family
// rather than the workspace/session lists. Every pipeline query key is prefixed
// "pipeline-" (see hooks/usePipelineRuns, T9 definitions), so one predicate
// covers runs, run detail, and definitions.
const PIPELINE_EVENT_TYPES = [
	"pipeline_definition_changed",
	"pipeline_run_updated",
	"pipeline_stage_run_updated",
	"pipeline_artifact_updated",
] as const;

function isPipelineQueryKey(queryKey: readonly unknown[]): boolean {
	return typeof queryKey[0] === "string" && queryKey[0].startsWith("pipeline");
}

/**
 * Wires live server state into the TanStack Query cache. Two sources feed it:
 *   - daemon lifecycle over Electron IPC (coming up/down changes session availability)
 *   - the backend CDC stream over SSE (project/session/PR changes)
 * Both invalidate the ["workspaces"] query so the UI refetches. Invalidations are
 * debounced because a single user action can emit a burst of CDC events.
 */
export function createEventTransport(queryClient: QueryClient): EventTransport {
	return {
		connect() {
			let debounce: ReturnType<typeof setTimeout> | undefined;
			let pipelineDebounce: ReturnType<typeof setTimeout> | undefined;
			let retryTimer: ReturnType<typeof setTimeout> | undefined;
			let source: EventSource | undefined;
			let sourceBaseUrl: string | undefined;
			const refreshWorkspaces = () => {
				if (debounce) clearTimeout(debounce);
				debounce = setTimeout(() => {
					void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
					void queryClient.invalidateQueries({ queryKey: sessionScmSummaryQueryKey() });
				}, INVALIDATE_DEBOUNCE_MS);
			};
			const refreshPipelines = () => {
				if (pipelineDebounce) clearTimeout(pipelineDebounce);
				pipelineDebounce = setTimeout(() => {
					void queryClient.invalidateQueries({ predicate: (query) => isPipelineQueryKey(query.queryKey) });
				}, INVALIDATE_DEBOUNCE_MS);
			};

			const scheduleRetry = () => {
				if (retryTimer) return;
				retryTimer = setTimeout(() => {
					retryTimer = undefined;
					connectSource();
				}, SSE_RETRY_MS);
			};

			const connectSource = () => {
				// EventSource is unavailable in jsdom (tests) and some preview surfaces; guard it.
				if (typeof EventSource === "undefined") return;
				if (!hasTrustedApiBaseUrl()) {
					source?.close();
					source = undefined;
					sourceBaseUrl = undefined;
					setEventsConnectionState("disconnected");
					return;
				}
				const baseUrl = getApiBaseUrl();
				// Keep a still-usable source on the same base URL; replace one the
				// browser abandoned (CLOSED) or one bound to a stale port.
				if (source && sourceBaseUrl === baseUrl && source.readyState !== EVENTSOURCE_CLOSED) return;
				source?.close();
				source = undefined;
				sourceBaseUrl = baseUrl;
				try {
					source = new EventSource(`${baseUrl.replace(/\/+$/, "")}/api/v1/events`);
					source.onopen = () => {
						setEventsConnectionState("connected");
						// Events emitted during the gap were lost; refetch once on (re)open.
						refreshWorkspaces();
					};
					source.onerror = () => {
						// While readyState is CONNECTING the browser retries on its own;
						// either way the stream is not delivering, so surface it instead
						// of looping silently against a dead daemon.
						setEventsConnectionState("disconnected");
						if (source?.readyState === EVENTSOURCE_CLOSED) scheduleRetry();
					};
					source.onmessage = refreshWorkspaces; // unnamed events, if any
					for (const type of CDC_EVENT_TYPES) {
						source.addEventListener(type, refreshWorkspaces);
					}
					for (const type of PIPELINE_EVENT_TYPES) {
						source.addEventListener(type, refreshPipelines);
					}
					// EventSource auto-reconnects and resumes via Last-Event-ID while
					// CONNECTING; scheduleRetry only covers the terminal CLOSED state.
				} catch {
					source = undefined;
				}
			};

			const removeDaemonListener = aoBridge.daemon.onStatus(() => {
				connectSource();
				refreshWorkspaces();
				// A daemon (re)start can flip the AO_PIPELINES flag (T12's
				// settings/pipelines toggle restarts the daemon to apply it), so
				// re-probe capability every time instead of trusting the cached
				// value for the app's whole lifetime.
				void queryClient.invalidateQueries({ queryKey: pipelinesEnabledQueryKey });
			});
			// Rebind when the daemon comes back on a different port, independent of
			// status-event ordering.
			const removeBaseUrlListener = subscribeApiBaseUrl(connectSource);
			connectSource();

			return () => {
				if (debounce) clearTimeout(debounce);
				if (pipelineDebounce) clearTimeout(pipelineDebounce);
				if (retryTimer) clearTimeout(retryTimer);
				removeDaemonListener();
				removeBaseUrlListener();
				source?.close();
				setEventsConnectionState("idle");
			};
		},
	};
}
