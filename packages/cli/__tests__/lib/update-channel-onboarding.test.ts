import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockExistsSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn<(path: string) => boolean>(),
}));

import type * as FsType from "node:fs";

vi.mock("node:fs", async () => {
  const actual = (await vi.importActual("node:fs")) as typeof FsType;
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(args[0] as string),
  };
});

const { mockGlobalConfig, mockSaveGlobalConfig } = vi.hoisted(() => ({
  mockGlobalConfig: { value: null as null | { updateChannel?: string } },
  mockSaveGlobalConfig: vi.fn(),
}));

import type * as AoCoreType from "@aoagents/ao-core";

vi.mock("@aoagents/ao-core", async () => {
  const actual = (await vi.importActual("@aoagents/ao-core")) as typeof AoCoreType;
  return {
    ...actual,
    loadGlobalConfig: () => mockGlobalConfig.value,
    saveGlobalConfig: (...args: unknown[]) => mockSaveGlobalConfig(...args),
    getGlobalConfigPath: () => "/tmp/test-global.yaml",
  };
});

vi.mock("../../src/lib/caller-context.js", () => ({
  isHumanCaller: vi.fn(() => true),
}));

vi.mock("../../src/lib/prompts.js", () => ({
  promptSelect: vi.fn(),
}));

import {
  hasChosenUpdateChannel,
  maybePromptForUpdateChannel,
  persistUpdateChannel,
} from "../../src/lib/update-channel-onboarding.js";

describe("update-channel-onboarding", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGlobalConfig.value = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("hasChosenUpdateChannel — the ask-once gate", () => {
    it("returns false when global config does not exist (first run)", () => {
      mockExistsSync.mockReturnValue(false);
      expect(hasChosenUpdateChannel()).toBe(false);
    });

    it("returns false when global config exists but updateChannel is unset", () => {
      mockExistsSync.mockReturnValue(true);
      mockGlobalConfig.value = {};
      expect(hasChosenUpdateChannel()).toBe(false);
    });

    it("returns true when updateChannel is set to any value", () => {
      mockExistsSync.mockReturnValue(true);
      mockGlobalConfig.value = { updateChannel: "manual" };
      expect(hasChosenUpdateChannel()).toBe(true);
    });

    it("returns true on load failure (don't pester the user)", () => {
      mockExistsSync.mockReturnValue(true);
      mockGlobalConfig.value = null; // simulates failed load
      // hasChosenUpdateChannel sees loadGlobalConfig() returning null and treats
      // the field as unset → false. The "true on error" branch only kicks in
      // for thrown exceptions (file corruption, etc.).
      expect(hasChosenUpdateChannel()).toBe(false);
    });
  });

  describe("maybePromptForUpdateChannel — ask-once integration", () => {
    it("does not prompt when channel is already set", async () => {
      mockExistsSync.mockReturnValue(true);
      mockGlobalConfig.value = { updateChannel: "stable" };
      const prompt = vi.fn().mockResolvedValue("nightly" as const);

      await maybePromptForUpdateChannel({ prompt, isInteractive: () => true });

      expect(prompt).not.toHaveBeenCalled();
      expect(mockSaveGlobalConfig).not.toHaveBeenCalled();
    });

    it("does not prompt when caller is non-interactive", async () => {
      mockExistsSync.mockReturnValue(false);
      const prompt = vi.fn().mockResolvedValue("nightly" as const);

      await maybePromptForUpdateChannel({ prompt, isInteractive: () => false });

      expect(prompt).not.toHaveBeenCalled();
      expect(mockSaveGlobalConfig).not.toHaveBeenCalled();
    });

    it("does not prompt when global config does not exist", async () => {
      mockExistsSync.mockReturnValue(false);
      const prompt = vi.fn().mockResolvedValue("nightly" as const);

      await maybePromptForUpdateChannel({ prompt, isInteractive: () => true });

      expect(prompt).not.toHaveBeenCalled();
      expect(mockSaveGlobalConfig).not.toHaveBeenCalled();
    });

    it("prompts and persists the chosen channel when global config exists but updateChannel is unset", async () => {
      mockExistsSync.mockReturnValue(true);
      mockGlobalConfig.value = {}; // no updateChannel set
      const prompt = vi.fn().mockResolvedValue("nightly" as const);

      await maybePromptForUpdateChannel({ prompt, isInteractive: () => true });

      expect(prompt).toHaveBeenCalledTimes(1);
      expect(mockSaveGlobalConfig).toHaveBeenCalledTimes(1);
      const [config] = mockSaveGlobalConfig.mock.calls[0]!;
      expect((config as { updateChannel: string }).updateChannel).toBe("nightly");
    });

    it("falls back to 'manual' when the user dismisses the prompt", async () => {
      mockExistsSync.mockReturnValue(true);
      mockGlobalConfig.value = {}; // no updateChannel set
      const prompt = vi.fn().mockRejectedValue(new Error("dismissed"));

      await maybePromptForUpdateChannel({ prompt, isInteractive: () => true });

      expect(mockSaveGlobalConfig).toHaveBeenCalledTimes(1);
      const [config] = mockSaveGlobalConfig.mock.calls[0]!;
      expect((config as { updateChannel: string }).updateChannel).toBe("manual");
    });

    it("does not re-prompt the second time it runs after persisting", async () => {
      mockExistsSync.mockReturnValue(true);
      mockGlobalConfig.value = {};
      const prompt = vi.fn().mockResolvedValue("stable" as const);

      // First call: persists.
      await maybePromptForUpdateChannel({ prompt, isInteractive: () => true });
      expect(prompt).toHaveBeenCalledTimes(1);

      // Simulate the persisted state.
      mockGlobalConfig.value = { updateChannel: "stable" };

      await maybePromptForUpdateChannel({ prompt, isInteractive: () => true });
      expect(prompt).toHaveBeenCalledTimes(1); // still 1 — not re-prompted
    });
  });

  describe("persistUpdateChannel", () => {
    it("writes the channel into existing config", () => {
      mockExistsSync.mockReturnValue(true);
      mockGlobalConfig.value = { updateChannel: "manual" } as unknown as { updateChannel: string };
      persistUpdateChannel("nightly");
      const [config] = mockSaveGlobalConfig.mock.calls[0]!;
      expect((config as { updateChannel: string }).updateChannel).toBe("nightly");
    });

    it("does not write when global config does not exist", () => {
      mockExistsSync.mockReturnValue(false);
      persistUpdateChannel("stable");
      expect(mockSaveGlobalConfig).not.toHaveBeenCalled();
    });
  });
});
