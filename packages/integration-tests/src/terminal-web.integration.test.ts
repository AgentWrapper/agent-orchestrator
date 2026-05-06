/**
 * Integration tests for terminal-web.
 *
 * No I/O mocking needed — this plugin has no external I/O.
 * Tests verify state tracking, URL construction, and log output.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import webPlugin from "@aoagents/ao-plugin-terminal-web";
import { makeSession } from "./helpers/event-factory.js";

describe("terminal-web integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("state tracking", () => {
    it("isSessionOpen returns false before openSession, true after", async () => {
      const terminal = webPlugin.create();
      const session = makeSession({ id: "track-1" });

      expect(await terminal.isSessionOpen!(session)).toBe(false);
      await terminal.openSession(session);
      expect(await terminal.isSessionOpen!(session)).toBe(true);
    });

    it("openAll marks all sessions as open", async () => {
      const terminal = webPlugin.create();
      const sessions = [
        makeSession({ id: "a" }),
        makeSession({ id: "b" }),
        makeSession({ id: "c" }),
      ];

      await terminal.openAll(sessions);

      for (const s of sessions) {
        expect(await terminal.isSessionOpen!(s)).toBe(true);
      }
    });

    it("tracks sessions independently across openSession and openAll", async () => {
      const terminal = webPlugin.create();
      const single = makeSession({ id: "single" });
      const batchA = makeSession({ id: "batch-a" });
      const batchB = makeSession({ id: "batch-b" });
      const never = makeSession({ id: "never" });

      await terminal.openSession(single);
      await terminal.openAll([batchA, batchB]);

      expect(await terminal.isSessionOpen!(single)).toBe(true);
      expect(await terminal.isSessionOpen!(batchA)).toBe(true);
      expect(await terminal.isSessionOpen!(batchB)).toBe(true);
      expect(await terminal.isSessionOpen!(never)).toBe(false);
    });
  });

  describe("URL construction", () => {
    it("default dashboard URL uses port 3000", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const terminal = webPlugin.create();
      await terminal.openSession(makeSession({ id: "url-test" }));

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("http://localhost:3000/sessions/url-test/terminal"),
      );
    });

    it("custom dashboard URL is used in log output", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const terminal = webPlugin.create({ dashboardUrl: "https://my-dash.io:8080" });
      await terminal.openSession(makeSession({ id: "custom-url" }));

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("https://my-dash.io:8080/sessions/custom-url/terminal"),
      );
    });

    it("openAll logs total count and dashboard URL", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const terminal = webPlugin.create({ dashboardUrl: "https://dashboard.io" });
      await terminal.openAll([makeSession({ id: "x" }), makeSession({ id: "y" })]);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("2 sessions"));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("https://dashboard.io/sessions"));
    });
  });

  describe("empty sessions", () => {
    it("openAll handles empty array", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const terminal = webPlugin.create();
      await terminal.openAll([]);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("0 sessions"));
    });
  });
});
