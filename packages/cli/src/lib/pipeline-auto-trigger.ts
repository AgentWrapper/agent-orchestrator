/**
 * CLI-side wiring for the pipeline auto-trigger pass.
 *
 * Builds the `pipelineAutoTrigger` callback that `createLifecycleManager`
 * calls once per poll cycle. Per project, this:
 *
 *  1. Loads the pipeline store and persisted last-checked state.
 *  2. Resolves the SCM plugin from project config.
 *  3. Iterates configured pipelines, drives `runAutoTriggerPass` against the
 *     raw `triggerRun` / `cancelRun` adapters in `pipeline-service`.
 *  4. Persists the new state.
 *
 * Why `triggerRun` and not `engine.startRun` (yet)? The PipelineEngine isn't
 * instantiated inside the lifecycle manager today (v0.4 wiring is the next
 * sub-task). Using `triggerRun` here keeps the CLI mutation path consistent
 * with `ao pipeline run` — runs land in the store via the same reducer, and
 * the auto-trigger pass becomes a "headless ao pipeline run" until a real
 * engine takes over.
 *
 * Concurrency policy applies *per pipeline* per the v1.1b spec — any
 * non-terminal run on the same pipelineName counts as "active" regardless
 * of which PR triggered it. SessionId encoding (`pipeline.<name>.pr-<n>`)
 * still scopes loops per PR for trace clarity, but the policy decision
 * looks across all of a pipeline's loops.
 */

import {
  asRunId,
  autoTriggerStatePath,
  createPipelineStore,
  getProjectPipelinesDir,
  readAutoTriggerState,
  runAutoTriggerPass,
  writeAutoTriggerState,
  type AutoTriggerDispatchInput,
  type OrchestratorConfig,
  type Pipeline,
  type PluginRegistry,
  type SCM,
} from "@aoagents/ao-core";

import {
  cancelRun as cancelRunInStore,
  hydrateEngineState,
  listConfiguredPipelines,
  resolveConfiguredPipeline,
  triggerRun,
  LoopAlreadyActiveError,
} from "./pipeline-service.js";

/** Build the lifecycle-manager hook for one or all projects. */
export function createPipelineAutoTrigger(opts: {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  /** When set, only this project is processed; else all configured projects. */
  projectId?: string;
}): () => Promise<void> {
  const { config, registry, projectId } = opts;
  return async () => {
    const projectIds = projectId ? [projectId] : Object.keys(config.projects ?? {});
    for (const pid of projectIds) {
      try {
        await runProjectAutoTrigger(config, registry, pid);
      } catch {
        // Per-project failures must not abort other projects in the loop.
        // The wrapping try/catch in lifecycle-manager.pollAll surfaces the
        // failure to observability if all projects fail in aggregate.
      }
    }
  };
}

async function runProjectAutoTrigger(
  config: OrchestratorConfig,
  registry: PluginRegistry,
  projectId: string,
): Promise<void> {
  const project = config.projects?.[projectId];
  if (!project) return;

  const scmPluginName = project.scm?.plugin;
  if (!scmPluginName) return;
  const scm = registry.get<SCM>("scm", scmPluginName);
  if (!scm) return;

  const summaries = listConfiguredPipelines(config, projectId);
  const pipelines: Pipeline[] = [];
  for (const summary of summaries) {
    try {
      pipelines.push(resolveConfiguredPipeline(config, projectId, summary.pipelineId));
    } catch {
      // Misconfigured pipeline — config-load already surfaced these.
    }
  }
  if (pipelines.length === 0) return;

  const pipelinesDir = getProjectPipelinesDir(projectId);
  const store = createPipelineStore(pipelinesDir);
  const statePath = autoTriggerStatePath(pipelinesDir);
  const prevState = await readAutoTriggerState(statePath);

  const sessionIdFor = (pipelineName: string, prNumber: number): string =>
    `pipeline.${pipelineName}.pr-${prNumber}`;

  const isActiveRunForPipeline = (pipelineName: string): boolean => {
    const engineState = hydrateEngineState(store);
    for (const runId of Object.values(engineState.currentRunByLoop)) {
      const run = engineState.runs[runId];
      if (run && run.pipelineName === pipelineName) return true;
    }
    return false;
  };

  const cancelActiveRunsForPipeline = async (pipelineName: string): Promise<void> => {
    const engineState = hydrateEngineState(store);
    for (const runId of Object.values(engineState.currentRunByLoop)) {
      const run = engineState.runs[runId];
      if (run && run.pipelineName === pipelineName) {
        try {
          cancelRunInStore(store, asRunId(runId));
        } catch {
          // Run may have just terminated; cancel is a no-op then.
        }
      }
    }
  };

  const startRunFor = async (input: AutoTriggerDispatchInput): Promise<void> => {
    const pipeline = pipelines.find((p) => p.name === input.pipelineName);
    if (!pipeline) return;
    const sessionId = sessionIdFor(input.pipelineName, input.prNumber);
    try {
      triggerRun(store, registry, pipeline, {
        sessionId,
        headSha: `auto:${input.triggerEventType}:pr-${input.prNumber}`,
      });
    } catch (err) {
      if (err instanceof LoopAlreadyActiveError) return;
      throw err;
    }
  };

  const result = await runAutoTriggerPass(prevState, {
    scm,
    pipelines,
    isActiveRun: isActiveRunForPipeline,
    startRun: startRunFor,
    cancelActiveRun: cancelActiveRunsForPipeline,
  });

  await writeAutoTriggerState(statePath, result.state);
}
