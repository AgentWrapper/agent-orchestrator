/**
 * Agent Orchestrator — Core Type Definitions (barrel)
 * ============================================================================
 *
 * This module is the single, stable entry point for ALL core type
 * definitions. Every plugin, CLI command, and web API route builds against
 * the names re-exported here. It does not declare anything itself — the
 * actual declarations live in the co-located modules under `types/`, and
 * this file simply re-exports them.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS A BARREL (and must stay at this exact path)
 * ---------------------------------------------------------------------------
 * Two parts of the public surface depend on a module existing at
 * `packages/core/src/types.ts` that exports every core name:
 *
 *   1. `index.ts` does `export * from "./types.js"`, so the package root
 *      (`@aoagents/ao-core`) re-exports all of these names.
 *   2. `package.json` exposes a subpath export `"./types"` →
 *      `dist/types.d.ts` / `dist/types.js`. Other packages import directly
 *      via `import { ... } from "@aoagents/ao-core/types"` (~15 call sites
 *      across cli, web, and the plugins).
 *
 * Therefore this file MUST remain here and MUST keep re-exporting the same
 * names. The declarations were moved into `types/` (issue ComposioHQ#2024,
 * PR 1) purely to break up a 2000+ line god-file — the external API is
 * byte-for-byte unchanged.
 *
 * ---------------------------------------------------------------------------
 * ARCHITECTURE THESE TYPES DESCRIBE: 8 plugin slots + core services
 * ---------------------------------------------------------------------------
 *   1. Runtime    — where sessions execute (tmux, docker, k8s, process)
 *   2. Agent      — AI coding tool (claude-code, codex, aider, opencode)
 *   3. Workspace  — code isolation (worktree, clone)
 *   4. Tracker    — issue tracking (github, linear, gitlab)
 *   5. SCM        — source platform + PR/CI/reviews (github, gitlab)
 *   6. Notifier   — push notifications (desktop, slack, webhook, ...)
 *   7. Terminal   — human interaction UI (iterm2, web, none)
 *   8. Lifecycle Manager (core, NOT pluggable — the state machine + polling)
 *
 * Each pluggable slot is an interface (`Runtime`, `Agent`, `Workspace`,
 * `Tracker`, `SCM`, `Notifier`, `Terminal`) that a plugin implements. The
 * non-pluggable core services (`SessionManager`, `LifecycleManager`,
 * `PluginRegistry`) are also defined here.
 *
 * ---------------------------------------------------------------------------
 * MODULE MAP — what each `types/` module owns
 * ---------------------------------------------------------------------------
 * The modules below are exported in dependency-friendly order (foundational
 * session/runtime/agent types first, then the higher-level slots, then
 * config and service interfaces). The original `// ===` section banners are
 * preserved inside each module.
 *
 * NOTE — this barrel re-exports BOTH compile-time types AND runtime values.
 * The runtime values include: status/state constant objects
 * (`ACTIVITY_STATE`, `SESSION_STATUS`, `PR_STATE`, `CI_STATUS`,
 * `PROCESS_PROBE_INDETERMINATE`), threshold consts
 * (`DEFAULT_READY_THRESHOLD_MS`, `DEFAULT_ACTIVE_WINDOW_MS`), terminal-set
 * consts (`TERMINAL_STATUSES`, `TERMINAL_ACTIVITIES`,
 * `NON_RESTORABLE_STATUSES`), the type-guard / helper functions
 * (`isTerminalSession`, `isRestorable`, `isOrchestratorSession`,
 * `isProcessProbeIndeterminate`, `normalizeAgentPermissionMode`,
 * `isOpenCodeSessionManager`, `isIssueNotFoundError`), and the error classes
 * (`SessionNotRestorableError`, `WorkspaceMissingError`,
 * `SessionNotFoundError`, `ConfigNotFoundError`, `ProjectResolveError`).
 *
 * ---------------------------------------------------------------------------
 * HOW TO EDIT
 * ---------------------------------------------------------------------------
 *   • Add a new type/const to the `types/` module that owns its domain — do
 *     NOT add declarations to this barrel. If you create a brand-new module,
 *     add one `export * from "./types/<name>.js"` line here.
 *   • Cross-references between `types/` modules MUST use `import type { ... }`
 *     (enforced by `@typescript-eslint/consistent-type-imports`). No module
 *     should value-import (`import { ... }`) a runtime value from a sibling
 *     `types/` module — that would risk a runtime circular dependency. Today
 *     every runtime value is self-contained within its own module.
 *   • Never rename or remove an exported name without auditing every
 *     consumer — these names are the published API of `@aoagents/ao-core`.
 */

export * from "./types/session.js"; // SessionId/Kind, canonical lifecycle records, SessionStatus, activity types + ACTIVITY_STATE/SESSION_STATUS/terminal sets + session guards
export * from "./types/runtime.js"; // Runtime slot (1): Runtime interface, RuntimeHandle, RuntimeMetrics, AttachInfo
export * from "./types/agent.js"; // Agent slot (2): Agent interface, launch/session-info/cost types, process-probe types + PROCESS_PROBE_INDETERMINATE
export * from "./types/workspace.js"; // Workspace slot (3): Workspace interface, create config, WorkspaceInfo
export * from "./types/tracker.js"; // Tracker slot (4): Tracker interface, Issue, filters, create/update inputs
export * from "./types/scm.js"; // SCM slot (5): SCM interface, PR/CI/review/webhook/merge types + PR_STATE/CI_STATUS
export * from "./types/notifier.js"; // Notifier slot (6): Notifier interface, NotifyAction, NotifyContext
export * from "./types/terminal.js"; // Terminal slot (7): Terminal interface
export * from "./types/events.js"; // Orchestrator events: EventType/Priority, OrchestratorEvent
export * from "./types/reactions.js"; // Reaction engine: ReactionConfig, ReactionResult
export * from "./types/config.js"; // Configuration: OrchestratorConfig/ProjectConfig + all sub-config + plugin install/role config + agent permission-mode types & normalizeAgentPermissionMode
export * from "./types/plugin.js"; // Plugin system: PluginSlot, PluginManifest, PluginModule, PreflightContext
export * from "./types/metadata.js"; // SessionMetadata
export * from "./types/services.js"; // Core (non-pluggable) service interfaces: SessionManager, LifecycleManager, PluginRegistry + kill/claim/cleanup option & result types
export * from "./types/errors.js"; // Error classes + error-detection helpers (isIssueNotFoundError, ...)
export * from "./types/portfolio.js"; // Cross-project portfolio aggregation types
