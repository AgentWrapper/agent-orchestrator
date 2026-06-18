/**
 * AgentMesh Core Types
 *
 * Type definitions for the AgentMesh coordination layer.
 * This extends the AO core types with coordination-specific concepts.
 */

import type { SessionId } from "@aoagents/ao-core";

// =============================================================================
// TASK
// =============================================================================

export type TaskId = string;
export type TaskStatus =
  | "created"
  | "assigned"
  | "building"
  | "qa_running"
  | "qa_passed"
  | "qa_failed"
  | "rework"
  | "pr_opening"
  | "pr_open"
  | "done"
  | "blocked"
  | "cancelled";

export type TaskPriority = "low" | "medium" | "high" | "critical";

export interface Task {
  id: TaskId;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  role: AgentRole;
  assignee?: string; // Agent adapter name
  projectId: string;
  branch: string;
  issueId?: string;
  issueUrl?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  metadata: Record<string, unknown>;
}

// =============================================================================
// AGENT ROLES
// =============================================================================

export type AgentRole =
  | "builder"
  | "qa"
  | "planner"
  | "security_reviewer"
  | "docs_writer"
  | "release_manager"
  | "external_reviewer"
  | "async_builder"
  | "pr_fixer"
  | "regression_checker";

export interface RoleDefinition {
  name: AgentRole;
  displayName: string;
  description: string;
  agentAdapter: string; // Which agent adapter to use
  promptTemplate: string;
  permissions: string[];
  capabilities: string[];
}

// =============================================================================
// MESSAGES
// =============================================================================

export type MessageType =
  | "task_assignment"
  | "work_complete"
  | "qa_request"
  | "qa_result"
  | "rework_request"
  | "policy_check"
  | "pr_request"
  | "error"
  | "status_update";

export interface AgentMeshMessage {
  id: string;
  type: MessageType;
  from: TaskId | "system";
  to: TaskId | "system";
  timestamp: string;
  body: string;
  data?: Record<string, unknown>;
  attachments?: Record<string, string>;
}

// =============================================================================
// QA LOOP
// =============================================================================

export type QAVerdict = "PASS" | "FAIL" | "BLOCKED";

export interface QAResult {
  verdict: QAVerdict;
  summary: string;
  findings: QAFinding[];
  diff?: string; // Git diff for policy checking
  score?: number; // 0-100 confidence score
  metadata?: Record<string, unknown>;
}

export interface QAFinding {
  severity: "critical" | "major" | "minor" | "info";
  category: string;
  message: string;
  file?: string;
  line?: number;
  code?: string;
}

export interface QAReport {
  taskId: TaskId;
  agentAdapter: string;
  verdict: QAVerdict;
  summary: string;
  findings: QAFinding[];
  timestamp: string;
  sessionOutput: string;
}

// =============================================================================
// POLICY ENGINE
// =============================================================================

export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  severity: "error" | "warning" | "info";
  check: (diff: string, context: PolicyContext) => PolicyViolation[];
}

export interface PolicyContext {
  taskId: TaskId;
  branch: string;
  files: string[];
  agentRole: AgentRole;
}

export interface PolicyViolation {
  ruleId: string;
  message: string;
  file?: string;
  line?: number;
  severity: "error" | "warning" | "info";
}

export interface PolicyCheckResult {
  passed: boolean;
  violations: PolicyViolation[];
  blocked: boolean;
}

// =============================================================================
// PR GATE
// =============================================================================

export interface PRGateConfig {
  requireQAPass: boolean;
  requirePolicyCheck: boolean;
  autoMergeOnPass: boolean;
  requiredApprovals: number;
  blockOnPolicyViolation: boolean;
}

export interface PRGateResult {
  canOpen: boolean;
  reasons: string[];
  qaPassed?: boolean;
  policyPassed?: boolean;
  approvalsMet?: boolean;
}

// =============================================================================
// AGENT ADAPTER
// =============================================================================

export interface AgentMeshAgentAdapter {
  name: string;
  displayName: string;
  preflight(context: PreflightContext): Promise<PreflightResult>;
  start(config: AgentStartConfig): Promise<AgentSession>;
  sendMessage(session: AgentSession, message: AgentMessage): Promise<void>;
  getOutput(session: AgentSession, options?: OutputOptions): Promise<AgentOutput>;
  getStatus(session: AgentSession): Promise<AgentStatus>;
  stop(session: AgentSession): Promise<void>;
  resume?(session: AgentSession): Promise<void>;
  getSessionInfo?(session: AgentSession): Promise<AgentSessionInfo | null>;
}

export interface PreflightContext {
  role: AgentRole;
  workspacePath: string;
  agentConfig?: Record<string, unknown>;
}

export interface PreflightResult {
  ok: boolean;
  version?: string;
  warnings?: string[];
}

export interface OutputOptions {
  lines?: number;
}

export interface AgentStartConfig {
  taskId: TaskId;
  role: AgentRole;
  prompt: string;
  workspacePath: string;
  branch: string;
  environment?: Record<string, string>;
}

export interface AgentSession {
  aoSessionId: SessionId;
  taskId: TaskId;
  role: AgentRole;
  startedAt: Date;
}

export interface AgentMessage {
  type: MessageType;
  body: string;
  attachments?: Record<string, string>;
}

export interface AgentOutput {
  text: string;
  capturedAt: Date;
  linesRead: number;
}

export type AgentStatus = "active" | "ready" | "idle" | "waiting_input" | "blocked" | "exited";

export interface AgentSessionInfo {
  summary?: string;
  costUsd?: number;
  tokensUsed?: number;
  turnsCompleted?: number;
}

// =============================================================================
// TIMELINE
// =============================================================================

export interface TimelineEvent {
  id: string;
  taskId: TaskId;
  timestamp: string;
  eventType: string;
  data: Record<string, unknown>;
  source: string;
}

// =============================================================================
// STORAGE
// =============================================================================

export interface AgentMeshStorage {
  taskDir: string;
  messageLog: string;
  timelineLog: string;
  databasePath: string;
}

// =============================================================================
// LOCK MANAGEMENT
// =============================================================================

export type LockType = "file" | "directory" | "branch" | "feature";

export interface LockRequest {
  type: LockType;
  resource: string;
  owner: string;
  duration: number; // milliseconds
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface Lock {
  id: string;
  type: LockType;
  resource: string;
  owner: string;
  acquiredAt: string;
  expiresAt: string;
  reason: string;
  metadata: Record<string, unknown>;
}

// =============================================================================
// COST TRACKING
// =============================================================================

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
