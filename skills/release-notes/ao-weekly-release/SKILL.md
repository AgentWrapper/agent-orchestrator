---
name: ao-weekly-release
description: "Generate the weekly Agent Orchestrator release notes. Runs every Thursday 10:00 IST from the bot cron, or on-demand. Queries the GitHub API for the latest release, merged PRs, commits, contributors, and star counts, and produces a publishable markdown post in the house style. Output is posted to Discord by the cron job after this skill returns."
metadata:
  schedule: "30 4 * * 4"
  timezone: "Asia/Kolkata"
  repo: "ComposioHQ/agent-orchestrator"
  discord_channel: "1486439595498405950"
---

# AO Weekly Release Notes

Automated weekly release notes for `ComposioHQ/agent-orchestrator`. The cron job pulls `main`, runs `run.py`, and posts the output to Discord. No manual redeployment — PRs merged into `main` take effect on the next run.

## When this runs

- **Scheduled:** Every Thursday 10:00 IST (`30 4 * * 4` UTC). Invoked with `--mode scheduled`.
- **On-demand:** Anyone with bot access can trigger a run with `--mode on-demand` (e.g. for a mid-week recap or to preview a release post before cutting it).

The two modes produce the same output; the flag is recorded in the footer so readers know whether the post was automatic or manually requested.

## How to run

```bash
python3 skills/release-notes/ao-weekly-release/run.py --mode scheduled
python3 skills/release-notes/ao-weekly-release/run.py --mode on-demand
python3 skills/release-notes/ao-weekly-release/run.py --mode on-demand --since 2026-04-07
```

Requirements: `gh` CLI authenticated against `ComposioHQ/agent-orchestrator`, `python3` ≥ 3.9. No other dependencies — the runner only uses the stdlib and shells out to `gh`.

Flags:

| Flag | Default | Purpose |
|---|---|---|
| `--mode` | `scheduled` | `scheduled` or `on-demand`. Recorded in the footer. |
| `--since` | 7 days ago | ISO date. Overrides the default weekly window. |
| `--repo` | `ComposioHQ/agent-orchestrator` | Target repo. |
| `--output` | stdout | Write the markdown to a file instead of stdout. |

Exit codes: `0` success, `1` input/validation error, `2` `gh` query failure, `3` no activity in the window (the cron should post a short "quiet week" message instead of the full template).

## Output format

The output is a single markdown document. Section order is fixed — do not reorder. The reference post the style is calibrated against is [surajmarkup.in/research/ao-april-release](https://surajmarkup.in/research/ao-april-release/).

1. **Title + date.** `# Agent Orchestrator — Week of {Mon DD, YYYY}`. Use the Monday of the report week, not the run day.
2. **Positioning line.** One sentence, no more than 25 words, describing what this week delivered. Factual, not marketing. No "excited to announce", no "we're thrilled", no rocket emojis.
3. **Highlights.** 8–14 bullets. Each bullet is one short sentence, past tense, references the PR number inline. Group by theme (features → fixes → refactors → docs) but do not add sub-headers. If fewer than 8 merged PRs exist, list every merged PR and add a one-line note that the week was quiet.
4. **By the Numbers.** Four bullets: commits, merged PRs, contributors, star delta. Format as `Commits: 42` etc.
5. **Install.** Fenced block with the current install command for the latest version.
6. **Links.** Release page, full changelog, repo, Discord.
7. **Full release command checklist.** The exact commands a maintainer would run to cut a release — `pnpm changeset version`, `pnpm -r build`, `pnpm -r publish`, `gh release create`. Keep these copy-pasteable.
8. **Operator checklist.** Checkbox-style (`- [ ]`) items the operator should verify before publishing externally: changelog reviewed, PR titles cleaned, screenshots attached, Discord announcement drafted, tweet drafted. At least 6 items.
9. **Footer.** `_Generated {ISO timestamp} • mode: {scheduled|on-demand} • window: {YYYY-MM-DD}..{YYYY-MM-DD}_`

## Style constraints

- **Tone:** professional, factual, understated. Match the April release post. No hype language, no exclamation marks, no emoji in bullets (emoji is fine in the Discord message wrapper, not the markdown body).
- **Voice:** third person or imperative. Never "we shipped", prefer "Shipped …" or "The runtime now …".
- **Tense:** past tense for highlights ("Added", "Fixed", "Refactored"), imperative for the release commands.
- **PR references:** inline `(#1234)` at the end of each highlight bullet. Never link the PR title.
- **Numbers:** bare integers. No "we merged a whopping 42 PRs".
- **Length:** the full post should fit in a single Discord message after wrapping (under ~2000 characters of plaintext body, excluding the fenced code blocks). If over, the runner truncates the Highlights section and appends `… and N more — see the full changelog.`

## Error handling

The runner is deterministic and must never fabricate data. Specific failure modes:

| Failure | Behavior |
|---|---|
| `gh` not on PATH or not authenticated | Exit `2` with a clear stderr message. No partial output. |
| No merged PRs in the window | Exit `3`. Cron posts the "quiet week" Discord message instead. |
| GitHub API rate-limited | Retry once after 30s, then exit `2`. |
| A single PR query fails | Skip that PR, note the count in stderr, continue. Do not fail the whole run over one bad entry. |
| Star count unavailable | Render `Stars: (unavailable)`. Do not block the post. |
| Commit count mismatch between `gh` and `git log` | Prefer `git log` — the local checkout is the source of truth. |

The runner never invents PR numbers, contributor names, or summary text. Every data point in the output must be traceable to a `gh` or `git` command in `run.py`.

## Skill update workflow

All changes go through PRs to `skills/release-notes/ao-weekly-release/`. The cron pulls latest `main` before each run (`git fetch origin && git checkout main && git reset --hard origin/main`), so merged changes take effect on the next scheduled execution. No manual redeployment.

When editing this skill:

1. Open a PR against `main` with the change.
2. Run `python3 run.py --mode on-demand` locally against the real repo to sanity-check the output.
3. Diff the output against last week's post — unintended style regressions are easy to miss.
4. After merge, the next Thursday run picks it up automatically. To preview immediately, trigger an on-demand run from the bot.
