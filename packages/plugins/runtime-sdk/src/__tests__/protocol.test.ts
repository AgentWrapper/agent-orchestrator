import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertValidSessionId,
  sessionPaths,
  socketAddress,
  socketRoot,
  socketNameComponent,
  sdkHome,
  encodeLine,
  LineParser,
} from "../protocol.js";

describe("session id validation", () => {
  it("accepts alphanumeric / _ / - ids", () => {
    expect(() => assertValidSessionId("aof-10_x")).not.toThrow();
  });
  it("rejects ids with path separators or spaces", () => {
    expect(() => assertValidSessionId("a/b")).toThrow();
    expect(() => assertValidSessionId("a b")).toThrow();
    expect(() => assertValidSessionId("../x")).toThrow();
  });
});

describe("path derivation", () => {
  const saved = { AO_SDK_HOME: process.env.AO_SDK_HOME, AO_HOME: process.env.AO_HOME };
  beforeEach(() => {
    delete process.env.AO_SDK_HOME;
    delete process.env.AO_HOME;
  });
  afterEach(() => {
    process.env.AO_SDK_HOME = saved.AO_SDK_HOME;
    process.env.AO_HOME = saved.AO_HOME;
    if (saved.AO_SDK_HOME === undefined) delete process.env.AO_SDK_HOME;
    if (saved.AO_HOME === undefined) delete process.env.AO_HOME;
  });

  it("defaults to ~/.agent-orchestrator/runtime-sdk", () => {
    expect(sdkHome()).toBe(join(homedir(), ".agent-orchestrator", "runtime-sdk"));
  });

  it("honors AO_HOME then AO_SDK_HOME overrides", () => {
    process.env.AO_HOME = "/custom/ao";
    expect(sdkHome()).toBe(join("/custom/ao", "runtime-sdk"));
    process.env.AO_SDK_HOME = "/explicit/sdk";
    expect(sdkHome()).toBe("/explicit/sdk");
  });

  it("derives per-session paths from the AO session id", () => {
    process.env.AO_SDK_HOME = "/base";
    const p = sessionPaths("sess1");
    expect(p.base).toBe(join("/base", "sess1"));
    expect(p.eventLog).toBe(join("/base", "sess1", "events.ndjson"));
    expect(p.sessionInfo).toBe(join("/base", "sess1", "session.json"));
  });

  it("derives a deterministic, short, hashed socket address", () => {
    const name = socketNameComponent("sess1");
    expect(name).toMatch(/^[0-9a-f]{16}$/);
    expect(socketNameComponent("sess1")).toBe(name); // deterministic
    expect(socketNameComponent("sess2")).not.toBe(name); // id-sensitive

    if (process.platform === "win32") {
      expect(socketAddress("sess1")).toBe(`\\\\.\\pipe\\ao-sdk-${name}`);
    } else {
      expect(socketAddress("sess1")).toBe(join(socketRoot(), `${name}.sock`));
    }
  });

  it("socket root defaults to ~/.ao-sdk and honors AO_SDK_SOCK_DIR", () => {
    delete process.env.AO_SDK_SOCK_DIR;
    expect(socketRoot()).toBe(join(homedir(), ".ao-sdk"));
    expect(socketRoot({ AO_SDK_SOCK_DIR: "/run/ao" })).toBe("/run/ao");
  });

  it("keeps the POSIX socket path well under the sockaddr_un limit for long ids", () => {
    if (process.platform === "win32") return;
    const longId = "a".repeat(120);
    const addr = socketAddress(longId, { AO_SDK_SOCK_DIR: "/tmp/ao-sock" });
    expect(Buffer.byteLength(addr)).toBeLessThan(104);
  });
});

describe("NDJSON line framing", () => {
  it("encodeLine emits a single newline-terminated JSON object", () => {
    expect(encodeLine({ a: 1 })).toBe('{"a":1}\n');
  });

  it("LineParser emits one object per complete line and buffers partials", () => {
    const got: unknown[] = [];
    const parser = new LineParser((o) => got.push(o));
    parser.feed('{"x":1}\n{"y":2}\n{"z":');
    expect(got).toEqual([{ x: 1 }, { y: 2 }]);
    parser.feed("3}\n");
    expect(got).toEqual([{ x: 1 }, { y: 2 }, { z: 3 }]);
  });

  it("LineParser skips malformed and blank lines", () => {
    const got: unknown[] = [];
    const parser = new LineParser((o) => got.push(o));
    parser.feed("not json\n\n{\"ok\":true}\n");
    expect(got).toEqual([{ ok: true }]);
  });
});
