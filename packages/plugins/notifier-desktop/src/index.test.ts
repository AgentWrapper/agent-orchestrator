import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { OrchestratorEvent, NotifyAction } from "@aoagents/ao-core";

// Mock node:child_process
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

// Mock node:fs
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

// Mock node:os
vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/Users/test"),
  platform: vi.fn(() => "darwin"),
}));

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { manifest, create, escapeAppleScript } from "./index.js";

const mockExecFile = execFile as unknown as Mock;
const mockExecFileSync = execFileSync as unknown as Mock;
const mockExistsSync = existsSync as unknown as Mock;
const mockPlatform = platform as unknown as Mock;
const originalProcessPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function setProcessPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "session.spawned",
    priority: "info",
    sessionId: "app-1",
    projectId: "my-project",
    timestamp: new Date("2025-01-01T00:00:00Z"),
    message: "Session app-1 spawned",
    data: {},
    ...overrides,
  };
}

describe("notifier-desktop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatform.mockReturnValue("darwin");
    setProcessPlatform("darwin");
    mockExistsSync.mockReturnValue(false);
    // Default: terminal-notifier not available (osascript fallback)
    mockExecFileSync.mockImplementation(() => {
      const error = new Error("not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });
    mockExecFile.mockImplementation((..._args: unknown[]) => {
      // execFile may be called as (cmd, args, cb) or (cmd, args, opts, cb).
      // Pick whichever trailing arg is the callback so both shapes work.
      const cb = _args.find((a) => typeof a === "function") as
        | ((err: Error | null) => void)
        | undefined;
      cb?.(null);
    });
  });

  afterEach(() => {
    if (originalProcessPlatform) {
      Object.defineProperty(process, "platform", originalProcessPlatform);
    }
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("desktop");
      expect(manifest.slot).toBe("notifier");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("escapeAppleScript", () => {
    it("escapes double quotes", () => {
      expect(escapeAppleScript('hello "world"')).toBe('hello \\"world\\"');
    });

    it("escapes backslashes", () => {
      expect(escapeAppleScript("path\\to\\file")).toBe("path\\\\to\\\\file");
    });

    it("escapes both backslashes and quotes", () => {
      expect(escapeAppleScript('say \\"hi\\"')).toBe('say \\\\\\"hi\\\\\\"');
    });

    it("returns plain strings unchanged", () => {
      expect(escapeAppleScript("hello world")).toBe("hello world");
    });
  });

  describe("create", () => {
    it("returns a notifier with name 'desktop'", () => {
      const notifier = create();
      expect(notifier.name).toBe("desktop");
    });

    it("has notify and notifyWithActions methods", () => {
      const notifier = create();
      expect(typeof notifier.notify).toBe("function");
      expect(typeof notifier.notifyWithActions).toBe("function");
    });
  });

  describe("notify", () => {
    it("calls osascript on macOS", async () => {
      const notifier = create();
      await notifier.notify(makeEvent());

      expect(mockExecFile).toHaveBeenCalledOnce();
      expect(mockExecFile.mock.calls[0][0]).toBe("osascript");
      expect(mockExecFile.mock.calls[0][1][0]).toBe("-e");
    });

    it("includes session ID in notification subtitle", async () => {
      const notifier = create();
      await notifier.notify(makeEvent({ sessionId: "backend-5" }));

      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).toContain("backend-5");
    });

    it("includes event message in notification body", async () => {
      const notifier = create();
      await notifier.notify(makeEvent({ message: "CI is failing" }));

      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).toContain("CI is failing");
    });

    it("uses URGENT prefix for urgent priority", async () => {
      const notifier = create();
      await notifier.notify(makeEvent({ priority: "urgent" }));

      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).toContain("URGENT");
    });

    it("uses event-aware titles for non-urgent priority", async () => {
      const notifier = create();
      await notifier.notify(makeEvent({ priority: "action" }));

      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).toContain("Session Spawned");
    });

    it("includes sound for urgent notifications", async () => {
      const notifier = create();
      await notifier.notify(makeEvent({ priority: "urgent" }));

      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).toContain('sound name "default"');
    });

    it("does not include sound for info notifications", async () => {
      const notifier = create();
      await notifier.notify(makeEvent({ priority: "info" }));

      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).not.toContain("sound name");
    });

    it("does not include sound for action notifications", async () => {
      const notifier = create();
      await notifier.notify(makeEvent({ priority: "action" }));

      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).not.toContain("sound name");
    });

    it("does not include sound for warning notifications", async () => {
      const notifier = create();
      await notifier.notify(makeEvent({ priority: "warning" }));

      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).not.toContain("sound name");
    });

    it("respects sound=false config even for urgent", async () => {
      const notifier = create({ sound: false });
      await notifier.notify(makeEvent({ priority: "urgent" }));

      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).not.toContain("sound name");
    });

    it("escapes special characters in title and message", async () => {
      const notifier = create();
      await notifier.notify(
        makeEvent({ sessionId: 'test"inject', message: 'msg with "quotes" and \\backslash' }),
      );

      const script = mockExecFile.mock.calls[0][1][1] as string;
      // Should not contain unescaped quotes (other than the AppleScript string delimiters)
      expect(script).toContain('test\\"inject');
      expect(script).toContain('\\"quotes\\"');
      expect(script).toContain("\\\\backslash");
    });

    it("formats v3 pull request context into a compact desktop summary", async () => {
      const notifier = create();
      await notifier.notify(
        makeEvent({
          type: "merge.ready",
          priority: "action",
          projectId: "demo",
          sessionId: "demo-agent-29",
          message: "PR #1579 is ready to merge",
          data: {
            schemaVersion: 3,
            subject: {
              session: { id: "demo-agent-29", projectId: "demo" },
              pr: {
                number: 1579,
                title: "Normalize AO notifier payloads",
                url: "https://github.com/ComposioHQ/agent-orchestrator/pull/1579",
                branch: "ao/demo-notifier-harness",
                baseBranch: "main",
              },
              issue: { id: "AO-1579", title: "Make AO notification payloads API-grade" },
            },
            ci: { status: "passing" },
            review: { decision: "approved" },
            merge: { ready: true, conflicts: false },
            transition: { kind: "pr_state", from: "approved", to: "mergeable" },
          },
        }),
      );

      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).toContain("PR #1579 ready to merge");
      expect(script).toContain("Normalize AO notifier payloads");
      expect(script).toContain("demo · demo-agent-29 · PR #1579");
      expect(script).toContain("PR #1579");
      expect(script).toContain("AO-1579");
      expect(script).toContain("Branch: ao/demo-notifier-harness → main");
      expect(script).toContain("CI: Passing");
      expect(script).toContain("Review: Approved");
      expect(script).toContain("Merge: Ready");
      expect(script).toContain("Conflicts: None");
      expect(script).toContain("Transition: approved → mergeable");
    });
  });

  describe("notify on Linux", () => {
    it("calls notify-send on Linux", async () => {
      mockPlatform.mockReturnValue("linux");
      const notifier = create();
      await notifier.notify(makeEvent());

      expect(mockExecFile).toHaveBeenCalledOnce();
      expect(mockExecFile.mock.calls[0][0]).toBe("notify-send");
    });

    it("includes --urgency=critical for urgent on Linux", async () => {
      mockPlatform.mockReturnValue("linux");
      const notifier = create();
      await notifier.notify(makeEvent({ priority: "urgent" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("--urgency=critical");
      // Options must come before title/message for notify-send
      const urgencyIdx = args.indexOf("--urgency=critical");
      const titleIdx = args.findIndex((a: string) => a.includes("URGENT"));
      expect(urgencyIdx).toBeLessThan(titleIdx);
    });

    it("includes --urgency=critical for urgent even when sound is disabled", async () => {
      mockPlatform.mockReturnValue("linux");
      const notifier = create({ sound: false });
      await notifier.notify(makeEvent({ priority: "urgent" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("--urgency=critical");
    });

    it("does not include --urgency=critical for info on Linux", async () => {
      mockPlatform.mockReturnValue("linux");
      const notifier = create();
      await notifier.notify(makeEvent({ priority: "info" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).not.toContain("--urgency=critical");
    });
  });

  describe("notify on Windows", () => {
    it("invokes powershell.exe with an EncodedCommand toast script", async () => {
      mockPlatform.mockReturnValue("win32");
      const notifier = create();
      await notifier.notify(makeEvent({ message: "hello" }));

      expect(mockExecFile).toHaveBeenCalledWith(
        "powershell.exe",
        expect.arrayContaining(["-EncodedCommand"]),
        expect.objectContaining({ windowsHide: true }),
        expect.any(Function),
      );
      const args = mockExecFile.mock.calls[0][1] as string[];
      const encoded = args[args.indexOf("-EncodedCommand") + 1];
      const script = Buffer.from(encoded, "base64").toString("utf16le");
      expect(script).toContain("ToastNotificationManager");
      expect(script).toContain("hello");
    });

    it("XML-escapes title and message to prevent toast XML injection", async () => {
      mockPlatform.mockReturnValue("win32");
      const notifier = create();
      await notifier.notify(makeEvent({ sessionId: "<x>", message: 'a"&b' }));
      const args = mockExecFile.mock.calls[0][1] as string[];
      const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString(
        "utf16le",
      );
      expect(script).toContain("&lt;x&gt;");
      expect(script).toContain("a&quot;&amp;b");
      expect(script).not.toContain("<x>");
    });

    it("logs a warning but does not reject when powershell fails", async () => {
      mockPlatform.mockReturnValue("win32");
      mockExecFile.mockImplementationOnce((..._args: unknown[]) => {
        const cb = _args.find((a) => typeof a === "function") as
          | ((err: Error | null) => void)
          | undefined;
        cb?.(new Error("WinRT unavailable"));
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const notifier = create();
      await expect(notifier.notify(makeEvent())).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("WinRT unavailable"));
      warnSpy.mockRestore();
    });
  });

  describe("notify on unsupported platform", () => {
    it("resolves without error on unsupported platform", async () => {
      mockPlatform.mockReturnValue("freebsd");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const notifier = create();
      await expect(notifier.notify(makeEvent())).resolves.toBeUndefined();
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not supported on freebsd"));
      warnSpy.mockRestore();
    });
  });

  describe("notifyWithActions", () => {
    it("includes action labels in the message", async () => {
      const notifier = create();
      const actions: NotifyAction[] = [
        { label: "Merge", url: "https://github.com/pr/1" },
        { label: "Kill", callbackEndpoint: "/api/kill" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).toContain("Merge");
      expect(script).toContain("Kill");
    });

    it("includes sound for urgent with actions", async () => {
      const notifier = create();
      const actions: NotifyAction[] = [{ label: "Fix", url: "https://example.com" }];
      await notifier.notifyWithActions!(makeEvent({ priority: "urgent" }), actions);

      const script = mockExecFile.mock.calls[0][1][1] as string;
      expect(script).toContain('sound name "default"');
    });
  });

  describe("error handling", () => {
    it("rejects when execFile fails", async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
          cb(new Error("osascript not found"));
        },
      );
      const notifier = create();
      await expect(notifier.notify(makeEvent())).rejects.toThrow("osascript not found");
    });
  });

  describe("terminal-notifier on macOS", () => {
    beforeEach(() => {
      // terminal-notifier is available
      mockExecFileSync.mockReturnValue(Buffer.from("/usr/local/bin/terminal-notifier\n"));
    });

    it("uses terminal-notifier when available", async () => {
      const notifier = create();
      await notifier.notify(makeEvent());

      expect(mockExecFile).toHaveBeenCalledOnce();
      expect(mockExecFile.mock.calls[0][0]).toBe("terminal-notifier");
    });

    it("passes -title, -subtitle, and -message args", async () => {
      const notifier = create();
      await notifier.notify(makeEvent({ sessionId: "s-1", message: "hello" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("-title");
      expect(args).toContain("-subtitle");
      expect(args).toContain("-message");
      expect(args[args.indexOf("-subtitle") + 1]).toBe("my-project · s-1 · Info");
      expect(args[args.indexOf("-message") + 1]).toContain("hello");
    });

    it("passes session deep link with dashboardUrl when configured", async () => {
      const notifier = create({ dashboardUrl: "http://localhost:8080" });
      await notifier.notify(makeEvent());

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("-open");
      expect(args[args.indexOf("-open") + 1]).toBe(
        "http://localhost:8080/projects/my-project/sessions/app-1",
      );
    });

    it("does not pass -open when dashboardUrl is not configured", async () => {
      const notifier = create();
      await notifier.notify(makeEvent());

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).not.toContain("-open");
    });

    it("passes -sound default for urgent notifications", async () => {
      const notifier = create();
      await notifier.notify(makeEvent({ priority: "urgent" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("-sound");
      expect(args[args.indexOf("-sound") + 1]).toBe("default");
    });

    it("does not pass -sound for non-urgent notifications", async () => {
      const notifier = create();
      await notifier.notify(makeEvent({ priority: "info" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).not.toContain("-sound");
    });

    it("respects sound=false config", async () => {
      const notifier = create({ sound: false });
      await notifier.notify(makeEvent({ priority: "urgent" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).not.toContain("-sound");
    });

    it("falls back to osascript when terminal-notifier is not found", async () => {
      mockExecFileSync.mockImplementation(() => {
        const error = new Error("not found") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      });
      const notifier = create();
      await notifier.notify(makeEvent());

      expect(mockExecFile.mock.calls[0][0]).toBe("osascript");
    });

    it("does not use terminal-notifier on Linux", async () => {
      mockPlatform.mockReturnValue("linux");
      const notifier = create();
      await notifier.notify(makeEvent());

      expect(mockExecFile.mock.calls[0][0]).toBe("notify-send");
    });

    it("uses terminal-notifier for notifyWithActions too", async () => {
      const notifier = create({ dashboardUrl: "http://localhost:3000" });
      const actions: NotifyAction[] = [{ label: "View", url: "https://example.com" }];
      await notifier.notifyWithActions!(makeEvent(), actions);

      expect(mockExecFile.mock.calls[0][0]).toBe("terminal-notifier");
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("-open");
    });
  });

  describe("AO Notifier.app backend", () => {
    beforeEach(() => {
      mockExistsSync.mockImplementation((path: string) =>
        normalizePathSeparators(path).endsWith("AO Notifier.app/Contents/MacOS/ao-notifier"),
      );
    });

    it("uses AO Notifier.app before terminal-notifier in auto mode", async () => {
      mockExecFileSync.mockReturnValue(Buffer.from("/usr/local/bin/terminal-notifier\n"));
      const notifier = create({ dashboardUrl: "http://localhost:3000" });
      await notifier.notify(makeEvent({ message: "native app" }));

      expect(normalizePathSeparators(mockExecFile.mock.calls[0][0] as string)).toBe(
        "/Users/test/Applications/AO Notifier.app/Contents/MacOS/ao-notifier",
      );
      expect(mockExecFile.mock.calls[0][1][0]).toBe("--notify-base64");
    });

    it("passes event metadata and default open URL to AO Notifier.app", async () => {
      const notifier = create({ backend: "ao-app", dashboardUrl: "http://localhost:3001" });
      await notifier.notify(makeEvent({ id: "evt-native", sessionId: "s-9" }));

      const encoded = mockExecFile.mock.calls[0][1][1] as string;
      const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8")) as {
        notificationId: string;
        threadId: string;
        subtitle: string;
        defaultOpenUrl: string;
        event: { id: string; sessionId: string };
      };
      expect(payload.notificationId).toMatch(/^evt-native\./);
      expect(payload.threadId).toBe("ao.notifications");
      expect(payload.subtitle).toBe("my-project · s-9 · Info");
      expect(payload.defaultOpenUrl).toBe("http://localhost:3001/projects/my-project/sessions/s-9");
      expect(payload.event).toMatchObject({ id: "evt-native", sessionId: "s-9" });
    });

    it("scopes native notification sequence to each notifier instance", async () => {
      const first = create({ backend: "ao-app" });
      const second = create({ backend: "ao-app" });

      await first.notify(makeEvent({ id: "evt-first" }));
      await second.notify(makeEvent({ id: "evt-second" }));

      const firstEncoded = mockExecFile.mock.calls[0][1][1] as string;
      const secondEncoded = mockExecFile.mock.calls[1][1][1] as string;
      const firstPayload = JSON.parse(Buffer.from(firstEncoded, "base64").toString("utf-8")) as {
        notificationId: string;
      };
      const secondPayload = JSON.parse(Buffer.from(secondEncoded, "base64").toString("utf-8")) as {
        notificationId: string;
      };

      expect(firstPayload.notificationId).toMatch(/^evt-first\..*\.1$/);
      expect(secondPayload.notificationId).toMatch(/^evt-second\..*\.1$/);
    });

    it("passes URL actions to AO Notifier.app", async () => {
      const notifier = create({ backend: "ao-app" });
      const actions: NotifyAction[] = [
        { label: "Open PR", url: "https://github.com/example/pr/1" },
        { label: "Kill", callbackEndpoint: "/api/kill" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const encoded = mockExecFile.mock.calls[0][1][1] as string;
      const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8")) as {
        body: string;
        actions: Array<{ label: string; url?: string; callbackEndpoint?: string }>;
      };
      expect(payload.actions).toEqual([
        { label: "Open PR", url: "https://github.com/example/pr/1" },
      ]);
      expect(payload.body).toContain("Kill");
      expect(payload.body).not.toContain("Open PR");
    });

    it("passes callback actions to AO Notifier.app when they resolve against dashboardUrl", async () => {
      const notifier = create({ backend: "ao-app", dashboardUrl: "http://localhost:3000" });
      const actions: NotifyAction[] = [
        { label: "Kill", callbackEndpoint: "/api/sessions/app-1/kill" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const encoded = mockExecFile.mock.calls[0][1][1] as string;
      const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8")) as {
        body: string;
        actions: Array<{ label: string; callbackEndpoint?: string }>;
      };
      expect(payload.actions).toEqual([
        { label: "Kill", callbackEndpoint: "http://localhost:3000/api/sessions/app-1/kill" },
      ]);
      expect(payload.body).not.toContain("Kill");
    });

    it("fails when backend ao-app is configured but the app is missing", async () => {
      mockExistsSync.mockReturnValue(false);
      const notifier = create({ backend: "ao-app" });

      await expect(notifier.notify(makeEvent())).rejects.toThrow("ao setup desktop");
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("does not use a placeholder AO Notifier.app in auto mode", async () => {
      mockExistsSync.mockImplementation(
        (path: string) =>
          normalizePathSeparators(path).endsWith("AO Notifier.app/Contents/MacOS/ao-notifier") ||
          normalizePathSeparators(path).endsWith(
            "AO Notifier.app/Contents/Resources/ao-notifier-placeholder",
          ),
      );
      const notifier = create();

      await notifier.notify(makeEvent());

      expect(mockExecFile.mock.calls[0][0]).toBe("osascript");
    });
  });
});
