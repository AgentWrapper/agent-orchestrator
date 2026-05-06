/**
 * Integration tests for notifier-desktop.
 *
 * Mocks ONLY the I/O boundary: node:child_process and node:os.
 * Everything else runs for real: config parsing, escaping chains, formatting.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { NotifyAction } from "@aoagents/ao-core";
import { makeEvent } from "./helpers/event-factory.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:os", () => ({
  platform: vi.fn(() => "darwin"),
}));

import { execFile } from "node:child_process";
import { platform } from "node:os";

const mockExecFile = execFile as unknown as Mock;
const mockPlatform = platform as unknown as Mock;

// Import the full plugin module — config parsing, escaping, formatting all run for real
import desktopPlugin from "@aoagents/ao-plugin-notifier-desktop";

describe("notifier-desktop integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatform.mockReturnValue("darwin");
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
        cb(null);
      },
    );
  });

  describe("config -> behavior flow", () => {
    it("sound=false config + urgent event -> no sound clause in osascript", async () => {
      const notifier = desktopPlugin.create({ sound: false });
      await notifier.notify(makeEvent({ priority: "urgent" }));

      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).not.toContain("sound name");
      expect(script).toContain("URGENT");
    });

    it("default config + urgent event -> sound clause present", async () => {
      const notifier = desktopPlugin.create();
      await notifier.notify(makeEvent({ priority: "urgent" }));

      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).toContain('sound name "default"');
    });

    it("default config + info event -> no sound clause", async () => {
      const notifier = desktopPlugin.create();
      await notifier.notify(makeEvent({ priority: "info" }));

      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).not.toContain("sound name");
    });

    it("sound=true config behaves same as default", async () => {
      const notifier = desktopPlugin.create({ sound: true });
      await notifier.notify(makeEvent({ priority: "urgent" }));

      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).toContain('sound name "default"');
    });
  });

  describe("escaping chain integrity", () => {
    it("handles double quotes, backslashes, and single quotes simultaneously", async () => {
      const notifier = desktopPlugin.create();
      const nastySession = `test"with\\back'slash`;
      const nastyMessage = `msg "has" all\\the'chars`;

      await notifier.notify(makeEvent({ sessionId: nastySession, message: nastyMessage }));

      const script = mockExecFile.mock.calls[0][1][1] as string;

      // AppleScript escaping: " -> \" and \ -> \\
      expect(script).toContain('test\\"with\\\\back');
      expect(script).toContain('msg \\"has\\" all\\\\the');

      // The script should be valid AppleScript structure
      expect(script).toContain("display notification");
      expect(script).toContain("with title");
    });

    it("escapes newlines in message text (renders literally in notification)", async () => {
      const notifier = desktopPlugin.create();
      await notifier.notify(makeEvent({ message: "line1\nline2" }));

      const script = mockExecFile.mock.calls[0][1][1] as string;
      // newlines in AppleScript strings are ok, they render as literal newlines
      expect(script).toContain("line1\nline2");
    });
  });

  describe("platform routing", () => {
    it("darwin -> osascript with -e flag", async () => {
      mockPlatform.mockReturnValue("darwin");
      const notifier = desktopPlugin.create();
      await notifier.notify(makeEvent());

      expect(mockExecFile.mock.calls[0][0]).toBe("osascript");
      expect(mockExecFile.mock.calls[0][1][0]).toBe("-e");
    });

    it("linux -> notify-send with title and message as separate args", async () => {
      mockPlatform.mockReturnValue("linux");
      const notifier = desktopPlugin.create();
      await notifier.notify(makeEvent({ sessionId: "backend-1", message: "Test msg" }));

      expect(mockExecFile.mock.calls[0][0]).toBe("notify-send");
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("Agent Orchestrator [backend-1]");
      expect(args).toContain("Test msg");
    });

    it("linux + urgent -> --urgency=critical before title", async () => {
      mockPlatform.mockReturnValue("linux");
      const notifier = desktopPlugin.create();
      await notifier.notify(makeEvent({ priority: "urgent" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args[0]).toBe("--urgency=critical");
    });

    it("linux + info -> no --urgency flag", async () => {
      mockPlatform.mockReturnValue("linux");
      const notifier = desktopPlugin.create();
      await notifier.notify(makeEvent({ priority: "info" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).not.toContain("--urgency=critical");
    });

    it("win32 -> no execFile call, warns", async () => {
      mockPlatform.mockReturnValue("win32");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const notifier = desktopPlugin.create();
      await notifier.notify(makeEvent());

      expect(mockExecFile).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("win32"));
      warnSpy.mockRestore();
    });
  });

  describe("notifyWithActions full pipeline", () => {
    it("formats action labels into notification body text", async () => {
      const notifier = desktopPlugin.create();
      const actions: NotifyAction[] = [
        { label: "Merge PR", url: "https://github.com/pr/1" },
        { label: "Kill", callbackEndpoint: "/api/kill" },
      ];

      await notifier.notifyWithActions!(makeEvent({ priority: "urgent" }), actions);

      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).toContain("Merge PR");
      expect(script).toContain("Kill");
      expect(script).toContain('sound name "default"');
    });

    it("action labels with special chars are escaped in AppleScript", async () => {
      const notifier = desktopPlugin.create();
      const actions: NotifyAction[] = [{ label: 'Fix "bug"', url: "https://example.com" }];

      await notifier.notifyWithActions!(makeEvent(), actions);

      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).toContain('Fix \\"bug\\"');
    });
  });

  describe("error propagation", () => {
    it("rejects when execFile fails on darwin", async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
          cb(new Error("osascript: command not found"));
        },
      );

      const notifier = desktopPlugin.create();
      await expect(notifier.notify(makeEvent())).rejects.toThrow("osascript: command not found");
    });

    it("rejects when execFile fails on linux", async () => {
      mockPlatform.mockReturnValue("linux");
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
          cb(new Error("notify-send: not found"));
        },
      );

      const notifier = desktopPlugin.create();
      await expect(notifier.notify(makeEvent())).rejects.toThrow("notify-send: not found");
    });
  });
});
