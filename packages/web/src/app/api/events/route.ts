import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import { toSSEEntry, computeDiff } from "@/lib/sse-diff";
import type { SSESessionEntry } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/events — SSE stream for real-time lifecycle events
 *
 * Sends an initial full snapshot, then diff-based updates that only include
 * sessions whose state has changed, plus IDs of sessions that were removed.
 * Polls SessionManager.list() on an interval (no SSE push from core yet).
 */
export async function GET(): Promise<Response> {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let updates: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      // Previous snapshot for diff computation — starts empty so the first
      // poll always produces a full snapshot.
      let prevSnapshot = new Map<string, SSESessionEntry>();
      // Gate polling on initial snapshot completion to avoid racing.
      let initialized = false;

      // Send initial snapshot
      void (async () => {
        try {
          const { sessionManager } = await getServices();
          const sessions = await sessionManager.list();
          const entries = sessions.map(sessionToDashboard).map(toSSEEntry);

          const initialEvent = {
            type: "snapshot" as const,
            sessions: entries,
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialEvent)}\n\n`));

          // Seed the previous snapshot so the next poll can diff against it
          prevSnapshot = new Map(entries.map((e) => [e.id, e]));
        } catch {
          // If services aren't available, send empty snapshot
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "snapshot", sessions: [] })}\n\n`),
          );
        }
        initialized = true;
      })();

      // Send periodic heartbeat
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
          clearInterval(updates);
        }
      }, 15000);

      // Poll for session state changes every 5 seconds
      updates = setInterval(() => {
        void (async () => {
          // Wait for the initial snapshot before computing diffs
          if (!initialized) return;

          let entries: SSESessionEntry[];
          try {
            const { sessionManager } = await getServices();
            const sessions = await sessionManager.list();
            entries = sessions.map(sessionToDashboard).map(toSSEEntry);
          } catch {
            // Transient service error — skip this poll, retry on next interval
            return;
          }

          try {
            const diff = computeDiff(prevSnapshot, entries);

            // Only send an event if something actually changed
            if (diff !== null) {
              const event = {
                type: "diff" as const,
                updated: diff.updated,
                removed: diff.removed,
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }

            // Update the previous snapshot for the next diff
            prevSnapshot = new Map(entries.map((e) => [e.id, e]));
          } catch {
            // enqueue failure means the stream is closed — clean up both intervals
            clearInterval(updates);
            clearInterval(heartbeat);
          }
        })();
      }, 5000);
    },
    cancel() {
      clearInterval(heartbeat);
      clearInterval(updates);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
