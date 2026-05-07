# @aoagents/ao

## 0.6.0

### Patch Changes

- Updated dependencies [0f539a3]
  - @aoagents/ao-cli@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [3a69722]
  - @aoagents/ao-cli@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [2306078]
- Updated dependencies [f09cc72]
- Updated dependencies [f330a1e]
- Updated dependencies [e1bb51f]
- Updated dependencies [f674422]
- Updated dependencies [e7ad928]
- Updated dependencies [4701122]
- Updated dependencies [c8af50f]
- Updated dependencies [bcdda4b]
- Updated dependencies [1cbf657]
  - @aoagents/ao-cli@0.4.0

## 0.2.2

### Patch Changes

- @composio/ao-cli@0.2.2

## 0.2.1

### Patch Changes

- ac625c3: Fix startup onboarding and install reliability:
  - Repair npm global install startup path by improving package resolution and web package discovery hints.
  - Make `ao start` prerequisite installs explicit and interactive for required tools (`tmux`, `git`) with clearer fallback guidance.
  - Keep `ao spawn` preflight check-only for `tmux` (no implicit install).
  - Remove redundant agent runtime re-detection during config generation.

- Updated dependencies [ac625c3]
  - @composio/ao-cli@0.2.1

## 0.2.0

### Minor Changes

- 3a650b0: Zero-friction onboarding: `ao start` auto-detects project, generates config, and launches dashboard — no prompts, no manual setup. Renamed npm package to `@composio/ao`. Made `@composio/ao-web` publishable with production entry point. Cross-platform agent detection. Auto-port-finding. Permission auto-retry in shell scripts.

### Patch Changes

- Updated dependencies [3a650b0]
  - @composio/ao-cli@0.2.0
