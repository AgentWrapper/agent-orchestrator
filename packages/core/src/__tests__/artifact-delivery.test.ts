import { describe, it, expect } from "vitest";
import { sendMessageToSession } from "../artifact-delivery.js";

describe("sendMessageToSession", () => {
  it("rejects with delivery_timeout if tmux call exceeds timeoutMs", async () => {
    // Mock the tmux runner to never resolve so the timeout wins.
    const neverResolves = (): Promise<void> => new Promise<void>(() => {});
    await expect(
      sendMessageToSession({
        tmuxTarget: "fake:0",
        message: "hello",
        timeoutMs: 50,
        tmuxRunner: neverResolves,
      }),
    ).rejects.toThrow(/delivery_timeout/);
  });

  it("resolves on successful tmux delivery", async () => {
    const tmuxCalls: string[][] = [];
    const fakeRunner = async (args: string[]): Promise<void> => {
      tmuxCalls.push(args);
    };
    await sendMessageToSession({
      tmuxTarget: "test:0",
      message: "hi",
      timeoutMs: 1_000,
      tmuxRunner: fakeRunner,
    });
    expect(tmuxCalls.length).toBeGreaterThan(0);
    // First call should be the literal send-keys.
    expect(tmuxCalls[0]).toEqual(["send-keys", "-t", "test:0", "-l", "hi"]);
    // Last call should be the Enter press.
    expect(tmuxCalls[tmuxCalls.length - 1]).toEqual(["send-keys", "-t", "test:0", "Enter"]);
  });

  it("rejects with delivery_failed if tmux runner throws", async () => {
    const failingRunner = async (): Promise<void> => {
      throw new Error("tmux session not found");
    };
    await expect(
      sendMessageToSession({
        tmuxTarget: "fake:0",
        message: "hi",
        timeoutMs: 1_000,
        tmuxRunner: failingRunner,
      }),
    ).rejects.toThrow(/delivery_failed: tmux session not found/);
  });
});
