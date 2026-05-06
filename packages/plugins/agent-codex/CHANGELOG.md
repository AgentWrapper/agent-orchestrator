# @aoagents/ao-plugin-agent-codex

## 0.5.0

### Patch Changes

- Updated dependencies [dd07b6b]
  - @aoagents/ao-core@0.5.0

## 0.4.0

### Patch Changes

- b0d0994: Improve Claude Code and Codex session cost estimates to account for cached-token spend, make Codex restore commands fall back to approval prompts for worker sessions instead of blindly reusing dangerous bypass flags, and register the Codex plugin in the web dashboard so native activity detection works there.
- e1bb51f: Fix restore behavior across AO session recovery flows.
  - restore the latest dead-but-restorable orchestrator on `ao start` instead of silently spawning a new orchestrator when tmux is gone
  - make worker session orchestrator navigation prefer the most recently active live orchestrator for the project
  - make permissionless Codex restores preserve dangerous bypass semantics so resumed workers behave like fresh permissionless launches

- Updated dependencies [2306078]
- Updated dependencies [faaddb1]
- Updated dependencies [f330a1e]
- Updated dependencies [a862327]
- Updated dependencies [331f1ce]
- Updated dependencies [703d584]
- Updated dependencies [f674422]
- Updated dependencies [62353eb]
- Updated dependencies [bd36c7b]
- Updated dependencies [e7ad928]
- Updated dependencies [ca8c4cc]
- Updated dependencies [7b82374]
- Updated dependencies [4701122]
- Updated dependencies [c8af50f]
- Updated dependencies [bcdda4b]
- Updated dependencies [1cbf657]
- Updated dependencies [c447c7c]
- Updated dependencies [a45eb32]
- Updated dependencies [7072143]
- Updated dependencies [ed2dcea]
  - @aoagents/ao-core@0.4.0

## 0.2.0

### Patch Changes

- 3a650b0: Zero-friction onboarding: `ao start` auto-detects project, generates config, and launches dashboard — no prompts, no manual setup. Renamed npm package to `@composio/ao`. Made `@composio/ao-web` publishable with production entry point. Cross-platform agent detection. Auto-port-finding. Permission auto-retry in shell scripts.
- Updated dependencies [3a650b0]
  - @composio/ao-core@0.2.0
