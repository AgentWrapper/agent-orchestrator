// packages/shared/src/lib/event-transport.ts
import type { QueryClient } from '@tanstack/react-query';
import { getPlatformBridge } from './bridge';
import { setEventsConnectionState } from './events-connection';
import { WORKSPACE_QUERY_KEY } from '../hooks/useWorkspaceQuery';

export type EventTransport = {
  connect: () => () => void;
};

const INVALIDATE_DEBOUNCE_MS = 150;
const SSE_RETRY_MS = 5_000;
const EVENTSOURCE_CLOSED = 2;

const CDC_EVENT_TYPES = [
  'session_created',
  'session_updated',
  'pr_created',
  'pr_updated',
  'pr_check_recorded',
  'pr_session_changed',
  'pr_review_thread_added',
  'pr_review_thread_resolved',
] as const;

export function createEventTransport(queryClient: QueryClient): EventTransport {
  return {
    connect() {
      let debounce: ReturnType<typeof setTimeout> | undefined;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let source: EventSource | undefined;
      let sourceBaseUrl: string | undefined;

      const refreshWorkspaces = () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
        }, INVALIDATE_DEBOUNCE_MS);
      };

      const scheduleRetry = () => {
        if (retryTimer) return;
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          connectSource();
        }, SSE_RETRY_MS);
      };

      const bridge = getPlatformBridge();

      const connectSource = () => {
        if (typeof EventSource === 'undefined') return;
        const baseUrl = bridge.getApiBaseUrl();
        if (source && sourceBaseUrl === baseUrl && source.readyState !== EVENTSOURCE_CLOSED) return;
        source?.close();
        source = undefined;
        sourceBaseUrl = baseUrl;
        try {
          source = new EventSource(`${baseUrl.replace(/\/+$/, '')}/api/v1/events`);
          source.onopen = () => {
            setEventsConnectionState('connected');
            refreshWorkspaces();
          };
          source.onerror = () => {
            setEventsConnectionState('disconnected');
            if (source?.readyState === EVENTSOURCE_CLOSED) scheduleRetry();
          };
          source.onmessage = refreshWorkspaces;
          for (const type of CDC_EVENT_TYPES) {
            source.addEventListener(type, refreshWorkspaces);
          }
        } catch {
          source = undefined;
        }
      };

      const removeBaseUrlListener = bridge.subscribeApiBaseUrl(connectSource);
      connectSource();

      return () => {
        if (debounce) clearTimeout(debounce);
        if (retryTimer) clearTimeout(retryTimer);
        removeBaseUrlListener();
        source?.close();
        setEventsConnectionState('idle');
      };
    },
  };
}
