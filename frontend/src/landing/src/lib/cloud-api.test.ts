import { afterEach, expect, it, vi } from "vitest";

import { CloudAPI, type CloudEvent } from "./cloud-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("streams replayed and live SSE events with authenticated fetch", async () => {
  const encoder = new TextEncoder();
  const responseBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'id: 7\nevent: chat.assistant_delta\ndata: {"sessionId":"session-one","sequence":7,',
        ),
      );
      controller.enqueue(
        encoder.encode(
          '"type":"chat.assistant_delta","payload":{"text":"Hello"},"createdAt":"2026-07-30T00:00:00Z"}\n\n: keepalive\n\n',
        ),
      );
      controller.close();
    },
  });
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(responseBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const api = Object.assign(Object.create(CloudAPI.prototype) as CloudAPI, {
    baseURL: "https://cloud.example.com",
    accessToken: "access-token",
  });
  const events: CloudEvent[] = [];

  await api.streamEvents(
    "session-one",
    4,
    new AbortController().signal,
    (event) => events.push(event),
  );

  expect(events).toEqual([
    expect.objectContaining({
      sequence: 7,
      type: "chat.assistant_delta",
      payload: { text: "Hello" },
    }),
  ]);
  const [request, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
  expect(request.toString()).toBe(
    "https://cloud.example.com/api/cloud/v1/sessions/session-one/events?after=4",
  );
  expect(new Headers(init.headers).get("Authorization")).toBe(
    "Bearer access-token",
  );
});
