# agent-orchestrator (ao)

Our checkout of upstream ao 0.10x — the daemon + CLI that runs the Polymath
agent fleet. **Repo:** `polymath-ventures/agent-orchestrator`.

**Ownership split (2026-07-06):**
- **Backend/daemon: vanilla rule (hard).** Never patched ad hoc — upstream-
  shaped changes only, issue-first, upstream PR opened regardless (pattern:
  per-session --model, codex-fugu adapter).
- **Web experience (frontend browser mode): OURS.** We do not wait for
  upstream to make the browser UI first-class — we build it how we want it in
  this tree and fix bugs as needed. Keep diffs upstream-shaped where cheap
  (they may take them), but upstream acceptance is never a gate. Electron
  remains upstream code — browser-mode behavior is the surface we own.

**Vanilla rule detail:** ao itself (backend) is never patched ad hoc. Upstream-shaped
changes only, each tracked as an issue here first (pattern: #1 per-session
--model, #3 codex-fugu adapter), with an upstream PR opened regardless — we
carry the delta. If a workflow need seems to require changing ao, that is a
finding, not a change: the fix belongs in the vault/nickify layer.

`oldao/` is reference-only history (abandoned 0.9x fork + retired ao-ops
daemons). Never resurrect code from it. Adoption analysis:
`docs/0.10x-adoption-report.md`.

This repo is orchestrated by ao itself — the thing builds the thing. Workers
here follow the same SDLC as every other repo.
