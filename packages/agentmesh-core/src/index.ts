/**
 * AgentMesh Core
 *
 * Main entry point for the AgentMesh coordination layer.
 * Exports all core services and types.
 */

// Types
export * from "./types.js";

// Core Services
export { TaskManager } from "./task-manager.js";
export { MessageBus } from "./message-bus.js";
export { RoleManager } from "./role-manager.js";
export { QALoopEngine } from "./qa-loop.js";
export { PolicyEngine } from "./policy-engine.js";
export { PRGate } from "./pr-gate.js";
export { TimelineLogger } from "./timeline-logger.js";
export { AgentMeshStorage } from "./storage.js";
export { CoordinationService } from "./coordination-service.js";
export { LockManager } from "./lock-manager.js";
export { CostTracker } from "./cost-tracker.js";

// Cost Parsing
export {
  parseCostFromOutput,
  parseMultipleCostEntries,
  aggregateCostEntries,
} from "./cost-parser.js";
export type { ParsedCostMetrics, CostParseResult } from "./cost-parser.js";

// Re-export QA loop types
export type { QALoopState, QALoopConfig, QALoopDecision } from "./qa-loop.js";
