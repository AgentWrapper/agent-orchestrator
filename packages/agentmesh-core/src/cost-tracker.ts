/**
 * Cost Tracker
 *
 * Tracks per-task cost and token usage for budget management.
 * Integrates with agent adapters to capture cost information.
 *
 * Persists to SQLite when better-sqlite3 is available. When the native
 * binary fails to load/build (common on Windows without build tools), it
 * falls back to in-memory storage so the CoordinationService — and the web
 * server that constructs it on startup — never crashes.
 */

import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export interface CostEntry {
  id: string;
  taskId: string;
  agent: string;
  model: string;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface CostSummary {
  taskId: string;
  totalCostUsd: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  agentBreakdown: Record<string, { cost: number; tokens: number }>;
  timeline: CostEntry[];
}

export interface BudgetConfig {
  maxCostPerTask: number;
  maxCostPerDay: number;
  maxTokensPerTask: number;
  alertThreshold: number; // percentage
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

export class CostTracker {
  private db: SqliteDatabase | null;
  private storagePath: string;
  private budgetConfig: BudgetConfig;
  private inMemoryEntries: CostEntry[];

  constructor(storagePath: string, budgetConfig?: Partial<BudgetConfig>) {
    this.storagePath = storagePath;
    this.inMemoryEntries = [];
    this.ensureStorageDir();

    if (DatabaseAvailable) {
      try {
        this.db = new Database(join(storagePath, "costs.db"));
        this.initializeSchema();
      } catch (err) {
        this.db = null;
        console.warn("[CostTracker] better-sqlite3 failed to open, using in-memory storage", err);
      }
    } else {
      this.db = null;
      console.warn("[CostTracker] better-sqlite3 unavailable, using in-memory storage");
    }

    this.budgetConfig = {
      maxCostPerTask: budgetConfig?.maxCostPerTask || 100,
      maxCostPerDay: budgetConfig?.maxCostPerDay || 500,
      maxTokensPerTask: budgetConfig?.maxTokensPerTask || 1000000,
      alertThreshold: budgetConfig?.alertThreshold || 0.8,
    };
  }

  private ensureStorageDir(): void {
    if (!existsSync(this.storagePath)) {
      mkdirSync(this.storagePath, { recursive: true });
    }
  }

  private initializeSchema(): void {
    if (!this.db) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cost_entries (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        agent TEXT NOT NULL,
        model TEXT NOT NULL,
        tokensUsed INTEGER NOT NULL,
        inputTokens INTEGER NOT NULL,
        outputTokens INTEGER NOT NULL,
        costUsd REAL NOT NULL,
        timestamp TEXT NOT NULL,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_cost_entries_taskId ON cost_entries(taskId);
      CREATE INDEX IF NOT EXISTS idx_cost_entries_timestamp ON cost_entries(timestamp);
      CREATE INDEX IF NOT EXISTS idx_cost_entries_agent ON cost_entries(agent);
    `);
  }

  /**
   * Record a cost entry from an agent operation
   */
  recordCost(entry: Omit<CostEntry, "id" | "timestamp">): CostEntry {
    const id = this.generateId();
    const timestamp = new Date().toISOString();

    const costEntry: CostEntry = {
      id,
      timestamp,
      ...entry,
    };

    if (this.db) {
      const stmt = this.db.prepare(`
        INSERT INTO cost_entries (
          id, taskId, agent, model, tokensUsed, inputTokens, outputTokens, costUsd, timestamp, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        costEntry.id,
        costEntry.taskId,
        costEntry.agent,
        costEntry.model,
        costEntry.tokensUsed,
        costEntry.inputTokens,
        costEntry.outputTokens,
        costEntry.costUsd,
        costEntry.timestamp,
        JSON.stringify(costEntry.metadata),
      );
    } else {
      this.inMemoryEntries.push(costEntry);
    }

    return costEntry;
  }

  private summarize(taskId: string, entries: CostEntry[]): CostSummary {
    const totalCostUsd = entries.reduce((sum, e) => sum + e.costUsd, 0);
    const totalTokens = entries.reduce((sum, e) => sum + e.tokensUsed, 0);
    const totalInputTokens = entries.reduce((sum, e) => sum + e.inputTokens, 0);
    const totalOutputTokens = entries.reduce((sum, e) => sum + e.outputTokens, 0);

    const agentBreakdown: Record<string, { cost: number; tokens: number }> = {};
    for (const entry of entries) {
      if (!agentBreakdown[entry.agent]) {
        agentBreakdown[entry.agent] = { cost: 0, tokens: 0 };
      }
      agentBreakdown[entry.agent].cost += entry.costUsd;
      agentBreakdown[entry.agent].tokens += entry.tokensUsed;
    }

    return {
      taskId,
      totalCostUsd,
      totalTokens,
      totalInputTokens,
      totalOutputTokens,
      agentBreakdown,
      timeline: entries,
    };
  }

  /**
   * Get cost summary for a task
   */
  getTaskSummary(taskId: string): CostSummary {
    let entries: CostEntry[];

    if (this.db) {
      const stmt = this.db.prepare(`
        SELECT * FROM cost_entries 
        WHERE taskId = ? 
        ORDER BY timestamp ASC
      `);

      const rows = stmt.all(taskId) as unknown[];
      entries = rows.map((row) => this.rowToCostEntry(row as Record<string, unknown>));
    } else {
      entries = this.inMemoryEntries
        .filter((e) => e.taskId === taskId)
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }

    return this.summarize(taskId, entries);
  }

  /**
   * Get cost summary for a date range
   */
  getDateRangeSummary(startDate: Date, endDate: Date): CostSummary {
    const start = startDate.toISOString();
    const end = endDate.toISOString();
    let entries: CostEntry[];

    if (this.db) {
      const stmt = this.db.prepare(`
        SELECT * FROM cost_entries 
        WHERE timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp ASC
      `);

      const rows = stmt.all(start, end) as unknown[];
      entries = rows.map((row) => this.rowToCostEntry(row as Record<string, unknown>));
    } else {
      entries = this.inMemoryEntries
        .filter((e) => e.timestamp >= start && e.timestamp <= end)
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }

    return this.summarize("date-range", entries);
  }

  /**
   * Check if a task is within budget
   */
  checkTaskBudget(taskId: string): {
    withinBudget: boolean;
    costUsd: number;
    tokens: number;
    costRemaining: number;
    tokensRemaining: number;
    alerts: string[];
  } {
    const summary = this.getTaskSummary(taskId);

    const costRemaining = this.budgetConfig.maxCostPerTask - summary.totalCostUsd;
    const tokensRemaining = this.budgetConfig.maxTokensPerTask - summary.totalTokens;

    const alerts: string[] = [];

    if (
      summary.totalCostUsd >=
      this.budgetConfig.maxCostPerTask * this.budgetConfig.alertThreshold
    ) {
      alerts.push(
        `Cost threshold reached: $${summary.totalCostUsd.toFixed(2)} / $${this.budgetConfig.maxCostPerTask}`,
      );
    }

    if (
      summary.totalTokens >=
      this.budgetConfig.maxTokensPerTask * this.budgetConfig.alertThreshold
    ) {
      alerts.push(
        `Token threshold reached: ${summary.totalTokens} / ${this.budgetConfig.maxTokensPerTask}`,
      );
    }

    return {
      withinBudget:
        summary.totalCostUsd < this.budgetConfig.maxCostPerTask &&
        summary.totalTokens < this.budgetConfig.maxTokensPerTask,
      costUsd: summary.totalCostUsd,
      tokens: summary.totalTokens,
      costRemaining,
      tokensRemaining,
      alerts,
    };
  }

  /**
   * Check if daily budget is within limits
   */
  checkDailyBudget(): {
    withinBudget: boolean;
    costUsd: number;
    costRemaining: number;
    alerts: string[];
  } {
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

    const summary = this.getDateRangeSummary(startOfDay, endOfDay);
    const costRemaining = this.budgetConfig.maxCostPerDay - summary.totalCostUsd;

    const alerts: string[] = [];

    if (
      summary.totalCostUsd >=
      this.budgetConfig.maxCostPerDay * this.budgetConfig.alertThreshold
    ) {
      alerts.push(
        `Daily cost threshold reached: $${summary.totalCostUsd.toFixed(2)} / $${this.budgetConfig.maxCostPerDay}`,
      );
    }

    return {
      withinBudget: summary.totalCostUsd < this.budgetConfig.maxCostPerDay,
      costUsd: summary.totalCostUsd,
      costRemaining,
      alerts,
    };
  }

  /**
   * Get all cost entries for a task
   */
  getTaskEntries(taskId: string): CostEntry[] {
    if (this.db) {
      const stmt = this.db.prepare(`
        SELECT * FROM cost_entries 
        WHERE taskId = ? 
        ORDER BY timestamp DESC
      `);

      const rows = stmt.all(taskId) as unknown[];
      return rows.map((row) => this.rowToCostEntry(row as Record<string, unknown>));
    }

    return this.inMemoryEntries
      .filter((e) => e.taskId === taskId)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /**
   * Get cost breakdown by agent
   */
  getAgentBreakdown(agent: string, startDate?: Date, endDate?: Date): CostSummary {
    let entries: CostEntry[];

    if (this.db) {
      let query = "SELECT * FROM cost_entries WHERE agent = ?";
      const params: (string | number | bigint | Buffer | null)[] = [agent];

      if (startDate && endDate) {
        query += " AND timestamp >= ? AND timestamp <= ?";
        params.push(startDate.toISOString(), endDate.toISOString());
      }

      query += " ORDER BY timestamp ASC";

      const stmt = this.db.prepare(query);
      const rows = stmt.all(...params) as unknown[];
      entries = rows.map((row) => this.rowToCostEntry(row as Record<string, unknown>));
    } else {
      const start = startDate?.toISOString();
      const end = endDate?.toISOString();
      entries = this.inMemoryEntries
        .filter((e) => e.agent === agent)
        .filter((e) => (start && end ? e.timestamp >= start && e.timestamp <= end : true))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }

    const totalCostUsd = entries.reduce((sum, e) => sum + e.costUsd, 0);
    const totalTokens = entries.reduce((sum, e) => sum + e.tokensUsed, 0);
    const totalInputTokens = entries.reduce((sum, e) => sum + e.inputTokens, 0);
    const totalOutputTokens = entries.reduce((sum, e) => sum + e.outputTokens, 0);

    return {
      taskId: agent,
      totalCostUsd,
      totalTokens,
      totalInputTokens,
      totalOutputTokens,
      agentBreakdown: { [agent]: { cost: totalCostUsd, tokens: totalTokens } },
      timeline: entries,
    };
  }

  /**
   * Delete cost entries for a task
   */
  deleteTaskEntries(taskId: string): number {
    if (this.db) {
      const stmt = this.db.prepare("DELETE FROM cost_entries WHERE taskId = ?");
      const result = stmt.run(taskId);
      return result.changes;
    }

    const before = this.inMemoryEntries.length;
    this.inMemoryEntries = this.inMemoryEntries.filter((e) => e.taskId !== taskId);
    return before - this.inMemoryEntries.length;
  }

  /**
   * Update budget configuration
   */
  updateBudgetConfig(config: Partial<BudgetConfig>): void {
    this.budgetConfig = { ...this.budgetConfig, ...config };
  }

  /**
   * Get current budget configuration
   */
  getBudgetConfig(): BudgetConfig {
    return { ...this.budgetConfig };
  }

  private generateId(): string {
    return `cost-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  private rowToCostEntry(row: Record<string, unknown>): CostEntry {
    return {
      id: row.id as string,
      taskId: row.taskId as string,
      agent: row.agent as string,
      model: row.model as string,
      tokensUsed: row.tokensUsed as number,
      inputTokens: row.inputTokens as number,
      outputTokens: row.outputTokens as number,
      costUsd: row.costUsd as number,
      timestamp: row.timestamp as string,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
    };
  }

  close(): void {
    if (this.db) {
      this.db.close();
    }
  }
}
