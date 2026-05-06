import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInitialCanonicalLifecycle, createActivitySignal, type Session } from "@aoagents/ao-core";
import { manifest, create } from "./index.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  const lifecycle = createInitialCanonicalLifecycle("worker", new Date());
  lifecycle.session.state = "working";
  lifecycle.session.reason = "task_in_progress";
  lifecycle.session.startedAt = lifecycle.session.lastTransitionAt;
  lifecycle.runtime.state = "alive";
  lifecycle.runtime.reason = "process_running";
  return {
    id: "app-1",
    projectId: "my-project",
    status: "working",
    activity: "active",
    activitySignal: createActivitySignal("valid", {
      activity: "active",
      timestamp: new Date(),
      source: "native",
    }),
    lifecycle,
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/workspace",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

describe("terminal-web", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("web");
      expect(manifest.slot).toBe("terminal");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("create", () => {
    it("returns a terminal with name 'web'", () => {
      const terminal = create();
      expect(terminal.name).toBe("web");
    });

    it("has openSession, openAll, and isSessionOpen methods", () => {
      const terminal = create();
      expect(typeof terminal.openSession).toBe("function");
      expect(typeof terminal.openAll).toBe("function");
      expect(typeof terminal.isSessionOpen).toBe("function");
    });
  });

  describe("openSession", () => {
    it("marks session as open", async () => {
      const terminal = create();
      const session = makeSession({ id: "app-1" });

      expect(await terminal.isSessionOpen!(session)).toBe(false);
      await terminal.openSession(session);
      expect(await terminal.isSessionOpen!(session)).toBe(true);
    });

    it("logs the terminal URL", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const terminal = create();
      await terminal.openSession(makeSession({ id: "backend-3" }));

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("backend-3"));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("/sessions/backend-3/terminal"));
    });

    it("uses default dashboard URL", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const terminal = create();
      await terminal.openSession(makeSession());

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("http://localhost:3000"));
    });

    it("uses custom dashboard URL", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const terminal = create({ dashboardUrl: "https://my-dashboard.io" });
      await terminal.openSession(makeSession());

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("https://my-dashboard.io"));
    });
  });

  describe("openAll", () => {
    it("marks all sessions as open", async () => {
      const terminal = create();
      const sessions = [
        makeSession({ id: "app-1" }),
        makeSession({ id: "app-2" }),
        makeSession({ id: "app-3" }),
      ];

      await terminal.openAll(sessions);

      for (const session of sessions) {
        expect(await terminal.isSessionOpen!(session)).toBe(true);
      }
    });

    it("handles empty sessions list", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const terminal = create();
      await terminal.openAll([]);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("0 sessions"));
    });

    it("logs the count of sessions", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const terminal = create();
      await terminal.openAll([makeSession({ id: "a" }), makeSession({ id: "b" })]);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("2 sessions"));
    });
  });

  describe("isSessionOpen", () => {
    it("returns false for sessions never opened", async () => {
      const terminal = create();
      expect(await terminal.isSessionOpen!(makeSession({ id: "never-opened" }))).toBe(false);
    });

    it("returns true only for sessions that were opened", async () => {
      const terminal = create();
      const s1 = makeSession({ id: "opened-1" });
      const s2 = makeSession({ id: "not-opened" });

      await terminal.openSession(s1);

      expect(await terminal.isSessionOpen!(s1)).toBe(true);
      expect(await terminal.isSessionOpen!(s2)).toBe(false);
    });

    it("tracks sessions independently across openSession and openAll", async () => {
      const terminal = create();
      const s1 = makeSession({ id: "single" });
      const s2 = makeSession({ id: "batch-a" });
      const s3 = makeSession({ id: "batch-b" });
      const s4 = makeSession({ id: "never" });

      await terminal.openSession(s1);
      await terminal.openAll([s2, s3]);

      expect(await terminal.isSessionOpen!(s1)).toBe(true);
      expect(await terminal.isSessionOpen!(s2)).toBe(true);
      expect(await terminal.isSessionOpen!(s3)).toBe(true);
      expect(await terminal.isSessionOpen!(s4)).toBe(false);
    });
  });
});
