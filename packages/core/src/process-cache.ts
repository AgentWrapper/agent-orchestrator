/**
 * Process-scoped async memoization for expensive checks shared across plugins.
 *
 * Use cases: prerequisite checks (binary present, auth valid) that multiple
 * plugins want to perform but only need to actually run once per CLI
 * invocation. Cache key chooses the dedup boundary — plugins that share a
 * key share the result.
 *
 * Both successes and failures are cached: if a check fails the user must fix
 * the underlying issue and re-run, so re-checking within the same process is
 * pointless and would muddy the error stream with duplicate messages.
 *
 * **Key namespacing convention:**
 *
 * The cache is shared across every caller in the process, so two plugins
 * passing the same key are explicitly opting into shared state. That is the
 * intended use for cross-cutting checks like the `gh` CLI auth status (used
 * by both `tracker-github` and `scm-github`).
 *
 * For plugin-internal caching (where you do *not* want sharing), namespace
 * the key with your plugin name to avoid silent collisions:
 *   - shared cross-plugin check: `"gh-cli-auth"` (intentional sharing)
 *   - plugin-internal check:     `"tracker-github:rate-limit-check"`
 *
 * If two plugins use the same key for semantically different work, callers
 * will silently receive each other's resolved values — a debugging nightmare.
 * When in doubt, namespace.
 */

const cache = new Map<string, Promise<unknown>>();

export function memoizeAsync<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let cached = cache.get(key);
  if (!cached) {
    cached = fn();
    cache.set(key, cached);
  }
  return cached as Promise<T>;
}

/** Test-only — clears the process cache. */
export function _clearProcessCacheForTests(): void {
  cache.clear();
}
