/**
 * A preset is a predefined prompt + metadata that can be used with `ao spawn --preset <name>`.
 * Presets are trusted (no sanitization or length limits applied to their prompts).
 */
export interface Preset {
  /** Unique name used in `--preset <name>` */
  readonly name: string;
  /** Short description shown in help text */
  readonly description: string;
  /** The full prompt/instructions sent to the spawned agent */
  readonly prompt: string;
  /**
   * Whether this preset accepts an issue argument (e.g. `ao spawn 42 --preset triage`).
   * Defaults to false — most presets are standalone tasks unrelated to a specific issue.
   */
  readonly acceptsIssue?: boolean;
}
