import { getMockDashboardPayload, isMockDashboardRequested } from "@/lib/mock-dashboard-data";

export const dynamic = "force-dynamic";

type SseEvent = {
  event: string;
  data: unknown;
};

function encodeEvent({ event, data }: SseEvent): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** GET /api/events — SSE stream for dashboard refresh events. */
export function GET(request: Request) {
  const shouldUseMockData = isMockDashboardRequested(request.url);
  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        if (interval) {
          clearInterval(interval);
          interval = undefined;
        }
      };
      const send = (event: SseEvent): boolean => {
        try {
          controller.enqueue(encoder.encode(encodeEvent(event)));
          return true;
        } catch (error) {
          cleanup();
          controller.error(error);
          return false;
        }
      };

      // TODO: wire to core services event bus once lifecycle updates are emitted centrally.
      const connected = send({
        event: "connected",
        data: {
          ok: true,
          mode: shouldUseMockData ? "mock" : "live",
          timestamp: new Date().toISOString(),
        },
      });
      if (!connected) return;

      if (shouldUseMockData) {
        const payload = getMockDashboardPayload();
        const sentSessions = send({
          event: "sessions",
          data: { sessions: payload.sessions, stats: payload.stats },
        });
        if (!sentSessions) return;
      }

      interval = setInterval(() => {
        send({ event: "heartbeat", data: { timestamp: new Date().toISOString() } });
      }, 5_000);
    },
    cancel() {
      if (interval) clearInterval(interval);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
