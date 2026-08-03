import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";

import { WEBHOOK_PATH, createWebhookRelay } from "./webhook-relay.mjs";

const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
        }),
    ),
  );
});

async function listen(server) {
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

function request(port, { method = "POST", path = WEBHOOK_PATH, headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      { host: "127.0.0.1", port, method, path, headers },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

test("forwards only the exact webhook POST and allowlisted headers", async () => {
  const calls = [];
  const relay = createWebhookRelay({
    fetchImpl: async (url, init) => {
      calls.push({
        url: url.toString(),
        method: init.method,
        event: init.headers.get("x-github-event"),
        authorization: init.headers.get("authorization"),
        body: init.body.toString("utf8"),
      });
      return new Response("accepted", { status: 202 });
    },
  });
  const port = await listen(relay);

  const wrongMethod = await request(port, { method: "GET" });
  const wrongPath = await request(port, { path: `${WEBHOOK_PATH}?debug=1` });
  const forwarded = await request(port, {
    headers: {
      "content-type": "application/json",
      "x-github-event": "installation",
      "x-hub-signature-256": "sha256=example",
      authorization: "must-not-be-forwarded",
    },
    body: '{"installation":{"id":123}}',
  });

  assert.equal(wrongMethod.status, 404);
  assert.equal(wrongPath.status, 404);
  assert.deepEqual(forwarded, { status: 202, body: "accepted" });
  assert.deepEqual(calls, [
    {
      url: `http://127.0.0.1:3010${WEBHOOK_PATH}`,
      method: "POST",
      event: "installation",
      authorization: null,
      body: '{"installation":{"id":123}}',
    },
  ]);
});

test("rejects webhook bodies over the configured bound", async () => {
  let forwarded = false;
  const relay = createWebhookRelay({
    maxBodyBytes: 4,
    fetchImpl: async () => {
      forwarded = true;
      return new Response(null, { status: 204 });
    },
  });
  const port = await listen(relay);

  const response = await request(port, {
    headers: { "content-length": "5" },
    body: "12345",
  });

  assert.equal(response.status, 413);
  assert.equal(forwarded, false);
});

test("rejects non-loopback or non-webhook upstream targets", () => {
  assert.throws(
    () => createWebhookRelay({ target: "https://example.com/api/cloud/v1/github/webhooks" }),
    /loopback HTTP/,
  );
  assert.throws(
    () => createWebhookRelay({ target: "http://127.0.0.1:3010/readyz" }),
    /loopback HTTP/,
  );
});
