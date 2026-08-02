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
  const onActivity = vi.fn();

  await api.streamEvents(
    "org-one",
    "session-one",
    4,
    new AbortController().signal,
    (event) => events.push(event),
    onActivity,
  );

  expect(events).toEqual([
    expect.objectContaining({
      sequence: 7,
      type: "chat.assistant_delta",
      payload: { text: "Hello" },
    }),
  ]);
  expect(onActivity).toHaveBeenCalled();
  const [request, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
  expect(request.toString()).toBe(
    "https://cloud.example.com/api/cloud/v1/orgs/org-one/sessions/session-one/events?after=4",
  );
  expect(new Headers(init.headers).get("Authorization")).toBe(
    "Bearer access-token",
  );
});

it("interrupts an active cloud session", async () => {
  const interruptEvent: CloudEvent = {
    sessionId: "session one",
    sequence: 8,
    type: "chat.interrupt_requested",
    payload: { source: "browser" },
    createdAt: "2026-07-30T00:00:00Z",
  };
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ event: interruptEvent }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const api = Object.assign(Object.create(CloudAPI.prototype) as CloudAPI, {
    baseURL: "https://cloud.example.com",
    accessToken: "access-token",
  });

  await expect(api.interruptSession("org one", "session one")).resolves.toEqual({
    event: interruptEvent,
  });

  const [request, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(request).toBe(
    "https://cloud.example.com/api/cloud/v1/orgs/org%20one/sessions/session%20one/interrupt",
  );
  expect(init.method).toBe("POST");
});

it("creates and updates organizations with authenticated requests", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({ organization: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ).mockResolvedValueOnce(
    new Response(JSON.stringify({ organization: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const api = Object.assign(Object.create(CloudAPI.prototype) as CloudAPI, {
    baseURL: "https://cloud.example.com",
    accessToken: "access-token",
  });

  await api.createOrganization({ displayName: "Team Alpha" });
  await api.updateOrganization("org one", { displayName: "Team Renamed" });

  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    "https://cloud.example.com/api/cloud/v1/orgs",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ displayName: "Team Alpha" }),
    }),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "https://cloud.example.com/api/cloud/v1/orgs/org%20one/",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ displayName: "Team Renamed" }),
    }),
  );
});

it("updates the current user profile", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ user: { displayName: "Nihal" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const api = Object.assign(Object.create(CloudAPI.prototype) as CloudAPI, {
    baseURL: "https://cloud.example.com",
    accessToken: "access-token",
  });

  await api.updateProfile({ displayName: "Nihal" });

  expect(fetchMock).toHaveBeenCalledWith(
    "https://cloud.example.com/api/cloud/v1/me",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ displayName: "Nihal" }),
    }),
  );
});

it("lists org members and updates member roles", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({ members: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ).mockResolvedValueOnce(
    new Response(JSON.stringify({ member: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const api = Object.assign(Object.create(CloudAPI.prototype) as CloudAPI, {
    baseURL: "https://cloud.example.com",
    accessToken: "access-token",
  });

  await api.orgMembers("org one");
  await api.updateOrgMemberRole("org one", "user two", { role: "member" });

  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    "https://cloud.example.com/api/cloud/v1/orgs/org%20one/members",
    expect.any(Object),
  );
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "https://cloud.example.com/api/cloud/v1/orgs/org%20one/members/user%20two",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ role: "member" }),
    }),
  );
});
