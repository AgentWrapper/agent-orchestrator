# Copilot Instructions

Instructions for GitHub Copilot when generating code, reviewing PRs, and suggesting changes in this repository.

## Project Overview

Agent Orchestrator (AO) is a TypeScript monorepo that manages fleets of parallel AI coding agents. Each agent gets its own git worktree, branch, and PR. The system handles CI feedback routing, review comment handling, and session lifecycle.

**Stack:** TypeScript (strict), pnpm monorepo, Next.js 15 + React 19, Tailwind CSS v4, Vitest, ESLint flat config.

**Architecture:** 8 plugin slots (Runtime, Agent, Workspace, Tracker, SCM, Notifier, Terminal, Lifecycle). All interfaces are defined in `packages/core/src/types.ts`. There is no database; the system uses flat files and memory.

Full conventions: `CLAUDE.md`. Plugin development: `docs/DEVELOPMENT.md`. Design system: `DESIGN.md`.

---

## Code Generation Rules

### Think Before Generating

- If a task is ambiguous, suggest the two most likely interpretations and ask which one applies. Do not choose silently.
- If there is a simpler approach than the one requested, say so. Push back when warranted.
- State assumptions explicitly when generating non-trivial code.

### Simplicity First

- No speculative features. No abstractions for single-use code. No "flexibility" that was not requested.
- Plugin slots are the extension point. If the user asks for configurability, consider whether a new plugin slot is the right answer instead.
- If you are generating 200 lines and it could be 50, rewrite it.
- Do not add error handling for impossible scenarios.

### Match Existing Patterns

- Before generating new code in an existing file, read how similar features are already implemented in that same file. Match the pattern.
- Do not introduce new patterns when established ones already exist. Search the codebase first.
- Match existing naming conventions, import styles, and file organization.
- Use `@aoagents/ao-core` for cross-package imports.
- Use the `workspace:*` protocol in `package.json`.

### TypeScript Strict Mode

- No `any` types unless they are in test files, where `any` and `console.log` are allowed.
- Use `import type { Foo }` for type-only imports.
- Prefix unused variables with `_`.
- Do not use `eval`, `new Function`, or `require()`; use ES module imports.

### Web / UI Specific

- Use Tailwind utility classes only. Do not use inline `style=` attributes.
- Use CSS custom properties via `var(--color-*)` from the `globals.css` `@theme` block. Never hardcode hex colors.
- Do not use external UI component libraries such as Radix, shadcn, or Headless UI.
- Preserve the dark theme at all times.
- Border radius must be `0px` everywhere except status dots and avatar circles. Hard edges are part of the visual identity.
- Mark client components with `"use client"`. Use server components for pages.
- SSE updates run at a 5-second interval via the `useSessionEvents` hook. Do not change this interval.
- Keep component files under 400 lines.

---

## PR Review Instructions

### What to Focus On

These are the areas where Copilot review adds the most value: issues CI cannot catch.

**1. Design over implementation.** A perfectly coded bad design is worse than a messy good one. Question:
- Side-channel communication, such as hidden flags or dynamic attribute setting
- Boolean parameters that switch between fundamentally different behaviors and should be separate code paths
- New internal contracts between components without interface documentation
- Missing migration paths for behavioral changes

**2. Pattern consistency.** If a file uses one pattern and the PR introduces a different one, flag it. Common violations:
- Using class attributes in one place and instance properties in another for the same concept
- Mixing callback styles when the file uses one style consistently
- Introducing a new error-handling pattern when the file uses `throw new Error("msg", { cause: err })`

**3. State machine safety.** Changes to `SessionStatus`, `ActivityState`, or lifecycle transitions require extra scrutiny:
- Verify that no invalid state transitions are introduced
- Check that `isTerminalSession()` and `TERMINAL_STATUSES` are updated if new statuses are added
- Flag any change that could cause a session to be incorrectly marked `killed` or `exited`

**4. Plugin interface stability.** Any change to interfaces in `types.ts` is potentially breaking:
- New required methods on plugin interfaces break all existing plugins
- Changed method signatures break all existing plugins
- New optional methods are acceptable
- Flag any non-optional interface change as "breaking — requires updating all N plugins implementing this slot"

**5. Backward compatibility.** Flag changes to:
- CLI flags or arguments in `packages/cli/`
- Config schema, including `agent-orchestrator.yaml` structure and Zod validation in `packages/core/src/config.ts`
- Exported types from `packages/core/src/index.ts`, which are a stable public API and should not break
- Default config values or behavior

**6. Plugin isolation.** Plugins must never import each other directly. They communicate through:
- The `Session` object
- The `LifecycleManager` event system
- Core utilities exported from `@aoagents/ao-core`

**7. Resource cleanup.** Check that:
- File handles, subprocesses, and tmux sessions are cleaned up on all exit paths: success, error, and early return
- `destroy()` methods exist and use best-effort semantics
- There are no resource leaks in error paths

**8. Shell safety.** Any command construction must use `shellEscape()` from `@aoagents/ao-core` for all dynamic arguments. Flag raw string interpolation in shell commands.

### What to Ignore

These are handled by automated tooling and should not be raised in review:

- Formatting, whitespace, and trailing commas; Prettier handles them
- Import ordering; ESLint handles it
- Type errors; TypeScript strict mode and CI catch them
- Lint rule violations; ESLint and CI catch them
- Conventional commit format; CI validates it
- Test file style, including `any` types and `console.log`; relaxed rules apply there

### High-Risk Files

These files have a wide blast radius and deserve extra scrutiny:

| File | Why it's risky |
|------|----------------|
| `packages/core/src/types.ts` | All 8 plugin interfaces live here. Changes can break every plugin. |
| `packages/core/src/lifecycle-manager.ts` | State machine and polling loop with subtle state dependencies. |
| `packages/core/src/session-manager.ts` | Session CRUD + stale runtime reconciliation. `list()` persists `runtime_lost` to disk when enrichment detects dead runtimes. Invariant violations can cause phantom `killed` or `exited` sessions. |
| `packages/core/src/lifecycle-state.ts` | Canonical lifecycle → legacy status mapping. New terminal reasons (e.g. `runtime_lost`) must be added to `deriveLegacyStatus()`. |
| `packages/cli/src/commands/start.ts` | ao start/stop + Ctrl+C shutdown. Cross-project scoping logic is subtle — `ao stop <project>` must not kill parent process. |
| `packages/core/src/config.ts` | Zod validation schema. Changes affect every `ao` command. |
| `packages/core/src/index.ts` | Stable public API. Do not break it without deprecation. |
| `packages/web/src/app/globals.css` | Design tokens used by 50+ components. Renaming tokens breaks the UI. |
| `packages/cli/src/index.ts` | CLI entry point. Flag and argument changes are user-facing. |
| `agent-orchestrator.yaml.example` | Config reference. It must stay in sync with the Zod schema. |

### Behavioral Rules for Reviews

1. **If it is worth mentioning, it is worth fixing.** Do not leave "nits" or minor suggestions. Only raise actionable findings with specific remediation.
2. **Reference file paths and line numbers.** Name the specific function, class, or pattern the author should use instead. Do not give generic advice like "consider using a different approach."
3. **Do not suggest refactoring adjacent code that already works.** Review the diff, not the whole file.
4. **Every finding must trace to a specific line in the diff.** If you cannot point to the line, do not raise it.
5. **Do not repeat points.** Each observation should appear exactly once in the review.
6. **Assume competence.** The author knows the codebase. Explain only non-obvious context: why something is risky, not what it does.
7. **For backward-compatible deprecations, provide the specific pattern:**
   - TypeScript: `@deprecated` JSDoc, `console.warn`, and preserved old behavior during the deprecation period
   - Config: keep the old key working with a warning and add the new key
   - CLI: keep the old flag working and add a deprecation notice to `--help`

### Review Output Format

Omit sections where you have no findings. Do not write "No concerns" for empty sections.

Summary
[1-2 sentence overall assessment]

Architecture & Design
[Pattern violations, design issues, missing abstractions]

State Machine / Lifecycle
[Any changes to session status, activity state, or transitions]

Plugin Interface Stability
[Breaking interface changes, new required methods]

Backward Compatibility
[Breaking changes to CLI, config, or exported APIs]

Testing
[Missing edge cases, uncovered error paths, test adequacy]

Security
[Shell injection, credential exposure, input validation]

Performance
[Unnecessary allocations, missing cleanup, hot path regressions]

---

## Common Patterns to Use

### Plugin Implementation

```typescript
import type { PluginModule, Runtime } from "@aoagents/ao-core";

export const manifest = {
  name: "tmux",
  slot: "runtime" as const,
  description: "tmux session runtime",
  version: "0.1.0",
};

export function create(config?: Record<string, unknown>): Runtime {
  // Validate config here and store it via closure.
  return { /* ... */ };
}

export function detect(): boolean {
  /* ... */
}

export default { manifest, create, detect } satisfies PluginModule<Runtime>;
```

### Error Handling

```typescript
// Wrap with cause for debugging.
throw new Error("Failed to create tmux session", { cause: err });

// Return null for "not found", throw for unexpected errors.
const issue = await tracker.getIssue("123"); // null if not found
```

### Activity Detection

```typescript
// Always implement the full cascade:
// 1. Process check (exited if not running)
// 2. Actionable states (waiting_input/blocked from JSONL)
// 3. Native signal (agent-specific API)
// 4. JSONL entry fallback (MUST NOT skip — use getActivityFallbackState())
```

### Shell Commands

```typescript
import { shellEscape } from "@aoagents/ao-core";

const cmd = `git checkout ${shellEscape(branchName)}`;
// NEVER: `git checkout ${branchName}`
```

---

## Common Mistakes to Flag

- **Cross-plugin imports.** Plugin A importing plugin B directly. It must go through core.
- **Hardcoded secrets.** Use `process.env` and throw if the value is missing.
- **Shell injection.** Dynamic values in shell commands without `shellEscape()`.
- **Missing `setupWorkspaceHooks`.** A new agent plugin without metadata hooks means the dashboard will not show PRs.
- **Skipping JSONL fallback.** An agent plugin's `getActivityState` without `getActivityFallbackState()` means the dashboard shows no activity.
- **New `SessionStatus` without updating `isTerminalSession` / `TERMINAL_STATUSES`.** The session can get stuck in limbo.
- **New session reason without updating `deriveLegacyStatus()`.** Terminal reasons like `runtime_lost` must map to a legacy status (e.g. `killed`), or sessions show wrong status.
- **Scoping `useSessionEvents` with project filter in Dashboard.tsx.** The sidebar must see ALL sessions — only the Kanban filters by project (client-side via `projectSessions`).
- **ao stop killing parent process when targeting a specific project.** `ao stop <project>` must only kill that project's sessions, not the parent `ao start` process or dashboard.
- **CSS color hardcoding.** Using `#hex` or `rgb()` instead of `var(--color-*)` tokens.
- **Rounded corners.** Using `rounded-md` or `rounded-lg` on cards or buttons. Hard edges only.
- **External UI libraries.** Importing from Radix, shadcn, or Headless UI. Use native HTML and Tailwind.
- **SSE interval changes.** Modifying the 5-second polling interval in `useSessionEvents`.
- **Inline styles.** Using `style={{ ... }}` for theme values. Use Tailwind with `var(--token)` or a CSS class instead.
- **New `package.json` dependencies without justification.** The monorepo should stay lean.
