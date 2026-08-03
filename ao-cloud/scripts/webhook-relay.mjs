#!/usr/bin/env node

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WEBHOOK_PATH = "/api/cloud/v1/github/webhooks";
export const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;

const forwardedHeaders = new Set([
  "content-type",
  "user-agent",
  "x-github-delivery",
  "x-github-event",
  "x-github-hook-id",
  "x-github-hook-installation-target-id",
  "x-github-hook-installation-target-type",
  "x-hub-signature-256",
]);

class BodyTooLargeError extends Error {}

function readBoundedBody(request, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        fail(new BodyTooLargeError("webhook body exceeds configured limit"));
        request.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onError = (error) => fail(error);
    const onAborted = () => fail(new Error("request aborted"));

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
  });
}

function targetHeaders(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (!forwardedHeaders.has(name) || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

function writeText(response, statusCode, message) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(message),
    "cache-control": "no-store",
  });
  response.end(message);
}

export function createWebhookRelay({
  target = "http://127.0.0.1:3010/api/cloud/v1/github/webhooks",
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  requestTimeoutMs = 10_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const targetURL = new URL(target);
  if (
    targetURL.protocol !== "http:" ||
    !["127.0.0.1", "::1", "localhost"].includes(targetURL.hostname) ||
    targetURL.pathname !== WEBHOOK_PATH ||
    targetURL.search !== ""
  ) {
    throw new Error(`webhook relay target must be a loopback HTTP ${WEBHOOK_PATH} URL`);
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("maxBodyBytes must be a positive integer");
  }

  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== WEBHOOK_PATH) {
      writeText(response, 404, "Not found\n");
      return;
    }
    const declaredLength = Number.parseInt(request.headers["content-length"] ?? "0", 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      request.resume();
      writeText(response, 413, "Webhook body too large\n");
      return;
    }

    let body;
    try {
      body = await readBoundedBody(request, maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        writeText(response, 413, "Webhook body too large\n");
        return;
      }
      writeText(response, 400, "Invalid webhook request\n");
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    timeout.unref();
    try {
      const upstream = await fetchImpl(targetURL, {
        method: "POST",
        headers: targetHeaders(request),
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      const upstreamBody = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get("content-type");
      response.writeHead(upstream.status, {
        ...(contentType ? { "content-type": contentType } : {}),
        "content-length": upstreamBody.length,
        "cache-control": "no-store",
      });
      response.end(upstreamBody);
    } catch {
      writeText(response, 502, "Webhook upstream unavailable\n");
    } finally {
      clearTimeout(timeout);
    }
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return server;
}

function parseListenAddress(value) {
  const separator = value.lastIndexOf(":");
  if (separator <= 0) throw new Error("AO_GITHUB_WEBHOOK_RELAY_ADDR must be host:port");
  const host = value.slice(0, separator);
  const port = Number.parseInt(value.slice(separator + 1), 10);
  if (!["127.0.0.1", "localhost"].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("AO_GITHUB_WEBHOOK_RELAY_ADDR must use loopback and a valid port");
  }
  return { host, port };
}

async function main() {
  const { host, port } = parseListenAddress(
    process.env.AO_GITHUB_WEBHOOK_RELAY_ADDR ?? "127.0.0.1:3011",
  );
  const server = createWebhookRelay({
    target:
      process.env.AO_GITHUB_WEBHOOK_TARGET ??
      "http://127.0.0.1:3010/api/cloud/v1/github/webhooks",
  });
  server.on("error", (error) => {
    console.error(`Webhook relay failed: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`Webhook relay listening on http://${host}:${port}${WEBHOOK_PATH}`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
