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
  createCommandExecutor,
  CommandExecutorSpawnError,
  formatForkRefusalMessage,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_COMMAND_STDOUT_CAP_BYTES,
  DEFAULT_COMMAND_STDERR_CAP_BYTES,
  COMMAND_KILL_GRACE_MS,
  type CommandExecutorDeps,
  type CommandStageExecutor,
  type CommandStartInput,
  type CommandOutcome,
  type RunningCommandStage,
  parseFindingsJsonl,
  coerceArtifactInput,
  createBuiltinRouterExecutor,
  createBuiltinComposeExecutor,
  type BuiltinExecutor,
  type BuiltinRunInput,
  type BuiltinOutcome,
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
