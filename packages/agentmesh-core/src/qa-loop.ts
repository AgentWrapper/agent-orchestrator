/**
 * QA Loop Engine
 *
 * State machine that manages the builder → QA → rework cycles.
 * Handles retry budgets, escalation, and completion detection.
 */

import type { TaskId, TaskStatus, QAResult } from "./types.js";

export type QALoopState =
  | "idle"
  | "building"
  | "qa_running"
  | "qa_passed"
  | "qa_failed"
  | "rework"
  | "blocked"
  | "done";

export interface QALoopConfig {
  maxRetries: number;
  qaTimeout: number; // milliseconds
  reworkTimeout: number; // milliseconds
  escalateAfterRetries: boolean;
  autoRework: boolean;
}

export class QALoopEngine {
  private state: Map<TaskId, QALoopState>;
  private retryCount: Map<TaskId, number>;
  private config: QALoopConfig;

  constructor(config: Partial<QALoopConfig> = {}) {
    this.state = new Map();
    this.retryCount = new Map();
    this.config = {
      maxRetries: config.maxRetries || 3,
      qaTimeout: config.qaTimeout || 30 * 60 * 1000, // 30 minutes
      reworkTimeout: config.reworkTimeout || 60 * 60 * 1000, // 1 hour
      escalateAfterRetries: config.escalateAfterRetries !== false,
      autoRework: config.autoRework !== false,
    };
  }

  /**
   * Start the QA loop for a task
   */
  start(taskId: TaskId): void {
    this.state.set(taskId, "building");
    this.retryCount.set(taskId, 0);
  }

  /**
   * Transition to QA phase
   */
  startQA(taskId: TaskId): void {
    this.state.set(taskId, "qa_running");
  }

  /**
   * Process QA result
   */
  processQAResult(taskId: TaskId, result: QAResult): QALoopDecision {
    const currentState = this.state.get(taskId);
    if (currentState !== "qa_running") {
      throw new Error(`Cannot process QA result in state: ${currentState}`);
    }

    if (result.verdict === "PASS") {
      this.state.set(taskId, "qa_passed");
      return { action: "proceed", reason: "QA passed" };
    }

    if (result.verdict === "BLOCKED") {
      this.state.set(taskId, "blocked");
      return { action: "block", reason: "QA blocked - critical issues" };
    }

    // QA failed - check retry budget
    const retries = this.retryCount.get(taskId) || 0;
    if (retries >= this.config.maxRetries) {
      this.state.set(taskId, "blocked");
      return {
        action: "escalate",
        reason: `Max retries (${this.config.maxRetries}) exceeded`,
      };
    }

    // Increment retry and request rework
    this.retryCount.set(taskId, retries + 1);
    this.state.set(taskId, "rework");

    return {
      action: "rework",
      reason: `QA failed - retry ${retries + 1}/${this.config.maxRetries}`,
      qaResult: result,
    };
  }

  /**
   * Start rework phase
   */
  startRework(taskId: TaskId): void {
    this.state.set(taskId, "building");
  }

  /**
   * Mark task as done
   */
  complete(taskId: TaskId): void {
    this.state.set(taskId, "done");
  }

  /**
   * Get current state for a task
   */
  getState(taskId: TaskId): QALoopState | null {
    return this.state.get(taskId) || null;
  }

  /**
   * Get retry count for a task
   */
  getRetryCount(taskId: TaskId): number {
    return this.retryCount.get(taskId) || 0;
  }

  /**
   * Map QA loop state to task status
   */
  mapToTaskStatus(qaState: QALoopState): TaskStatus {
    const stateMap: Record<QALoopState, TaskStatus> = {
      idle: "created",
      building: "building",
      qa_running: "qa_running",
      qa_passed: "qa_passed",
      qa_failed: "qa_failed",
      rework: "rework",
      blocked: "blocked",
      done: "done",
    };

    return stateMap[qaState];
  }

  /**
   * Check if task should auto-rework
   */
  shouldAutoRework(taskId: TaskId): boolean {
    const state = this.state.get(taskId);
    const retries = this.retryCount.get(taskId) || 0;

    return this.config.autoRework && state === "rework" && retries < this.config.maxRetries;
  }

  /**
   * Clean up task state
   */
  cleanup(taskId: TaskId): void {
    this.state.delete(taskId);
    this.retryCount.delete(taskId);
  }
}

export interface QALoopDecision {
  action: "proceed" | "rework" | "block" | "escalate";
  reason: string;
  qaResult?: QAResult;
}
