/**
 * Pipeline subsystem — public re-exports.
 *
 * Consumers import from `@aoagents/ao-core` or, for granular bundles,
 * `@aoagents/ao-core/pipeline` (when an export entry is added).
 */

export * from "./types.js";
export type { PipelineEvent, PipelineEffect, ReducerResult } from "./events.js";
export { reduce } from "./reducer.js";
export { createPipelineStore, type PipelineStore, type PersistedStageRun } from "./store.js";
export {
  pipelineLayout,
  runFilePath,
  stageFilePath,
  artifactsDirForRun,
  artifactsFilePath,
  loopFilePath,
  type PipelineLayout,
} from "./paths.js";

export {
  PipelineConfigError,
  getSupportedTaskModes,
  validatePipelineAgentModes,
  validatePipelineDag,
} from "./validation.js";

export { findFirstStageCycle, scheduleAfterChange, type ScheduleResult } from "./dag.js";

export { buildStagePrompt, type StagePromptInput } from "./stage-prompt.js";

export {
  createAgentExecutor,
  AgentExecutorSpawnError,
  STAGE_FINDINGS_RELATIVE_PATH,
  type AgentStageExecutor,
  type AgentExecutorDeps,
  type RunningAgentStage,
  type StageOutcome,
  type StartStageInput,
} from "./executors/index.js";

export {
  createPipelineEngine,
  type PipelineEngine,
  type PipelineEngineDeps,
  type StartRunInput,
} from "./engine.js";

export {
  ConfiguredPipelineSchema,
  PipelinesConfigSchema,
  configuredPipelineToRuntime,
  type ConfiguredPipeline,
  type PipelinesConfig,
} from "./config-schema.js";

export {
  evaluateTrigger,
  decideConcurrencyAction,
  matchesAnyGlob,
  anyValueMatchesAnyGlob,
  triggerEventForPREvent,
  type ConcurrencyAction,
  type ConcurrencyDecisionContext,
  type TriggerEvaluationContext,
} from "./triggers.js";

export {
  runAutoTriggerPass,
  readAutoTriggerState,
  writeAutoTriggerState,
  autoTriggerStatePath,
  makeInitialAutoTriggerState,
  EMPTY_AUTO_TRIGGER_STATE,
  DEFAULT_QUEUE_MAX_AGE_MS,
  type AutoTriggerState,
  type AutoTriggerPassDeps,
  type AutoTriggerPassResult,
  type AutoTriggerActionLog,
  type DispatchInput,
  type QueuedTrigger,
} from "./auto-trigger.js";
