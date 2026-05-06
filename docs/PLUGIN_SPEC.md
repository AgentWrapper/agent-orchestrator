# AO Plugin Spec

This document defines the runtime contract and packaging requirements for Agent Orchestrator plugins.

## Runtime Contract

Plugins are standard Node.js modules that export a `PluginModule`:

```ts
export interface PluginModule<T = unknown> {
  manifest: PluginManifest;
  create(config?: Record<string, unknown>): T;
  detect?(): boolean;
}
```

Minimum manifest shape:

```ts
export interface PluginManifest {
  name: string;
  slot: PluginSlot;
  description: string;
  version: string;
}
```

AO accepts either a direct named export or a default export that satisfies this shape.

## Supported Slots

Current core slot types:

- `runtime`
- `agent`
- `workspace`
- `tracker`
- `scm`
- `notifier`
- `terminal`

The manifest `slot` determines where AO registers the plugin and which config surface can reference it.

## Packaging Requirements

Published plugins should:

- ship built JavaScript, not raw TypeScript-only entrypoints
- export an ESM entrypoint through `exports` or `main`
- declare a semver dependency on `@aoagents/ao-core`
- keep side effects out of module top-level code where possible

Recommended package shape:

```json
{
  "name": "@aoagents/ao-plugin-example",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"]
}
```

## Config Descriptors

Project config enables plugins through `plugins:` entries:

```yaml
plugins:
  - name: openclaw
    source: registry
    package: "@aoagents/ao-plugin-notifier-openclaw"
    version: "0.1.1"
```

Descriptor fields:

- `name`: logical plugin name shown in CLI UX
- `source`: one of `registry`, `npm`, or `local`
- `package`: package name for registry/npm-backed plugins
- `version`: requested or installed version for store-backed plugins
- `path`: local filesystem path for `source: local`
- `enabled`: optional flag, defaults to `true`

## Marketplace Registry

AO’s bundled marketplace catalog lives at:

- `packages/cli/src/assets/plugin-registry.json`

Registry entries provide AO-specific metadata on top of the runtime contract:

- `id`
- `package`
- `slot`
- `description`
- `source`
- `latestVersion`
- `setupAction` when post-install guidance is needed

## Installation Model

Registry and npm plugins install into the AO-managed store:

- `~/.agent-orchestrator/plugins/`

That store is shared across projects. `agent-orchestrator.yaml` remains the source of truth for whether a plugin is enabled in a given repo.
