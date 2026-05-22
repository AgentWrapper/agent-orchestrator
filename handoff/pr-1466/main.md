# PR #1466 — Storage Redesign Handoff

**You are picking up an in-flight PR. Read this file first, then the two siblings.**

- [`architecture.md`](./architecture.md) — what the PR actually changes (storage layout, identity, lifecycle, CLI semantics)
- [`review-and-risks.md`](./review-and-risks.md) — review state, hot zones, edge cases, gotchas

---

## TL;DR

PR #1466 ("Storage V2") is the big refactor: replaces `storageKey`-based flat metadata with `projects/{projectId}/` JSON storage, introduces deterministic hashed project IDs (`{basename}_{hash}`), removes the `archive/` directory entirely, eliminates the `SessionStatus` dual-truth, ships a crash-safe `migrate-storage` command with rollback, and reworks `ao stop` / `ao start` / `Ctrl+C` for cross-project awareness with session restore.

| Metric | Value |
|--------|-------|
| Files changed | 90 |
| Insertions | +6,481 |
| Deletions | -2,421 |
| Net LOC | +4,060 |
| PR-owned commits | ~85+ (between `upstream/main..HEAD`) |
| Upstream commits brought in via merge | ~25 |

---

## PR & branch map

| Role | Branch | Where it lives | What it represents |
|------|--------|----------------|--------------------|
| **Base** | `main` | `ComposioHQ/agent-orchestrator` | The merge target. PR diffs against this. |
| **Head (PR)** | `storage-redesign` | `harshitsinghbhandari/agent-orchestrator` (fork) | The actual PR head — what GitHub shows on PR #1466. All authored commits live here. |
| **Simulation** | `simulate-pr-1466-merged` | `harshitsinghbhandari/agent-orchestrator` (fork) | What `main` will look like AFTER PR #1466 lands. Used for end-to-end testing of the merged state and for post-merge fixes. Tracks `storage-redesign` via repeated merges + a small number of additional fixes (e.g. `89a51107 fix(cli): add removeProjectFromRunning and targeted stop tests`). |

All three branches live in **Harshit's fork** (`harshitsinghbhandari/agent-orchestrator`). The upstream repo (`ComposioHQ/agent-orchestrator`) only has `main`.

---

## Checkout recipes

### If you're Harshit (PR author)

Your remotes are already set up:
- `origin` / `harshit` → `harshitsinghbhandari/agent-orchestrator`
- `upstream` → `ComposioHQ/agent-orchestrator`

```bash
git fetch upstream && git fetch origin

git checkout storage-redesign           # PR branch
git pull origin storage-redesign

git checkout simulate-pr-1466-merged    # post-merge simulation
git pull origin simulate-pr-1466-merged
```

### If you're anyone else (reviewer / new contributor)

Clone the upstream repo, then add Harshit's fork as a remote to access the PR branches:

```bash
# Clone upstream
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator

# Add the fork that holds the PR branches
git remote add harshit https://github.com/harshitsinghbhandari/agent-orchestrator.git
git fetch harshit

# Checkout the PR branch
git checkout -b storage-redesign harshit/storage-redesign

# Checkout the simulation branch (optional — for post-merge testing)
git checkout -b simulate-pr-1466-merged harshit/simulate-pr-1466-merged
```

Alternatively, use the GitHub CLI:
```bash
gh repo clone ComposioHQ/agent-orchestrator
cd agent-orchestrator
gh pr checkout 1466    # checks out storage-redesign from the fork automatically
```

### Which branch should I work on?

| Goal | Branch | Why |
|------|--------|-----|
| Fix a review comment / address feedback on PR #1466 | `storage-redesign` | Commits here show up on the PR. Push to the fork. |
| Test "what happens after this lands on main" | `simulate-pr-1466-merged` | Post-merge state with fixes already cherry-picked in. |
| Add a fix that should ride along with the merge but you're unsure about PR scope | `simulate-pr-1466-merged` first, then cherry-pick / merge into `storage-redesign` once validated | The simulate branch is the safe playground. |
| Compare the PR's diff against base | `git diff origin/main...storage-redesign` | Three-dot diff = PR's contribution only. |

**Do not push directly to `ComposioHQ/agent-orchestrator` main.** PR #1466 will land via the GitHub merge button.

---

## Workflow on `storage-redesign` (the PR head)

```bash
git checkout storage-redesign
git pull --rebase   # avoid stacking review-fixup commits

# Make changes
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm --filter @aoagents/ao-web test

# Commit conventionally — fix:/refactor:/docs:/test:/feat:
git commit -m "fix(core): address review on X"
git push    # pushes to harshitsinghbhandari/agent-orchestrator (the fork)
```

**Before pushing, run the full pre-flight:**
```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
```

CI on this branch runs lint, typecheck, tests, and a release dry-run.

---

## Workflow on `simulate-pr-1466-merged`

This branch exists to validate the *merged* state — useful when:
- A fix only manifests after PR #1466 conflicts have been resolved with `main`.
- You're testing CLI behavior end-to-end (e.g. `ao stop` cross-project flows) with a representative repo state.
- A reviewer asks "but what happens after this merges with PR #X?"

```bash
git checkout simulate-pr-1466-merged

# Keep it current with both sides (adjust remote names to your setup):
git fetch origin          # upstream: ComposioHQ/agent-orchestrator
git merge origin/main     # absorb new main commits (resolve conflicts)

# If you have the fork as a remote named 'harshit':
git fetch harshit
git merge harshit/storage-redesign    # absorb new PR commits
```

Fixes that should also ship with the PR get cherry-picked back to `storage-redesign`:
```bash
git checkout storage-redesign
git cherry-pick <commit-from-simulate>
git push
```

---

## Project context (orient quickly)

- **Repo:** `ComposioHQ/agent-orchestrator` — pnpm workspace (~30 packages).
- **Stack:** TypeScript strict, Node 20+, Next.js 15 (App Router), React 19, Tailwind v4, xterm.js, Zod, Vitest.
- **Read this in the repo root:** `CLAUDE.md` — codebase conventions and working principles.
- **Read this for design rules:** `DESIGN.md` — design system, anti-patterns.
- **Read this for what PR #1466 *behaves like*:** `pr-1466.html` — open in a browser. It has two tabs: "Behavior" (per-feature before/after) and "Commit Story" (themed commit groups). Use this as your visual spec.

---

## Critical files this PR touches

| File | Why it matters |
|------|----------------|
| `packages/core/src/types.ts` | Plugin interfaces. Minimize changes. |
| `packages/core/src/session-manager.ts` | Session CRUD. Now lifecycle-centric, no archive lookup. |
| `packages/core/src/lifecycle-manager.ts` | State machine. Status is *derived*, not stored. |
| `packages/core/src/lifecycle-state.ts` | Canonical state + reason model — new in this PR. |
| `packages/core/src/paths.ts` | V2 path helpers (`getProjectSessionsDir`, etc.). Archive helpers removed. |
| `packages/core/src/migrate-storage/` | The migration command + rollback. Most-reviewed code in the PR. |
| `packages/cli/src/commands/start.ts` | Cross-project restore prompt, Ctrl+C graceful shutdown, `ao stop` logic (stop is handled inside start.ts, there is no separate stop.ts). |
| `packages/cli/src/lib/running-state.ts` | `running.json` / `last-stop.json` read/write, `removeProjectFromRunning()`, advisory locking. |
| `packages/web/src/components/Dashboard.tsx` | Sidebar always shows all projects' sessions. |
| `~/.agent-orchestrator/last-stop.json` | New runtime artifact. Read by `ao start` to offer restore. |
| `~/.agent-orchestrator/config.yaml` | Global config. Cross-project commands fall back here. |

---

## Quick context dump for an AI agent

If you're an AI agent picking this up, read in this order and you'll be productive:

1. This file — branch map + workflow.
2. `handoff/pr-1466/architecture.md` — what changed and why.
3. `handoff/pr-1466/review-and-risks.md` — what reviewers cared about + known edge cases.
4. `pr-1466.html` (open in browser) — visual spec, both tabs.
5. `CLAUDE.md` (repo root) — house rules.
6. `git log --oneline upstream/main..storage-redesign` — the actual commit list.

After that, `git diff main...storage-redesign -- packages/core/src/migrate-storage/` is where the depth lives (use whatever remote/branch ref matches your setup — e.g. `origin/main` or `upstream/main`).

---

## Contact

PR author: **Harshit Singh** (`@harshitsinghbhandari`)
PR URL: https://github.com/ComposioHQ/agent-orchestrator/pull/1466
