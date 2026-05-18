import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Function signature for delivering a tmux command. The default implementation
 * shells out to `tmux`; tests inject a synchronous mock.
 */
export type TmuxRunner = (args: string[]) => Promise<void>;

const defaultTmuxRunner: TmuxRunner = async (args) => {
  await execFileAsync("tmux", args, { timeout: 5_000 });
};

export interface SendMessageOptions {
  /** Tmux target (e.g. "ao-session-1:0"). */
  tmuxTarget: string;
  /** Message to deliver. */
  message: string;
  /** Total timeout for the operation. Default 5_000ms. */
  timeoutMs?: number;
  /** Override the tmux runner for tests. */
  tmuxRunner?: TmuxRunner;
}

/**
 * Deliver a message as terminal input to a tmux session.
 *
 * Used by the `ao send` CLI command (short-message path).
 *
 * Rejects with:
 *   - "delivery_timeout" if tmux doesn't return within timeoutMs
 *   - "delivery_failed: <reason>" for any other tmux error
 */
export async function sendMessageToSession(options: SendMessageOptions): Promise<void> {
  const { tmuxTarget, message, timeoutMs = 5_000, tmuxRunner = defaultTmuxRunner } = options;

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const work = (async (): Promise<void> => {
    try {
      await tmuxRunner(["send-keys", "-t", tmuxTarget, "-l", message]);
      // Brief delay before Enter so the agent's terminal can settle the input.
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      await tmuxRunner(["send-keys", "-t", tmuxTarget, "Enter"]);
    } catch (err) {
      throw new Error(`delivery_failed: ${(err as Error).message}`, { cause: err });
    }
  })();

  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("delivery_timeout")), timeoutMs);
  });

  try {
    await Promise.race([work, timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
