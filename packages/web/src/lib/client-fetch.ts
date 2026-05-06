"use client";

interface FetchJsonOptions extends RequestInit {
  timeoutMs?: number;
  timeoutMessage?: string;
}

function mergeAbortSignals(
  signals: Array<AbortSignal | null | undefined>,
): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length === 0) return undefined;
  if (activeSignals.length === 1) return activeSignals[0];

  const controller = new AbortController();
  const abort = () => controller.abort();

  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }

  return controller.signal;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string; message?: string } | null;
    const message = payload?.error ?? payload?.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  } catch {
    // Ignore parse failures and fall back to status text.
  }

  const statusText = typeof response.statusText === "string" ? response.statusText.trim() : "";
  if (statusText.length > 0) {
    return `${response.status} ${statusText}`;
  }

  return `HTTP ${response.status}`;
}

export async function fetchJsonWithTimeout<T>(
  input: RequestInfo | URL,
  options: FetchJsonOptions = {},
): Promise<T> {
  const { timeoutMs = 8_000, timeoutMessage, signal, ...init } = options;
  const timeoutController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  try {
    const mergedSignal = mergeAbortSignals([signal, timeoutController.signal]);
    const requestInit: RequestInit = { ...init };
    if (mergedSignal) {
      requestInit.signal = mergedSignal;
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        timeoutController.abort();
        reject(new Error(timeoutMessage ?? `Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const response = await Promise.race([
      fetch(input, requestInit).catch((error: unknown) => {
        if (timedOut) {
          throw new Error(timeoutMessage ?? `Request timed out after ${timeoutMs}ms`, {
            cause: error,
          });
        }
        throw error;
      }),
      timeoutPromise,
    ]);

    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }

    return (await response.json()) as T;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
