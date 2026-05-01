export const BASE_POLL_INTERVAL_MS = 5000;
export const MAX_POLL_BACKOFF_MS = 60_000;

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("", "AbortError"));
      return;
    }
    const id = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(new DOMException("", "AbortError"));
      },
      { once: true },
    );
  });
}

/** Wait until `document.visibilityState !== "hidden"`, or reject on abort. */
export function untilVisible(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("", "AbortError"));
      return;
    }
    if (typeof document === "undefined" || !document.hidden) {
      resolve();
      return;
    }

    const onVisibility = () => {
      if (!document.hidden) {
        cleanup();
        resolve();
      }
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("", "AbortError"));
    };
    function cleanup() {
      document.removeEventListener("visibilitychange", onVisibility);
      signal.removeEventListener("abort", onAbort);
    }
    document.addEventListener("visibilitychange", onVisibility);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Backoff delay for a fresh error count. Returns BASE on success (errors=0),
 * and otherwise doubles from BASE up to MAX_POLL_BACKOFF_MS.
 */
export function backoffDelayMs(errorCount: number): number {
  if (errorCount <= 0) return BASE_POLL_INTERVAL_MS;
  const delay = BASE_POLL_INTERVAL_MS * 2 ** (errorCount - 1);
  return Math.min(delay, MAX_POLL_BACKOFF_MS);
}
