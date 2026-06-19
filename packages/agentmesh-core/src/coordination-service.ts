/**
 * Coordination Service
 *
 * Integrates AgentMesh coordination layer with AO's SessionManager and LifecycleManager.
 * Bridges the gap between AO's infrastructure and AgentMesh's coordination features.
 */

import type { SessionManager, SessionId } from "@aoagents/ao-core";
import { TaskManager } from "./task-manager.js";
import { MessageBus } from "./message-bus.js";
import { RoleManager } from "./role-manager.js";
import { QALoopEngine, type QALoopDecision } from "./qa-loop.js";
import { PolicyEngine } from "./policy-engine.js";
import { PRGate } from "./pr-gate.js";
import { TimelineLogger } from "./timeline-logger.js";
import { AgentMeshStorage } from "./storage.js";
import { LockManager } from "./lock-manager.js";
import { CostTracker } from "./cost-tracker.js";
import { parseCostFromOutput } from "./cost-parser.js";
import type {
  Task,
  TaskId,
  TaskPriority,
  AgentRole,
  QAResult,
  LockRequest,
  AgentMeshAgentAdapter,
} from "./types.js";

export class CoordinationService {
  private taskManager: TaskManager;
  private messageBus: MessageBus;
  private roleManager: RoleManager;
  private qaLoopEngine: QALoopEngine;
  private policyEngine: PolicyEngine;
  private prGate: PRGate;
  private timelineLogger: TimelineLogger;
  private storage: AgentMeshStorage;
  private sessionManager: SessionManager;
  private adapterRegistry: Map<string, AgentMeshAgentAdapter>;
  private lockManager: LockManager;
  private costTracker: CostTracker;

  constructor(sessionManager: SessionManager, projectId: string, basePath?: string) {
    this.sessionManager = sessionManager;
    this.storage = new AgentMeshStorage(projectId, basePath);

    // Initialize AgentMesh services
    this.taskManager = new TaskManager(this.storage.getTasksPath());
    this.messageBus = new MessageBus(this.storage.getMessagesPath());
    this.roleManager = new RoleManager();
    this.qaLoopEngine = new QALoopEngine();
    this.policyEngine = new PolicyEngine();
    this.prGate = new PRGate();
    this.timelineLogger = new TimelineLogger(this.storage.getTimelinePath());
    this.lockManager = new LockManager(this.storage.getTasksPath()); // Use same storage path
    this.costTracker = new CostTracker(this.storage.getTasksPath()); // Use same storage path

    this.adapterRegistry = new Map();

    // Subscribe to message bus events
    this.setupMessageHandlers();
  }

  /**
   * Register an agent adapter
   */
  registerAdapter(name: string, adapter: AgentMeshAgentAdapter): void {
    this.adapterRegistry.set(name, adapter);
  }

  /**
   * Get an adapter by name
   */
  getAdapter(name: string): AgentMeshAgentAdapter | null {
    return this.adapterRegistry.get(name) || null;
  }

  /**
   * Create a new task and start the coordination workflow
   */
  async createTask(config: {
    title: string;
    description: string;
    role: string;
    priority: string;
    projectId: string;
    branch: string;
    issueId?: string;
    issueUrl?: string;
  }): Promise<Task> {
    try {
      const task = this.taskManager.create({
        title: config.title,
        description: config.description,
        status: "created",
        priority: config.priority as TaskPriority,
        role: config.role as AgentRole,
        projectId: config.projectId,
        branch: config.branch,
        issueId: config.issueId,
        issueUrl: config.issueUrl,
        metadata: {},
      });

      // Log task creation
      this.timelineLogger.log({
        taskId: task.id,
        eventType: "task_created",
        data: { task },
        source: "coordination_service",
      });

      return task;
    } catch (error) {
      this.timelineLogger.log({
        taskId: "unknown",
        eventType: "task_creation_failed",
        data: { error: String(error), config },
        source: "coordination_service",
      });
      throw new Error(
        `Failed to create task: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * Start the builder phase for a task
   */
  async startBuilder(taskId: TaskId): Promise<void> {
    try {
      const task = this.taskManager.get(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      // Update task status
      this.taskManager.transitionStatus(taskId, "building");
      this.qaLoopEngine.start(taskId);

      // Get the adapter for this role
      const adapterName = this.roleManager.getAdapterForRole(task.role);
      const adapter = this.getAdapter(adapterName);

      if (!adapter) {
        throw new Error(`Adapter not found for role: ${task.role}`);
      }

      // Preflight check
      const preflight = await adapter.preflight({
        role: task.role,
        workspacePath: "", // Will be set by AO
      });

      if (!preflight.ok) {
        this.taskManager.transitionStatus(taskId, "blocked");
        this.timelineLogger.log({
          taskId,
          eventType: "preflight_failed",
          data: { adapter: adapterName, warnings: preflight.warnings },
          source: "coordination_service",
        });
        throw new Error(
          `Preflight failed for ${adapterName}: ${(preflight.warnings ?? []).join(", ")}`,
        );
      }

      // Start the agent session
      const agentSession = await adapter.start({
        taskId,
        role: task.role,
        prompt: this.roleManager.assemblePrompt(task.role, task.description),
        workspacePath: "", // Will be set by AO
        branch: task.branch,
      });

      // Store AO session ID in task metadata
      this.taskManager.update(taskId, {
        metadata: {
          ...task.metadata,
          aoSessionId: agentSession.aoSessionId,
          adapter: adapterName,
        },
      });

      // Parse and record cost from agent output
      try {
        const output = await adapter.getOutput(agentSession, { lines: 100 });
        const costResult = parseCostFromOutput(output.text, adapterName);

        if (costResult.metrics) {
          this.costTracker.recordCost({
            taskId,
            agent: adapterName,
            model: costResult.metrics.model,
            tokensUsed: costResult.metrics.totalTokens,
            inputTokens: costResult.metrics.inputTokens,
            outputTokens: costResult.metrics.outputTokens,
            costUsd: costResult.metrics.costUsd,
            metadata: {
              phase: "start",
              role: task.role,
              confidence: costResult.metrics.confidence,
            },
          });
        } else {
          // Fallback to placeholder if parsing failed
          this.costTracker.recordCost({
            taskId,
            agent: adapterName,
            model: "unknown",
            tokensUsed: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            metadata: { phase: "start", role: task.role, parseErrors: costResult.parseErrors },
          });
        }
      } catch (error) {
        // If output capture fails, record zero cost
        this.costTracker.recordCost({
          taskId,
          agent: adapterName,
          model: "unknown",
          tokensUsed: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          metadata: { phase: "start", role: task.role, error: String(error) },
        });
      }

      // Log builder start
      this.timelineLogger.log({
        taskId,
        eventType: "builder_started",
        data: { aoSessionId: agentSession.aoSessionId, adapter: adapterName },
        source: "coordination_service",
      });

      // Send message through bus
      this.messageBus.send({
        type: "task_assignment",
        from: "system",
        to: taskId,
        body: `Builder started for task: ${task.title}`,
        data: { role: task.role, adapter: adapterName },
      });
    } catch (error) {
      this.taskManager.transitionStatus(taskId, "blocked");
      this.timelineLogger.log({
        taskId,
        eventType: "builder_start_failed",
        data: { error: String(error) },
        source: "coordination_service",
      });
      throw error;
    }
  }

  /**
   * Handle builder completion and start QA
   */
  async handleBuilderComplete(taskId: TaskId): Promise<void> {
    try {
      const task = this.taskManager.get(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      // Transition to QA phase
      this.qaLoopEngine.startQA(taskId);
      this.taskManager.transitionStatus(taskId, "qa_running");

      // Get QA adapter
      const qaAdapter = this.getAdapter("codex"); // Codex is default for QA
      if (!qaAdapter) {
        throw new Error("QA adapter not found");
      }

      // Start QA session
      const qaSession = await qaAdapter.start({
        taskId,
        role: "qa",
        prompt: this.roleManager.assemblePrompt("qa", task.description),
        workspacePath: "", // Will be set by AO
        branch: task.branch,
      });

      // Store QA session ID
      this.taskManager.update(taskId, {
        metadata: {
          ...task.metadata,
          qaSessionId: qaSession.aoSessionId,
        },
      });

      // Parse and record QA cost from agent output
      try {
        const output = await qaAdapter.getOutput(qaSession, { lines: 100 });
        const costResult = parseCostFromOutput(output.text, "codex");

        if (costResult.metrics) {
          this.costTracker.recordCost({
            taskId,
            agent: "codex",
            model: costResult.metrics.model,
            tokensUsed: costResult.metrics.totalTokens,
            inputTokens: costResult.metrics.inputTokens,
            outputTokens: costResult.metrics.outputTokens,
            costUsd: costResult.metrics.costUsd,
            metadata: {
              phase: "qa",
              role: "qa",
              confidence: costResult.metrics.confidence,
            },
          });
        } else {
          this.costTracker.recordCost({
            taskId,
            agent: "codex",
            model: "unknown",
            tokensUsed: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            metadata: { phase: "qa", role: "qa", parseErrors: costResult.parseErrors },
          });
        }
      } catch (error) {
        this.costTracker.recordCost({
          taskId,
          agent: "codex",
          model: "unknown",
          tokensUsed: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          metadata: { phase: "qa", role: "qa", error: String(error) },
        });
      }

      // Log QA start
      this.timelineLogger.log({
        taskId,
        eventType: "qa_started",
        data: { qaSessionId: qaSession.aoSessionId },
        source: "coordination_service",
      });

      // Send message through bus
      this.messageBus.send({
        type: "qa_request",
        from: "system",
        to: taskId,
        body: `QA started for task: ${task.title}`,
        data: { qaSessionId: qaSession.aoSessionId },
      });
    } catch (error) {
      this.taskManager.transitionStatus(taskId, "blocked");
      this.timelineLogger.log({
        taskId,
        eventType: "qa_start_failed",
        data: { error: String(error) },
        source: "coordination_service",
      });
      throw error;
    }
  }

  /**
   * Process QA result and determine next action
   */
  async processQAResult(taskId: TaskId, qaResult: QAResult): Promise<QALoopDecision> {
    try {
      const decision = this.qaLoopEngine.processQAResult(taskId, qaResult);

      // Log QA result
      this.timelineLogger.log({
        taskId,
        eventType: "qa_result",
        data: { qaResult, decision },
        source: "coordination_service",
      });

      // Send message through bus
      this.messageBus.send({
        type: "qa_result",
        from: taskId,
        to: "system",
        body: `QA ${qaResult.verdict}: ${qaResult.summary}`,
        data: { qaResult, decision },
      });

      // Update task status based on decision
      if (decision.action === "proceed") {
        this.taskManager.transitionStatus(taskId, "qa_passed");
        await this.handleQAPassed(taskId);
      } else if (decision.action === "rework") {
        this.taskManager.transitionStatus(taskId, "rework");
        await this.handleRework(taskId, decision);
      } else if (decision.action === "block") {
        this.taskManager.transitionStatus(taskId, "blocked");
      } else if (decision.action === "escalate") {
        this.taskManager.transitionStatus(taskId, "blocked");
        // TODO: Implement escalation logic
      }

      return decision;
    } catch (error) {
      this.timelineLogger.log({
        taskId,
        eventType: "qa_result_processing_failed",
        data: { error: String(error), qaResult },
        source: "coordination_service",
      });
      throw new Error(
        `Failed to process QA result: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * Handle QA passed - check policy and open PR
   */
  private async handleQAPassed(taskId: TaskId): Promise<void> {
    try {
      const task = this.taskManager.get(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      // Get diff for policy check
      const diff = await this.getDiff(taskId);

      // Run policy check
      const policyResult = this.policyEngine.check(diff, {
        taskId,
        branch: task.branch,
        files: [], // Would need to get actual file list
        agentRole: task.role,
      });

      // Log policy check
      this.timelineLogger.log({
        taskId,
        eventType: "policy_check",
        data: { policyResult },
        source: "coordination_service",
      });

      // Check PR gate
      const prGateResult = this.prGate.canOpenPR({
        qaResult: { verdict: "PASS", summary: "QA passed", findings: [] },
        policyResult,
      });

      if (prGateResult.canOpen) {
        await this.openPR(taskId);
      } else {
        this.taskManager.transitionStatus(taskId, "blocked");
        this.timelineLogger.log({
          taskId,
          eventType: "pr_gate_blocked",
          data: { prGateResult },
          source: "coordination_service",
        });
      }
    } catch (error) {
      this.taskManager.transitionStatus(taskId, "blocked");
      this.timelineLogger.log({
        taskId,
        eventType: "qa_passed_handling_failed",
        data: { error: String(error) },
        source: "coordination_service",
      });
      throw error;
    }
  }

  /**
   * Handle rework - send findings back to builder
   */
  private async handleRework(taskId: TaskId, decision: QALoopDecision): Promise<void> {
    try {
      const task = this.taskManager.get(taskId);
      if (!task || !decision.qaResult) throw new Error(`Task or QA result not found: ${taskId}`);

      // Get builder adapter
      const adapter = this.getAdapter((task.metadata?.adapter as string) || "claude-code");
      if (!adapter) throw new Error(`Adapter not found for task: ${taskId}`);

      const agentSession = {
        aoSessionId: task.metadata?.aoSessionId as SessionId,
        taskId,
        role: task.role,
        startedAt: new Date(task.startedAt || task.createdAt),
      };

      // Send rework message with QA findings
      await adapter.sendMessage(agentSession, {
        type: "rework_request",
        body: `QA failed. Please address the following issues:\n\n${decision.qaResult.summary}\n\nFindings:\n${decision.qaResult.findings.map((f) => `- [${f.severity.toUpperCase()}] ${f.message}`).join("\n")}`,
        attachments: { qaResult: JSON.stringify(decision.qaResult) },
      });

      // Start rework phase
      this.qaLoopEngine.startRework(taskId);
      this.taskManager.transitionStatus(taskId, "building");

      // Parse and record rework cost from agent output
      try {
        const output = await adapter.getOutput(agentSession, { lines: 100 });
        const costResult = parseCostFromOutput(
          output.text,
          (task.metadata?.adapter as string) || "claude-code",
        );

        if (costResult.metrics) {
          this.costTracker.recordCost({
            taskId,
            agent: (task.metadata?.adapter as string) || "claude-code",
            model: costResult.metrics.model,
            tokensUsed: costResult.metrics.totalTokens,
            inputTokens: costResult.metrics.inputTokens,
            outputTokens: costResult.metrics.outputTokens,
            costUsd: costResult.metrics.costUsd,
            metadata: {
              phase: "rework",
              retryCount: this.qaLoopEngine.getRetryCount(taskId),
              confidence: costResult.metrics.confidence,
            },
          });
        } else {
          this.costTracker.recordCost({
            taskId,
            agent: (task.metadata?.adapter as string) || "claude-code",
            model: "unknown",
            tokensUsed: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            metadata: {
              phase: "rework",
              retryCount: this.qaLoopEngine.getRetryCount(taskId),
              parseErrors: costResult.parseErrors,
            },
          });
        }
      } catch (error) {
        this.costTracker.recordCost({
          taskId,
          agent: (task.metadata?.adapter as string) || "claude-code",
          model: "unknown",
          tokensUsed: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          metadata: {
            phase: "rework",
            retryCount: this.qaLoopEngine.getRetryCount(taskId),
            error: String(error),
          },
        });
      }

      // Log rework
      this.timelineLogger.log({
        taskId,
        eventType: "rework_started",
        data: { retryCount: this.qaLoopEngine.getRetryCount(taskId) },
        source: "coordination_service",
      });
    } catch (error) {
      this.timelineLogger.log({
        taskId,
        eventType: "rework_handling_failed",
        data: { error: String(error) },
        source: "coordination_service",
      });
      throw error;
    }
  }

  /**
   * Open a PR for the task
   */
  private async openPR(taskId: TaskId): Promise<void> {
    try {
      const task = this.taskManager.get(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      // This would integrate with AO's SCM plugin to actually open the PR
      // For now, just update task status
      this.taskManager.transitionStatus(taskId, "pr_opening");

      this.timelineLogger.log({
        taskId,
        eventType: "pr_opening",
        data: { branch: task.branch },
        source: "coordination_service",
      });

      // TODO: Integrate with AO's SCM plugin
      // const scm = this.sessionManager.getPlugin("scm");
      // await scm.openPR({ branch: task.branch, title: task.title, ... });
    } catch (error) {
      this.taskManager.transitionStatus(taskId, "blocked");
      this.timelineLogger.log({
        taskId,
        eventType: "pr_opening_failed",
        data: { error: String(error) },
        source: "coordination_service",
      });
      throw error;
    }
  }

  /**
   * Get diff for a task
   */
  private async getDiff(taskId: TaskId): Promise<string> {
    const task = this.taskManager.get(taskId);
    if (!task) return "";

    // This would integrate with AO to get the actual diff
    // For now, return empty string
    return "";
  }

  /**
   * Setup message bus handlers
   */
  private setupMessageHandlers(): void {
    this.messageBus.subscribe("work_complete", (message) => {
      // Handle work complete message
      console.log("Work complete:", message);
    });

    this.messageBus.subscribe("error", (message) => {
      // Handle error message
      console.error("Error:", message);
    });
  }

  /**
   * Get task status
   */
  getTaskStatus(taskId: TaskId): string | null {
    const qaState = this.qaLoopEngine.getState(taskId);
    return qaState ? this.qaLoopEngine.mapToTaskStatus(qaState) : null;
  }

  /**
   * Get a task by ID
   */
  getTask(taskId: TaskId) {
    return this.taskManager.get(taskId);
  }

  /**
   * List all tasks
   */
  listTasks() {
    return this.taskManager.list();
  }

  /**
   * Delete a task
   */
  deleteTask(taskId: TaskId) {
    this.taskManager.delete(taskId);
  }

  /**
   * Acquire locks for a task before starting work
   */
  async acquireTaskLocks(taskId: TaskId, resources: string[]): Promise<boolean> {
    const task = this.taskManager.get(taskId);
    if (!task) return false;

    const conflicts = this.lockManager.checkConflicts(resources, taskId);
    if (conflicts.length > 0) {
      this.timelineLogger.log({
        taskId,
        eventType: "lock_conflict",
        data: { conflicts, resources },
        source: "coordination_service",
      });
      return false;
    }

    // Acquire locks for all resources
    const lockRequests: LockRequest[] = resources.map((resource) => ({
      type: "file",
      resource,
      owner: taskId,
      duration: 3600000, // 1 hour default
      reason: `Task ${task.title} (${task.role})`,
      metadata: { taskId, role: task.role },
    }));

    const locks = this.lockManager.acquireMultiple(lockRequests);

    if (locks.length === resources.length) {
      this.timelineLogger.log({
        taskId,
        eventType: "locks_acquired",
        data: { lockCount: locks.length, resources },
        source: "coordination_service",
      });

      // Store lock IDs in task metadata
      this.taskManager.update(taskId, {
        metadata: {
          ...task.metadata,
          locks: locks.map((l) => l.id),
        },
      });

      return true;
    }

    return false;
  }

  /**
   * Release locks for a task
   */
  releaseTaskLocks(taskId: TaskId): void {
    const task = this.taskManager.get(taskId);
    if (!task) return;

    const lockIds = (task.metadata?.locks as string[]) || [];

    for (const lockId of lockIds) {
      this.lockManager.release(lockId);
    }

    this.timelineLogger.log({
      taskId,
      eventType: "locks_released",
      data: { lockCount: lockIds.length },
      source: "coordination_service",
    });

    // Clear locks from task metadata
    this.taskManager.update(taskId, {
      metadata: {
        ...task.metadata,
        locks: [],
      },
    });
  }

  /**
   * Get all active locks
   */
  getActiveLocks() {
    return this.lockManager.getAllActiveLocks();
  }

  /**
   * Check if a resource is locked
   */
  isResourceLocked(resource: string): boolean {
    return this.lockManager.isLocked(resource);
  }

  /**
   * Send a message to a running session via AO's SessionManager
   */
  async sendToSession(sessionId: string, message: string): Promise<void> {
    try {
      await this.sessionManager.send(sessionId, message);
    } catch (error) {
      this.timelineLogger.log({
        taskId: "unknown",
        eventType: "send_to_session_failed",
        data: { sessionId, error: String(error) },
        source: "coordination_service",
      });
      throw new Error(
        `Failed to send message to session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * Get a session via AO's SessionManager
   */
  async getSession(sessionId: string) {
    try {
      return await this.sessionManager.get(sessionId);
    } catch (error) {
      this.timelineLogger.log({
        taskId: "unknown",
        eventType: "get_session_failed",
        data: { sessionId, error: String(error) },
        source: "coordination_service",
      });
      throw new Error(
        `Failed to get session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * List sessions via AO's SessionManager
   */
  async listSessions(projectId?: string) {
    try {
      return await this.sessionManager.list(projectId);
    } catch (error) {
      this.timelineLogger.log({
        taskId: "unknown",
        eventType: "list_sessions_failed",
        data: { projectId, error: String(error) },
        source: "coordination_service",
      });
      throw new Error(
        `Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * Kill a session via AO's SessionManager
   */
  async killSession(sessionId: string): Promise<void> {
    try {
      await this.sessionManager.kill(sessionId);
    } catch (error) {
      this.timelineLogger.log({
        taskId: "unknown",
        eventType: "kill_session_failed",
        data: { sessionId, error: String(error) },
        source: "coordination_service",
      });
      throw new Error(
        `Failed to kill session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * Spawn a session via AO's SessionManager for AgentMesh
   */
  async spawnAgentSession(config: {
    taskId: TaskId;
    agent: string;
    branch?: string;
    prompt?: string;
  }) {
    const session = await this.sessionManager.spawn({
      projectId: "agentmesh",
      issueId: config.taskId,
      branch: config.branch,
      agent: config.agent,
      prompt: config.prompt,
    });

    this.timelineLogger.log({
      taskId: config.taskId,
      eventType: "session_spawned",
      data: { sessionId: session.id, agent: config.agent },
      source: "coordination_service",
    });

    return session;
  }

  /**
   * Record cost from an agent operation
   */
  recordAgentCost(
    taskId: string,
    agent: string,
    model: string,
    tokensUsed: number,
    costUsd: number,
  ): void {
    this.costTracker.recordCost({
      taskId,
      agent,
      model,
      tokensUsed,
      inputTokens: Math.floor(tokensUsed * 0.3), // Estimate
      outputTokens: Math.floor(tokensUsed * 0.7), // Estimate
      costUsd,
      metadata: {},
    });

    // Check budget
    const budgetCheck = this.costTracker.checkTaskBudget(taskId);
    if (!budgetCheck.withinBudget) {
      this.timelineLogger.log({
        taskId,
        eventType: "budget_exceeded",
        data: { budgetCheck },
        source: "coordination_service",
      });
    }
  }

  /**
   * Get cost summary for a task
   */
  getTaskCostSummary(taskId: string) {
    return this.costTracker.getTaskSummary(taskId);
  }

  /**
   * Check if a task is within budget
   */
  checkTaskBudget(taskId: string) {
    return this.costTracker.checkTaskBudget(taskId);
  }

  /**
   * Check daily budget
   */
  checkDailyBudget() {
    return this.costTracker.checkDailyBudget();
  }

  /**
   * Update budget configuration
   */
  updateBudgetConfig(config: {
    maxCostPerTask?: number;
    maxCostPerDay?: number;
    maxTokensPerTask?: number;
    alertThreshold?: number;
  }): void {
    this.costTracker.updateBudgetConfig(config);
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.taskManager.close();
  }
}
