/**
 * LIFO stack of cleanup callbacks for unwinding partial side effects.
 *
 * Use inside long initialization sequences (spawn, setup) where each successful
 * step adds a side effect that must be undone if a *later* step fails. Push a
 * cleanup as soon as the resource exists; call `dismiss()` once the whole
 * sequence has succeeded; call `runAll()` from the catch block to unwind.
 *
 * `runAll()` is fault-tolerant by design: a cleanup throwing must not skip the
 * remaining cleanups, otherwise the abstraction is worse than the inline ladder
 * it replaces. Pass `onError` to observe errors; the default is to swallow them
 * (matching the existing best-effort pattern in session-manager).
 */
export type CleanupFn = () => void | Promise<void>;

export class CleanupStack {
  private fns: CleanupFn[] = [];
  private dismissed = false;

  /**
   * Register a cleanup. Cleanups added after `dismiss()` or `runAll()` will
   * not run — both are terminal states for the stack.
   */
  push(fn: CleanupFn): void {
    if (this.dismissed) return;
    this.fns.push(fn);
  }

  /**
   * Mark the operation as successful. Subsequent `runAll()` calls do nothing
   * and subsequent `push()` calls are ignored.
   */
  dismiss(): void {
    this.dismissed = true;
  }

  /**
   * Run all pushed cleanups in LIFO order. Each cleanup is awaited; throws are
   * forwarded to `onError` (default: swallowed) so one failing cleanup never
   * skips the remaining ones. After running, the stack is terminal: subsequent
   * `push()` calls are no-ops and subsequent `runAll()` calls do nothing —
   * symmetric with `dismiss()`.
   */
  async runAll(onError?: (err: unknown) => void): Promise<void> {
    if (this.dismissed) return;
    this.dismissed = true;
    while (this.fns.length > 0) {
      const fn = this.fns.pop()!;
      try {
        await fn();
      } catch (err) {
        if (onError) onError(err);
      }
    }
  }
}
