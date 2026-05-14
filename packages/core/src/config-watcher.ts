/**
 * Config hot-reload watcher using c12.
 *
 * Watches `agent-orchestrator.yaml` (or the active config file) for changes
 * and provides validated config updates through a callback interface.
 *
 * Design:
 * - The existing synchronous `loadConfig()` is intentionally UNCHANGED.
 * - This module adds an opt-in async watcher that uses c12's `watchConfig()`.
 * - Reloaded config is validated with the same Zod schemas and post-processing
 *   via `validateConfig()`.
 * - Invalid config changes are rejected; the last-known-good config is kept.
 */

import { dirname } from "node:path";
import { watchConfig as c12WatchConfig } from "c12";
import { validateConfig, findConfigFile } from "./config.js";
import type { LoadedConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Emitted when the config file changes and the new config passes validation. */
export interface ConfigChangeEvent {
  /** The newly validated config. */
  config: LoadedConfig;
  /** The previous config (null on the first successful load). */
  oldConfig: LoadedConfig | null;
  /** Absolute path to the config file that changed. */
  configPath: string;
}

/** Callback invoked on a successful config reload. */
export type ConfigChangeHandler = (event: ConfigChangeEvent) => void;

/** Options for constructing a {@link ConfigWatcher}. */
export interface ConfigWatcherOptions {
  /**
   * Absolute path to the config file to watch.
   * Falls back to `findConfigFile()` when omitted.
   */
  configPath?: string;
  /**
   * Debounce interval in ms for filesystem events.
   * Defaults to c12's built-in default (currently 100 ms).
   */
  debounceMs?: number;
  /** Called when the config file changes and passes validation. */
  onChange?: ConfigChangeHandler;
  /** Called when the reloaded config fails validation. */
  onError?: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// ConfigWatcher
// ---------------------------------------------------------------------------

/**
 * Hot-reload watcher backed by c12's `watchConfig()`.
 *
 * Usage:
 * ```ts
 * const watcher = new ConfigWatcher({
 *   configPath: config.configPath,
 *   onChange: (evt) => { ... },
 *   onError: (err) => { ... },
 * });
 * await watcher.start();
 * // later...
 * await watcher.stop();
 * ```
 */
export class ConfigWatcher {
  private watcher: {
    unwatch: () => Promise<void>;
  } | null = null;
  private currentConfig: LoadedConfig | null = null;
  private configPath: string;
  private debounceMs: number | undefined;
  private onChange?: ConfigChangeHandler;
  private onError?: (error: Error) => void;

  constructor(options: ConfigWatcherOptions = {}) {
    this.configPath = options.configPath ?? findConfigFile() ?? "";
    this.debounceMs = options.debounceMs;
    this.onChange = options.onChange;
    this.onError = options.onError;
  }

  /**
   * Start watching the config file for changes.
   * Throws if no config path is available.
   */
  async start(): Promise<void> {
    if (!this.configPath) {
      throw new Error("No config file found to watch");
    }

    const configFile = this.configPath;

    this.watcher = await c12WatchConfig({
      configFile,
      cwd: dirname(configFile),
      debounce: this.debounceMs,
      onWatch: (event) => {
        // c12 reports file-level events — informational only.
      },
      onUpdate: async ({ newConfig: rawResolved }) => {
        try {
          // rawResolved.config is the merged/loaded raw object from c12.
          const rawConfig = rawResolved.config as unknown;
          const validated = validateConfig(rawConfig);

          const loadedConfig: LoadedConfig = {
            ...validated,
            configPath: configFile,
            degradedProjects: {},
          };

          const event: ConfigChangeEvent = {
            config: loadedConfig,
            oldConfig: this.currentConfig,
            configPath: configFile,
          };

          this.currentConfig = loadedConfig;
          this.onChange?.(event);
        } catch (error) {
          this.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      },
    });
  }

  /** Return the most recently validated config, or null before first load. */
  getCurrentConfig(): LoadedConfig | null {
    return this.currentConfig;
  }

  /** Stop watching. Safe to call multiple times. */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.unwatch();
      this.watcher = null;
    }
  }
}
