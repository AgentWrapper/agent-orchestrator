/**
 * Session manager factory for the CLI.
 *
 * Creates a PluginRegistry with all available plugins loaded,
 * then creates a SessionManager instance backed by core's implementation.
 * This ensures the CLI uses the same hash-based naming, metadata format,
 * and plugin abstractions as the rest of the system.
 */

import {
  createPluginRegistry,
  createSessionManager,
  createLifecycleManager,
  type OrchestratorConfig,
  type OpenCodeSessionManager,
  type PluginRegistry,
  type LifecycleManager,
} from "@aoagents/ao-core";
import { importPluginModuleFromSource } from "./plugin-store.js";

const registryPromises = new Map<string, Promise<PluginRegistry>>();

function getRegistryCacheKey(config: OrchestratorConfig): string {
  return config.configPath || "__default__";
}

/**
 * Get or create the plugin registry.
 * Caches the Promise (not the resolved value) so concurrent callers
 * await the same initialization rather than racing.
 */
export async function getPluginRegistry(config: OrchestratorConfig): Promise<PluginRegistry> {
  const cacheKey = getRegistryCacheKey(config);
  let registryPromise = registryPromises.get(cacheKey);

  if (!registryPromise) {
    registryPromise = (async () => {
      const registry = createPluginRegistry();
      // Prefer the AO-managed plugin store when a package is installed there,
      // but still fall back to the CLI/workspace dependency tree for built-ins.
      await registry.loadFromConfig(config, importPluginModuleFromSource);
      return registry;
    })().catch((err) => {
      registryPromises.delete(cacheKey);
      throw err;
    });
    registryPromises.set(cacheKey, registryPromise);
  }

  return registryPromise;
}

/**
 * Create a SessionManager backed by core's implementation.
 * Initializes the plugin registry from config and wires everything up.
 */
export async function getSessionManager(
  config: OrchestratorConfig,
): Promise<OpenCodeSessionManager> {
  const registry = await getPluginRegistry(config);
  return createSessionManager({ config, registry });
}

/**
 * Create a LifecycleManager backed by core's implementation.
 * Shares the same plugin registry initialization path as SessionManager.
 */
export async function getLifecycleManager(
  config: OrchestratorConfig,
  projectId?: string,
): Promise<LifecycleManager> {
  const registry = await getPluginRegistry(config);
  const sessionManager = createSessionManager({ config, registry });
  return createLifecycleManager({ config, registry, sessionManager, projectId });
}
