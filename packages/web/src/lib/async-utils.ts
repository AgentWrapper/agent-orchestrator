/**
 * Race a promise against a timeout. Returns `true` if the promise settled
 * (resolved or rejected) before the deadline, `false` if the timeout won.
 * The timer is always cleaned up regardless of outcome.
 */
export async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<boolean>((resolve) => {
    timeoutId = setTimeout(() => resolve(false), timeoutMs);
  });

  try {
    return await Promise.race([promise.then(() => true).catch(() => true), timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
