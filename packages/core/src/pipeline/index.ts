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

export {
  evaluateRunExitOutcome,
  findFirstStageCycle,
  predicateContextForRun,
  scheduleAfterChange,
  type RunExitOutcome,
  type ScheduleResult,
} from "./dag.js";

export {
  PredicateSchema,
  MAX_PREDICATE_DEPTH,
  collectReferencedStages,
  evaluateExitPredicates,
  evaluatePredicate,
  fromLegacyRoutePredicate,
  isLegacyRoutePredicate,
  normalizeRoutePredicate,
  predicateDepth,
  validateRoutePredicateScope,
  type PredicateContext,
} from "./predicate.js";

export {
  classifyConfigChange,
  type ConfigChangeClassification,
  type ConfigChangeKind,
} from "./config-diff.js";

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
