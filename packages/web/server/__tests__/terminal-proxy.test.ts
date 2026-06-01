import { describe, expect, it } from "vitest";
import { type IncomingMessage } from "node:http";
import { buildWebSocketUpgradeHeaders, getTerminalProxyTarget } from "../terminal-proxy.js";

function request(headers: IncomingMessage["headers"]): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("terminal proxy", () => {
  it("maps public terminal proxy paths to direct terminal paths", () => {
    expect(getTerminalProxyTarget("/ao-terminal-mux?auth_token=token")).toBe(
      "/mux?auth_token=token",
    );
    expect(getTerminalProxyTarget("/ao-terminal/health")).toBe("/health");
    expect(getTerminalProxyTarget("/other")).toBeNull();
  });

  it("forwards only WebSocket upgrade headers needed by the direct terminal child", () => {
    const headers = buildWebSocketUpgradeHeaders(
      request({
        host: "localhost:3000",
        upgrade: "websocket",
        connection: "Upgrade",
        authorization: "Basic secret",
        cookie: "session=secret",
        "proxy-authorization": "Basic proxy-secret",
        "sec-websocket-key": "abc",
        "sec-websocket-version": "13",
        "sec-websocket-protocol": ["mux.v1", "fallback"] as unknown as string,
        "x-forwarded-for": "203.0.113.10",
        "x-ao-remote-address": "127.0.0.1",
      }),
    );

    expect(headers).toContain("host: localhost:3000");
    expect(headers).toContain("upgrade: websocket");
    expect(headers).toContain("connection: Upgrade");
    expect(headers).toContain("sec-websocket-key: abc");
    expect(headers).toContain("sec-websocket-version: 13");
    expect(headers).toContain("sec-websocket-protocol: mux.v1");
    expect(headers).toContain("sec-websocket-protocol: fallback");
    expect(headers).toContain("x-ao-remote-address: 127.0.0.1");
    expect(headers).not.toContain("authorization:");
    expect(headers).not.toContain("cookie:");
    expect(headers).not.toContain("proxy-authorization:");
    expect(headers).not.toContain("x-forwarded-for:");
  });
});
