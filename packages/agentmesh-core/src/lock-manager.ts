/**
 * Lock Manager
 *
 * Manages code ownership and locking for multi-agent coordination.
 * Prevents conflicts when multiple agents work on the same codebase.
 *
 * Persists to SQLite when better-sqlite3 is available. When the native
 * binary fails to load/build (common on Windows without build tools), it
 * falls back to in-memory storage so the CoordinationService — and the web
 * server that constructs it on startup — never crashes.
 */

import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export type LockType = "file" | "directory" | "branch" | "feature";

export interface Lock {
  id: string;
  type: LockType;
  resource: string; // file path, directory path, branch name, etc.
  owner: string; // taskId or agentId
  acquiredAt: string;
  expiresAt: string;
  reason: string;
  metadata: Record<string, unknown>;
}

export interface LockRequest {
  type: LockType;
  resource: string;
  owner: string;
  duration: number; // milliseconds
  reason: string;
  metadata?: Record<string, unknown>;
}

type SqliteStatement = {
  run(...args: unknown[]): { changes: number };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
};

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

type SqliteDatabaseConstructor = new (path: string) => SqliteDatabase;

const requireLoaders = [
  createRequire(import.meta.url),
  // Next.js can bundle this file into .next/server/chunks, so fall back to
  // resolving from the dashboard process cwd when the package-root loader
  // points at a bundled artifact instead of node_modules.
  createRequire(join(process.cwd(), "package.json")),
];

const Database = (() => {
  for (const requireFn of requireLoaders) {
    try {
      return requireFn("better-sqlite3") as SqliteDatabaseConstructor;
    } catch {}
  }
  return null;
})();

const DatabaseAvailable = Database !== null;

export class LockManager {
  private db: SqliteDatabase | null;
  private storagePath: string;
  private inMemoryLocks: Map<string, Lock>;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.inMemoryLocks = new Map();
    this.ensureStorageDir();

    if (DatabaseAvailable) {
      try {
        this.db = new Database(join(storagePath, "locks.db"));
        this.initializeSchema();
      } catch (err) {
        this.db = null;
        console.warn("[LockManager] better-sqlite3 failed to open, using in-memory storage", err);
      }
    } else {
      this.db = null;
      console.warn("[LockManager] better-sqlite3 unavailable, using in-memory storage");
    }

    this.startCleanupJob();
  }

  private ensureStorageDir(): void {
    if (!existsSync(this.storagePath)) {
      mkdirSync(this.storagePath, { recursive: true });
    }
  }

  private initializeSchema(): void {
    if (!this.db) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS locks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        resource TEXT NOT NULL,
        owner TEXT NOT NULL,
        acquiredAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        reason TEXT NOT NULL,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_locks_resource ON locks(resource);
      CREATE INDEX IF NOT EXISTS idx_locks_owner ON locks(owner);
      CREATE INDEX IF NOT EXISTS idx_locks_expires ON locks(expiresAt);
    `);
  }

  /**
   * Acquire a lock on a resource
   */
  acquire(request: LockRequest): Lock | null {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + request.duration);
    const lockId = this.generateLockId(request.type, request.resource);

    // Check if lock is already held (not expired)
    const existingLock = this.getActiveLock(request.resource);
    if (existingLock && existingLock.owner !== request.owner) {
      return null; // Lock is held by someone else
    }

    // Create or update the lock
    const lock: Lock = {
      id: lockId,
      type: request.type,
      resource: request.resource,
      owner: request.owner,
      acquiredAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      reason: request.reason,
      metadata: request.metadata || {},
    };

    if (this.db) {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO locks (
          id, type, resource, owner, acquiredAt, expiresAt, reason, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        lock.id,
        lock.type,
        lock.resource,
        lock.owner,
        lock.acquiredAt,
        lock.expiresAt,
        lock.reason,
        JSON.stringify(lock.metadata),
      );
    } else {
      this.inMemoryLocks.set(lock.id, lock);
    }

    return lock;
  }

  /**
   * Release a lock
   */
  release(lockId: string): boolean {
    if (this.db) {
      const stmt = this.db.prepare("DELETE FROM locks WHERE id = ?");
      const result = stmt.run(lockId);
      return result.changes > 0;
    }
    return this.inMemoryLocks.delete(lockId);
  }

  /**
   * Release all locks for an owner
   */
  releaseAll(owner: string): number {
    if (this.db) {
      const stmt = this.db.prepare("DELETE FROM locks WHERE owner = ?");
      const result = stmt.run(owner);
      return result.changes;
    }
    let count = 0;
    for (const [id, lock] of this.inMemoryLocks) {
      if (lock.owner === owner) {
        this.inMemoryLocks.delete(id);
        count++;
      }
    }
    return count;
  }

  /**
   * Check if a resource is locked
   */
  isLocked(resource: string): boolean {
    return this.getActiveLock(resource) !== null;
  }

  /**
   * Get the active lock for a resource
   */
  getActiveLock(resource: string): Lock | null {
    const now = new Date().toISOString();

    if (this.db) {
      const stmt = this.db.prepare(`
        SELECT * FROM locks 
        WHERE resource = ? AND expiresAt > ?
        ORDER BY acquiredAt DESC
        LIMIT 1
      `);

      const row = stmt.get(resource, now) as Record<string, unknown>;

      if (!row) return null;

      return this.rowToLock(row);
    }

    const matches = Array.from(this.inMemoryLocks.values())
      .filter((lock) => lock.resource === resource && lock.expiresAt > now)
      .sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt));
    return matches[0] ?? null;
  }

  /**
   * Get all locks for an owner
   */
  getOwnerLocks(owner: string): Lock[] {
    const now = new Date().toISOString();

    if (this.db) {
      const stmt = this.db.prepare(`
        SELECT * FROM locks 
        WHERE owner = ? AND expiresAt > ?
        ORDER BY acquiredAt DESC
      `);

      const rows = stmt.all(owner, now) as unknown[];

      return rows.map((row) => this.rowToLock(row as Record<string, unknown>));
    }

    return Array.from(this.inMemoryLocks.values())
      .filter((lock) => lock.owner === owner && lock.expiresAt > now)
      .sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt));
  }

  /**
   * Get all active locks
   */
  getAllActiveLocks(): Lock[] {
    const now = new Date().toISOString();

    if (this.db) {
      const stmt = this.db.prepare(`
        SELECT * FROM locks 
        WHERE expiresAt > ?
        ORDER BY acquiredAt DESC
      `);

      const rows = stmt.all(now) as unknown[];

      return rows.map((row) => this.rowToLock(row as Record<string, unknown>));
    }

    return Array.from(this.inMemoryLocks.values())
      .filter((lock) => lock.expiresAt > now)
      .sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt));
  }

  /**
   * Check if an owner can acquire a lock
   */
  canAcquire(owner: string, resource: string): boolean {
    const activeLock = this.getActiveLock(resource);
    if (!activeLock) return true;
    return activeLock.owner === owner;
  }

  /**
   * Extend a lock's expiration time
   */
  extend(lockId: string, additionalDuration: number): Lock | null {
    const lock = this.getLock(lockId);
    if (!lock) return null;

    const currentExpires = new Date(lock.expiresAt);
    const newExpires = new Date(currentExpires.getTime() + additionalDuration);

    if (this.db) {
      const stmt = this.db.prepare(`
        UPDATE locks SET expiresAt = ? WHERE id = ?
      `);

      stmt.run(newExpires.toISOString(), lockId);
    } else {
      this.inMemoryLocks.set(lockId, { ...lock, expiresAt: newExpires.toISOString() });
    }

    return {
      ...lock,
      expiresAt: newExpires.toISOString(),
    };
  }

  /**
   * Get a specific lock by ID
   */
  getLock(lockId: string): Lock | null {
    if (this.db) {
      const stmt = this.db.prepare("SELECT * FROM locks WHERE id = ?");
      const row = stmt.get(lockId) as Record<string, unknown>;

      if (!row) return null;

      return this.rowToLock(row);
    }

    return this.inMemoryLocks.get(lockId) ?? null;
  }

  /**
   * Cleanup expired locks
   */
  cleanup(): number {
    const now = new Date().toISOString();

    if (this.db) {
      const stmt = this.db.prepare("DELETE FROM locks WHERE expiresAt < ?");
      const result = stmt.run(now);

      return result.changes;
    }

    let count = 0;
    for (const [id, lock] of this.inMemoryLocks) {
      if (lock.expiresAt < now) {
        this.inMemoryLocks.delete(id);
        count++;
      }
    }
    return count;
  }

  /**
   * Start background cleanup job
   */
  private startCleanupJob(): void {
    // Run cleanup every minute. unref() so the timer never keeps the process
    // (or a test runner) alive on its own.
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, 60000);
    this.cleanupTimer.unref?.();
  }

  /**
   * Check for lock conflicts before starting work
   */
  checkConflicts(resources: string[], owner: string): string[] {
    const conflicts: string[] = [];

    for (const resource of resources) {
      const activeLock = this.getActiveLock(resource);
      if (activeLock && activeLock.owner !== owner) {
        conflicts.push(resource);
      }
    }

    return conflicts;
  }

  /**
   * Acquire multiple locks atomically
   */
  acquireMultiple(requests: LockRequest[]): Lock[] {
    const acquiredLocks: Lock[] = [];
    const failedResources: string[] = [];

    // First pass: check all resources
    for (const request of requests) {
      if (!this.canAcquire(request.owner, request.resource)) {
        failedResources.push(request.resource);
      }
    }

    // If any conflicts, fail all
    if (failedResources.length > 0) {
      return [];
    }

    // Second pass: acquire all locks
    for (const request of requests) {
      const lock = this.acquire(request);
      if (lock) {
        acquiredLocks.push(lock);
      }
    }

    // If any failed, release all acquired locks
    if (acquiredLocks.length !== requests.length) {
      for (const lock of acquiredLocks) {
        this.release(lock.id);
      }
      return [];
    }

    return acquiredLocks;
  }

  private generateLockId(type: LockType, resource: string): string {
    const hash = this.simpleHash(resource);
    return `${type}-${hash}`;
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  }

  private rowToLock(row: Record<string, unknown>): Lock {
    return {
      id: row.id as string,
      type: row.type as LockType,
      resource: row.resource as string,
      owner: row.owner as string,
      acquiredAt: row.acquiredAt as string,
      expiresAt: row.expiresAt as string,
      reason: row.reason as string,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
    };
  }

  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.db) {
      this.db.close();
    }
  }
}
