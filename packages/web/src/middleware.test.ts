import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

function request(
  path: string,
  authorization?: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: { ...headers, ...(authorization ? { authorization } : {}) },
  });
}

function requestWithIp(path: string, ip: string, authorization?: string): NextRequest {
  const req = request(path, authorization);
  Object.defineProperty(req, "ip", { value: ip });
  return req;
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

describe("remote auth middleware", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does nothing when remote auth is not configured", () => {
    vi.stubEnv("AO_REMOTE_AUTH_PASSWORD", "");

    const response = middleware(request("/api/projects"));

    expect(response.status).toBe(200);
  });

  it("requires basic auth when a remote password is configured", () => {
    vi.stubEnv("AO_REMOTE_AUTH_USER", "ao");
    vi.stubEnv("AO_REMOTE_AUTH_PASSWORD", "secret");

    const response = middleware(request("/api/projects"));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="AO Remote"');
  });

  it("accepts matching basic auth credentials", () => {
    vi.stubEnv("AO_REMOTE_AUTH_USER", "ao");
    vi.stubEnv("AO_REMOTE_AUTH_PASSWORD", "secret");

    const response = middleware(request("/api/projects", basic("ao", "secret")));

    expect(response.status).toBe(200);
  });

  it("rejects same-length incorrect basic auth credentials", () => {
    vi.stubEnv("AO_REMOTE_AUTH_USER", "ao");
    vi.stubEnv("AO_REMOTE_AUTH_PASSWORD", "secret");

    const response = middleware(request("/api/projects", basic("ao", "secrex")));

    expect(response.status).toBe(401);
  });

  it("does not trust a spoofed localhost Host header", () => {
    vi.stubEnv("AO_REMOTE_AUTH_USER", "ao");
    vi.stubEnv("AO_REMOTE_AUTH_PASSWORD", "secret");

    const response = middleware(request("/api/projects", undefined, { host: "localhost:3000" }));

    expect(response.status).toBe(401);
  });

  it("allows loopback socket addresses without credentials", () => {
    vi.stubEnv("AO_REMOTE_AUTH_USER", "ao");
    vi.stubEnv("AO_REMOTE_AUTH_PASSWORD", "secret");

    const response = middleware(requestWithIp("/api/projects", "127.0.0.1"));

    expect(response.status).toBe(200);
  });

  it("allows the AO-injected loopback socket header", () => {
    vi.stubEnv("AO_REMOTE_AUTH_USER", "ao");
    vi.stubEnv("AO_REMOTE_AUTH_PASSWORD", "secret");
    vi.stubEnv("AO_TRUST_REMOTE_ADDRESS_HEADER", "1");

    const response = middleware(
      request("/api/projects", undefined, { "x-ao-remote-address": "::1" }),
    );

    expect(response.status).toBe(200);
  });

  it("requires credentials for proxied requests even when the socket is loopback", () => {
    vi.stubEnv("AO_REMOTE_AUTH_USER", "ao");
    vi.stubEnv("AO_REMOTE_AUTH_PASSWORD", "secret");
    vi.stubEnv("AO_TRUST_REMOTE_ADDRESS_HEADER", "1");

    const response = middleware(
      request("/api/projects", undefined, {
        "x-ao-remote-address": "127.0.0.1",
        "x-forwarded-for": "203.0.113.10",
      }),
    );

    expect(response.status).toBe(401);
  });

  it("allows loopback forwarded addresses from the local Next server", () => {
    vi.stubEnv("AO_REMOTE_AUTH_USER", "ao");
    vi.stubEnv("AO_REMOTE_AUTH_PASSWORD", "secret");
    vi.stubEnv("AO_TRUST_REMOTE_ADDRESS_HEADER", "1");

    const response = middleware(
      request("/api/projects", undefined, {
        "x-ao-remote-address": "::ffff:127.0.0.1",
        "x-forwarded-for": "::ffff:127.0.0.1",
      }),
    );

    expect(response.status).toBe(200);
  });

  it("requires credentials for Cloudflare-proxied requests from loopback", () => {
    vi.stubEnv("AO_REMOTE_AUTH_USER", "ao");
    vi.stubEnv("AO_REMOTE_AUTH_PASSWORD", "secret");
    vi.stubEnv("AO_TRUST_REMOTE_ADDRESS_HEADER", "1");

    const response = middleware(
      request("/api/projects", undefined, {
        "x-ao-remote-address": "::1",
        "cf-connecting-ip": "203.0.113.10",
      }),
    );

    expect(response.status).toBe(401);
  });

  it("ignores the loopback socket header unless the AO server marked it trusted", () => {
    vi.stubEnv("AO_REMOTE_AUTH_USER", "ao");
    vi.stubEnv("AO_REMOTE_AUTH_PASSWORD", "secret");

    const response = middleware(
      request("/api/projects", undefined, { "x-ao-remote-address": "127.0.0.1" }),
    );

    expect(response.status).toBe(401);
  });

  it("allows public Next assets without credentials", () => {
    vi.stubEnv("AO_REMOTE_AUTH_USER", "ao");
    vi.stubEnv("AO_REMOTE_AUTH_PASSWORD", "secret");

    const response = middleware(request("/_next/static/chunk.js"));

    expect(response.status).toBe(200);
  });
});
