/**
 * Lock Manager
 * 
 * Manages code ownership and locking for multi-agent coordination.
 * Prevents conflicts when multiple agents work on the same codebase.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

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

export class LockManager {
  private db: Database.Database;
  private storagePath: string;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.ensureStorageDir();
    this.db = new Database(join(storagePath, "locks.db"));
    this.initializeSchema();
    this.startCleanupJob();
  }

  private ensureStorageDir(): void {
    if (!existsSync(this.storagePath)) {
      mkdirSync(this.storagePath, { recursive: true });
    }
  }

  private initializeSchema(): void {
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
      JSON.stringify(lock.metadata)
    );

    return lock;
  }

  /**
   * Release a lock
   */
  release(lockId: string): boolean {
    const stmt = this.db.prepare("DELETE FROM locks WHERE id = ?");
    const result = stmt.run(lockId);
    return result.changes > 0;
  }

  /**
   * Release all locks for an owner
   */
  releaseAll(owner: string): number {
    const stmt = this.db.prepare("DELETE FROM locks WHERE owner = ?");
    const result = stmt.run(owner);
    return result.changes;
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
    
    const stmt = this.db.prepare(`
      SELECT * FROM locks 
      WHERE resource = ? AND expiresAt > ?
      ORDER BY acquiredAt DESC
      LIMIT 1
    `);
    
    const row = stmt.get(resource, now) as any;
    
    if (!row) return null;
    
    return this.rowToLock(row);
  }

  /**
   * Get all locks for an owner
   */
  getOwnerLocks(owner: string): Lock[] {
    const now = new Date().toISOString();
    
    const stmt = this.db.prepare(`
      SELECT * FROM locks 
      WHERE owner = ? AND expiresAt > ?
      ORDER BY acquiredAt DESC
    `);
    
    const rows = stmt.all(owner, now) as any[];
    
    return rows.map(row => this.rowToLock(row));
  }

  /**
   * Get all active locks
   */
  getAllActiveLocks(): Lock[] {
    const now = new Date().toISOString();
    
    const stmt = this.db.prepare(`
      SELECT * FROM locks 
      WHERE expiresAt > ?
      ORDER BY acquiredAt DESC
    `);
    
    const rows = stmt.all(now) as any[];
    
    return rows.map(row => this.rowToLock(row));
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

    const stmt = this.db.prepare(`
      UPDATE locks SET expiresAt = ? WHERE id = ?
    `);

    stmt.run(newExpires.toISOString(), lockId);

    return {
      ...lock,
      expiresAt: newExpires.toISOString(),
    };
  }

  /**
   * Get a specific lock by ID
   */
  getLock(lockId: string): Lock | null {
    const stmt = this.db.prepare("SELECT * FROM locks WHERE id = ?");
    const row = stmt.get(lockId) as any;
    
    if (!row) return null;
    
    return this.rowToLock(row);
  }

  /**
   * Cleanup expired locks
   */
  cleanup(): number {
    const now = new Date().toISOString();
    
    const stmt = this.db.prepare("DELETE FROM locks WHERE expiresAt < ?");
    const result = stmt.run(now);
    
    return result.changes;
  }

  /**
   * Start background cleanup job
   */
  private startCleanupJob(): void {
    // Run cleanup every minute
    setInterval(() => {
      this.cleanup();
    }, 60000);
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
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  }

  private rowToLock(row: any): Lock {
    return {
      id: row.id,
      type: row.type,
      resource: row.resource,
      owner: row.owner,
      acquiredAt: row.acquiredAt,
      expiresAt: row.expiresAt,
      reason: row.reason,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
    };
  }

  close(): void {
    this.db.close();
  }
}
