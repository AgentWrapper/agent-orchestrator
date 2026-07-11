# agent-instructions

Source fragments for the generated agent instruction files at the repo root
(`AGENTS.md`, `AGENTS.shared.md`, `CLAUDE.md`, `GEMINI.md`). Never edit the
generated files — edit the fragments, then regenerate:

```bash
npm run agents          # rebuild the four repo-root files + length report
npm run agents:check    # CI-style drift check (exit 1 if generated files are stale)
npm run agents:system   # rebuild the global $HOME instruction files — see note
```

Layout (assembled in this order by `scripts/polyscribe.sh`):

- `source/NN-*.md` — shared body fragments, concatenated in numeric order.
  `30-polypowers.md` is `@sx-managed` (refreshed by nickify) — don't hand-edit.
- `agent-overrides/{codex,claude,agy}.md` — the per-agent identity appended to
  that agent's file only.
- `system/` — **not committed in this repo.** It is seeded by the agent-vault
  tooling on provisioned accounts; `npm run agents:system` fails on a bare
  checkout with `missing .../agent-instructions/system` — that's expected, not
  a bug. The other two scripts work on any checkout.

## Local agent tool payloads

The repo does not own root-level tool payload directories such as `.agents/`,
`.opencode/`, `.claude/skills/`, or `.claude/settings.json`. Provisioned
developer/agent accounts may receive those files from sx/nickify or local
tooling, and this repo ignores them so copied skills from another project do not
become unreviewed agent-orchestrator source.

If one of those local payloads contains stale foreign-repo instructions, refresh
the account provisioning or delete the local payload and let sx/nickify recreate
it. Repo guidance belongs in this directory and the generated root instruction
files listed above.
