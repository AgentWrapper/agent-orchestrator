import { getMockDashboardPayload } from "@/lib/mock-dashboard-data";

export const dynamic = "force-dynamic";

type SseEvent = {
  event: string;
  data: unknown;
};

function encodeEvent({ event, data }: SseEvent): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** GET /api/events — SSE stream for dashboard refresh events. */
export function GET() {
  // TODO: wire to core services event bus once lifecycle updates are emitted centrally.
  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: SseEvent) => controller.enqueue(encoder.encode(encodeEvent(event)));
      const payload = getMockDashboardPayload();

      send({ event: "connected", data: { ok: true, timestamp: new Date().toISOString() } });
      send({
        event: "sessions",
        data: { sessions: payload.sessions, stats: payload.stats },
      });

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
