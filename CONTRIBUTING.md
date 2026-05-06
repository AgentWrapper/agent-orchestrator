# Contributing to Agent Orchestrator

Thanks for your interest in contributing. This guide covers how to report bugs, submit PRs, and build new plugins.

## Quick Links

- [Setup and first build](#development-setup)
- [Plugin development](#building-a-plugin)
- [Code conventions](#code-conventions)
- [PR process](#pull-request-process)

---

## Reporting Bugs

Open an issue at [github.com/ComposioHQ/agent-orchestrator/issues](https://github.com/ComposioHQ/agent-orchestrator/issues).

Include:

- `ao --version` output
- OS and Node.js version (`node --version`)
- Steps to reproduce
- What you expected vs. what happened
- Relevant output from `ao doctor`

---

## Development Setup

**Prerequisites**: Node.js 20+, pnpm 9.15+, Git 2.25+, tmux, gh CLI

```bash
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator
pnpm install
pnpm build
```

Build order matters — `@aoagents/ao-core` must be built before the CLI, web, or plugins can run. `pnpm build` at the root handles this automatically.

### Running tests

```bash
pnpm test                                         # all packages
pnpm --filter @aoagents/ao-core test              # core only
pnpm --filter @aoagents/ao-core test -- --watch   # watch mode
pnpm test:integration                             # integration tests
```

### Running the dashboard locally

```bash
cp agent-orchestrator.yaml.example agent-orchestrator.yaml
# edit agent-orchestrator.yaml for your setup
pnpm --filter @aoagents/ao-web dev
```

### Refreshing a local AO install

If your local `ao` launcher or built packages seem stale, refresh the install from a clean `main` checkout:

```bash
git switch main
git status --short --branch   # confirm the install repo is clean
ao update
```

`ao update` fast-forwards the local install repo, reinstalls dependencies, clean-rebuilds `@aoagents/ao-core`, `@aoagents/ao-cli`, and `@aoagents/ao-web`, refreshes the global launcher with `npm link`, and finishes with CLI smoke tests. Use `ao update --skip-smoke` when you only need the rebuild step, or `ao update --smoke-only` when validating an existing install.

---

## Building a Plugin

The plugin system is the primary extension point. You can add support for new agents, runtimes, issue trackers, and notification channels without modifying core code.

### 1. Understand the interface

All plugin interfaces are in [`packages/core/src/types.ts`](packages/core/src/types.ts). Pick the slot that matches what you want to build:

| Slot        | Interface   | Example use case                     |
| ----------- | ----------- | ------------------------------------ |
| `runtime`   | `Runtime`   | Run agents in Docker, SSH, cloud VMs |
| `agent`     | `Agent`     | Adapt a new AI coding tool           |
| `workspace` | `Workspace` | Different code isolation strategies  |
| `tracker`   | `Tracker`   | Jira, Asana, or custom issue systems |
| `scm`       | `SCM`       | GitLab, Bitbucket support            |
| `notifier`  | `Notifier`  | Email, Discord, custom webhooks      |
| `terminal`  | `Terminal`  | Different terminal UI integrations   |

### 2. Create the package

```bash
mkdir -p packages/plugins/runtime-myplugin/src
cd packages/plugins/runtime-myplugin
```

`package.json`:

```json
{
  "name": "@aoagents/ao-runtime-myplugin",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest"
  },
  "dependencies": {
    "@aoagents/ao-core": "workspace:*"
  }
}
```

`tsconfig.json` — copy from an existing plugin like `packages/plugins/runtime-tmux/`.

### 3. Implement the interface

```typescript
// src/index.ts
import type { PluginModule, Runtime } from "@aoagents/ao-core";

export const manifest = {
  name: "myplugin",
  slot: "runtime" as const,
  description: "My custom runtime",
  version: "0.1.0",
};

export function create(): Runtime {
  return {
    name: "myplugin",
    async create(config) {
      /* start session */
    },
    async destroy(sessionName) {
      /* tear down */
    },
    async send(sessionName, text) {
      /* send input */
    },
    async isRunning(sessionName) {
      return false;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
```

### 4. Register the plugin

Add it to the CLI's dependencies in `packages/cli/package.json`:

```json
"@aoagents/ao-runtime-myplugin": "workspace:*"
```

Then register it in `packages/core/src/plugin-registry.ts` inside `loadBuiltins()`.

### 5. Add tests

```typescript
// src/index.test.ts
import { describe, it, expect } from "vitest";
import { create } from "./index.js";

describe("myplugin runtime", () => {
  it("reports not running for unknown session", async () => {
    const runtime = create();
    expect(await runtime.isRunning("unknown-session")).toBe(false);
  });
});
```

### 6. Build and test

```bash
pnpm --filter @aoagents/ao-runtime-myplugin build
pnpm --filter @aoagents/ao-runtime-myplugin test
```

### Publishing to the Marketplace Registry

To list your plugin in the AO marketplace so others can install it with `ao plugin install`, submit a PR that adds an entry to `packages/cli/src/assets/plugin-registry.json`.

Each entry requires:

- **`id`** — short kebab-case name (e.g. `tracker-jira`)
- **`package`** — npm package name
- **`slot`** — one of: `runtime`, `agent`, `workspace`, `tracker`, `scm`, `notifier`, `terminal`
- **`description`** — one-line summary
- **`source`** — always `"registry"`
- **`latestVersion`** — semver string

Optionally include `setupAction` if post-install configuration is needed (e.g. `"openclaw-setup"`).

Your plugin package must satisfy the contract in [`docs/PLUGIN_SPEC.md`](docs/PLUGIN_SPEC.md) — export a `PluginModule` with a valid manifest and `create()` function. The package must be published to npm before your registry PR is merged so `ao plugin install` can fetch it.

---

## Code Conventions

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full reference. The short version:

### Behavioral Guidelines

Beyond syntax and style, follow these principles:

- **State assumptions explicitly** - if a task is ambiguous, present interpretations rather than guessing.
- **Minimum viable change** - no speculative features, no unused abstractions, no formatting changes outside your diff.
- **Every changed line traces to the task** - if you can't explain why a line changed, revert it.
- **Write a failing test first** - for bug fixes, reproduce the bug in a test before implementing the fix.
- **Don't refactor unrelated code** - mention dead code you spot, don't delete it.

These match the "Working Principles" section in CLAUDE.md. AI agents working on this repo are instructed to follow these same rules.

**TypeScript**

- ESM modules, `.js` extensions on local imports
- `node:` prefix for builtins
- No `any` — use `unknown` + type guards
- Strict mode, semicolons, double quotes, 2-space indent

**Shell commands**

- Always `execFile`, never `exec`
- Always pass args as an array, never interpolate into strings
- Always add timeouts

**Tests**

- Unit tests alongside source in `src/__tests__/`
- Mock plugins in tests — don't call real tmux, GitHub, or external services
- Test the interface contract, not internal implementation details

---

## Pull Request Process

1. **Fork and branch** from `main`:

   ```bash
   git checkout -b feat/your-feature
   ```

2. **Make your changes** — keep PRs focused on one thing.

3. **Build, test, lint**:

   ```bash
   pnpm build
   pnpm test
   pnpm lint
   pnpm typecheck
   ```

4. **Commit** with [Conventional Commits](https://www.conventionalcommits.org/):

   ```
   feat: add kubernetes runtime plugin
   fix: handle missing LINEAR_API_KEY gracefully
   docs: add plugin development guide
   chore: update vitest to v2
   ```

5. **Push and open a PR**. In the PR description:
   - What changed and why
   - How to test it
   - Link to the issue it closes (e.g., `Closes #123`)

6. **Address review comments** — update the branch and push. Reply to comments when done.

### What gets reviewed

- Does the change work as described?
- Are there tests?
- Does it follow the TypeScript and shell conventions in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)?
- For new features: is it documented?

### CI checks

All PRs must pass:

- `pnpm build` — no TypeScript errors
- `pnpm test` — all tests green
- `pnpm lint` — no lint errors
- Secret scanning — no leaked credentials

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
