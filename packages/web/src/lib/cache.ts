/**
 * Simple in-memory TTL cache for SCM API data.
 *
 * Reduces GitHub API rate limit exhaustion by caching PR enrichment data.
 * Default TTL: 60 seconds (data is fresh enough for dashboard refresh).
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60_000; // 5 minutes

/**
 * Simple TTL cache backed by a Map.
 * Automatically evicts stale entries on get() and periodically cleans up.
 */
export class TTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
    // Run cleanup every TTL period to prevent memory leaks from unread keys
    this.cleanupInterval = setInterval(() => this.evictExpired(), ttlMs);
    // Ensure cleanup interval doesn't prevent Node process from exiting
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /** Get a cached value if it exists and isn't stale */
  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  /** Set a cache entry with TTL (optional override) */
  set(key: string, value: T, ttlMs?: number): void {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.ttlMs),
    });
  }

  /** Evict all expired entries */
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  /** Clear all entries and stop cleanup interval */
  clear(): void {
    this.cache.clear();
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }

  /** Get cache size (includes stale entries) */
  size(): number {
    return this.cache.size;
  }
}

/**
 * Enrichment data for a single PR.
 * Cached by PR number (key: `owner/repo#123`).
 */
export interface PREnrichmentData {
  state: "open" | "merged" | "closed";
  title: string;
  additions: number;
  deletions: number;
  ciStatus: "none" | "pending" | "passing" | "failing";
  ciChecks: Array<{ name: string; status: "pending" | "running" | "passed" | "failed" | "skipped"; url?: string }>;
  reviewDecision: "none" | "pending" | "approved" | "changes_requested";
  mergeability: {
    mergeable: boolean;
    ciPassing: boolean;
    approved: boolean;
    noConflicts: boolean;
    blockers: string[];
  };
  unresolvedThreads: number;
  unresolvedComments: Array<{
    url: string;
    path: string;
    author: string;
    body: string;
  }>;
}

/** Generate cache key for a PR: `owner/repo#123` */
export function prCacheKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}
