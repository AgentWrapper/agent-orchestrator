# BugBot Configuration

## Project Context

Agent Orchestrator is a TypeScript monorepo for managing parallel AI coding agents. It uses pnpm workspaces with packages under `packages/`.

## Tech Stack

- TypeScript (strict mode, ESM with `.js` extensions in imports)
- Node.js 20+ (use `node:` prefix for built-in modules)
- pnpm workspaces
- Next.js 15 (App Router) for web dashboard
- Commander.js for CLI
- vitest for testing

## Review Focus

- **Security**: Watch for command injection (especially in shell/tmux/git commands), AppleScript injection, GraphQL injection, unsanitized user input in API routes
- **Shell execution**: Prefer `execFile` over `exec` to avoid shell injection. Flag any use of `exec` or string concatenation in shell commands
- **Plugin pattern**: Plugins must export `{ manifest, create } satisfies PluginModule<T>` with types from `@aoagents/ao-core`
- **Type safety**: Flag `as unknown as T` casts, unguarded `JSON.parse`, and type re-declarations that should import from core
- **Resource leaks**: Check for uncleared intervals/timeouts, uncleaned event listeners, missing `cancel()` on streams
- **ESM compliance**: Imports must use `.js` extension for local files, `node:` prefix for builtins

## Ignore

- `packages/web/src/lib/mock-data.ts` — temporary mock data, will be replaced
- `scripts/` — legacy bash scripts, not part of the TypeScript codebase
- `artifacts/` — design documents, not code
