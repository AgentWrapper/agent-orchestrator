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

## Pre-flight: Sync Local Repo

**Before every run (cron or on-demand), sync the local repo to latest main.** Without this, you'll generate notes from stale data and miss recent merges.

```bash
cd /home/aoagent/agent-orchestrator
git fetch origin main
git checkout main
git reset --hard origin/main
```

If `git reset` fails due to root-owned files (common on the AO server), use a fresh shallow clone instead:

```bash
cd /tmp && rm -rf ao-release-notes-clone
git clone --depth 200 https://github.com/ComposioHQ/agent-orchestrator.git ao-release-notes-clone
cd ao-release-notes-clone
# Run all gh commands from here
```

**Note:** `git clone --depth=0` is invalid. Use `--depth 200` (enough history for release notes).

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

## Release Codenames

Every release gets a codename reflecting its dominant theme. This is not optional.

**Process:**
1. After categorizing PRs, identify the largest narrative (not just biggest category by count — look at what defines the release).
2. Propose 3-4 codename options. Short, punchy, two words max.
3. Let the user pick. Default to the one that best captures the dominant story.

**Styling:** Codename uses the exact same `<h1>` styling as the version number — same font size, same color (#f4f4f4), same weight. No lighter color, no smaller size, no subtitle treatment.

```html
<h1>AO v0.3.0 "The Rebuild"</h1>
```

**Past codenames:**
- v0.3.0 = "The Rebuild" (dashboard rebuilt, session lifecycle rebuilt, scope renamed)

## Deduplicate Against Prior Releases

Before finalizing highlights, check what the previous release already announced. Don't repeat features that shipped in an earlier release as new highlights.

```bash
gh release view --json tagName,body --jq '.body' | head -50
```

If a feature was already highlighted in the last release (e.g. "External plugin system" in v0.2.5), either omit it or frame it as an evolution ("Plugin system now supports...") rather than a new announcement.

## Highlight Ordering is Editorial

The category order in the output is a **draft** for editorial review, not a final ordering. The user routinely reorders, removes, and adds highlights based on narrative priority — not PR count.

**Rules:**
- Biggest category (by PR count) starts as the first highlight by default.
- But the user may override this (e.g. moving "website launch" to #3 despite having fewer PRs).
- The user may remove highlights entirely ("doesn't make any sense") — respect editorial judgment.
- Always present highlights as a draft and ask for review before finalizing.

## Non-PR Milestones

Some release highlights don't have a PR (e.g. website launch, documentation site, partnership announcements). These are the user's responsibility to provide — the skill only collects repo data. If the user mentions a milestone during the release window, include it with the same formatting as PR-based highlights.

## Mascot / Logo

The HTML template supports embedding the AO mascot image. Use base64 encoding for a self-contained HTML file:

```bash
base64 -w0 /path/to/mascot.webp
```

Embed in the HTML as:
```html
<div style="text-align:center;margin:32px 0">
  <img src="data:image/webp;base64,{B64_STRING}" alt="AO Mascot" style="width:72px;height:72px;border-radius:12px;opacity:0.85">
</div>
```

Current mascot: pixel-art Space Invader style character in sky blue, holding a glowing pointer wand. Verify the local path exists before embedding — the file location varies per environment. If missing, ask the user for the current mascot image.

## Output format

The output is a single markdown document. Section order is fixed — do not reorder. The reference post the style is calibrated against is [surajmarkup.in/research/ao-april-release](https://surajmarkup.in/research/ao-april-release/).

1. **Title + date.** `# Agent Orchestrator — Week of {Mon DD, YYYY}`. Use the Monday of the report week, not the run day.
2. **Positioning line.** One sentence, no more than 25 words, describing what this week delivered. Factual, not marketing. No "excited to announce", no "we're thrilled", no rocket emojis.
3. **Highlights.** 8–14 bullets. Each bullet is one short sentence, past tense, references the PR number inline. Group by theme (features → fixes → refactors → docs) but do not add sub-headers. If fewer than 8 merged PRs exist, list every merged PR and add a one-line note that the week was quiet.
4. **By the Numbers.** Four bullets: commits, merged PRs, contributors, star delta. Format as `Commits: 42` etc.
5. **Install.** Fenced block with the current install command for the latest version.
6. **Links.** Include ALL of these — website, docs, GitHub, Discord, ClawHub:
   ```
   Website: https://ao-agents.com
   Docs: https://ao-agents.com/docs
   GitHub: https://github.com/ComposioHQ/agent-orchestrator
   Discord: https://discord.gg/W6XBvg8yjd
   ClawHub Plugin: https://clawhub.ai/plugins/composio-ao-plugin
   ClawHub Skill: https://clawhub.ai/illegalcall/composio-agent-orchestrator
   ```
7. **Full release command checklist.** The exact commands a maintainer would run to cut a release — `pnpm changeset version`, `pnpm -r build`, `pnpm -r publish`, `gh release create`. Keep these copy-pasteable.
8. **Operator checklist.** Checkbox-style (`- [ ]`) items the operator should verify before publishing externally: changelog reviewed, PR titles cleaned, screenshots attached, Discord announcement drafted, tweet drafted. At least 6 items.
9. **Footer.** `_Generated {ISO timestamp} • mode: {scheduled|on-demand} • window: {YYYY-MM-DD}..{YYYY-MM-DD}_`

## Style constraints

- **Tone:** professional, factual, understated. Match the April release post. No hype language, no exclamation marks, no emoji in bullets (emoji is fine in the Discord message wrapper, not the markdown body).
- **Voice:** third person or imperative. Never "we shipped", prefer "Shipped …" or "The runtime now …".
- **Tense:** past tense for highlights ("Added", "Fixed", "Refactored"), imperative for the release commands.
- **PR references:** inline `(#1234)` at the end of each highlight bullet. Never link the PR title.
- **Numbers:** bare integers. No "we merged a whopping 42 PRs".
- **No PR counts in highlight lines** — the user explicitly rejected these. Count metadata goes in "By the Numbers" only.
- **Length:** the full post should fit in a single Discord message after wrapping (under ~2000 characters of plaintext body, excluding the fenced code blocks). If over, the runner truncates the Highlights section and appends `… and N more — see the full changelog.`

## HTML Output

For the HTML version (matching the reference style at surajmarkup.in), use the following structure:

### HTML/CSS Template
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AO vX.Y.Z "Codename" — Month Year</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap');
    *{box-sizing:border-box;margin:0;padding:0}
    body{
      font-family:'JetBrains Mono',monospace;
      background:#0b0b0b;
      color:#d4d4d4;
      line-height:1.9;
      font-size:15px;
      -webkit-font-smoothing:antialiased;
    }
    .wrap{max-width:860px;margin:0 auto;padding:36px 20px 72px}
    .rule{color:#454545;letter-spacing:.12em;margin:0 0 22px;font-size:14px}
    h1{font-size:31px;color:#f4f4f4;margin-bottom:8px;letter-spacing:.01em}
    .meta{color:#8a8a8a;margin-bottom:22px;font-size:14px}
    .lead{color:#b6b6b6;margin-bottom:26px;padding-left:14px;border-left:2px solid #323232}
    h2{margin:28px 0 12px;color:#f0f0f0;font-size:17px;letter-spacing:.09em;text-transform:uppercase}
    p{margin-bottom:14px}
    .item{margin-bottom:12px}
    .item strong{color:#f2f2f2}
    ul{margin:8px 0 8px 20px}
    li{margin:7px 0}
    code{color:#8ab4ff;background:#111;padding:1px 4px;border-radius:4px}
    pre{background:#111;border:1px solid #262626;border-radius:8px;padding:12px 14px;margin:10px 0 14px;overflow:auto}
    .links a{color:#8ab4ff;text-decoration:none}
    .links a:hover{text-decoration:underline}
    .footer-rule{margin-top:28px;color:#454545;letter-spacing:.12em;font-size:14px}
  </style>
</head>
<body>
  <div class="wrap">
    <!-- body content per Content Structure section below -->
  </div>
</body>
</html>
```

### Content Structure (exact order)
1. `───` rule
2. `<h1>AO vX.Y.Z "Codename"</h1>` — codename same style as version, no special formatting
3. `<div class="meta">Release Date: Month DD, YYYY</div>`
4. `<p class="lead">` — one-line positioning statement with left border
5. `<h2>HIGHLIGHTS</h2>` — each highlight as `<p class="item">` with `<strong>` prefix
6. Optional mascot image (centered, 72px, border-radius 12px, 0.85 opacity)
7. `<h2>BY THE NUMBERS</h2>` — `<ul>` with li items
8. `<h2>INSTALL</h2>` — `<pre><code>` block. Use `@aoagents/ao` (not `@composio/ao`).
9. Links paragraph with website, docs, GitHub, Discord, ClawHub
10. `───` footer rule

### Screenshot Rendering
The server cannot run Chromium directly (missing shared libs). Use Camoufox's bundled libs:

```bash
LD_LIBRARY_PATH=/home/aoagent/.cache/camoufox node /tmp/screenshot.js
```

Puppeteer must be installed in `/tmp/node_modules/` (not global). Screenshot template:

```js
const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 4000 });
  await page.goto('file:///tmp/ao-release-v0NN.html', { waitUntil: 'networkidle0', timeout: 30000 });
  const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
  await page.setViewport({ width: 960, height: bodyHeight + 100 });
  await page.screenshot({ path: '/tmp/ao-release-v0NN.png', fullPage: true });
  await browser.close();
})();
```

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

## Cron Integration

- Cron job ID: `a536bf6e5932`
- Schedule: `30 4 * * 4` (Thursday 10:00 IST)
- Delivery: Discord channel `1486439595498405950`
- Cron pulls latest main before execution
- Skill updates go through PRs to repo → auto-picked on next cron run

## Skill update workflow

All changes go through PRs to `skills/release-notes/ao-weekly-release/`. The cron pulls latest `main` before each run (`git fetch origin && git checkout main && git reset --hard origin/main`), so merged changes take effect on the next scheduled execution. No manual redeployment.

When editing this skill:

1. Open a PR against `main` with the change.
2. Run `python3 run.py --mode on-demand` locally against the real repo to sanity-check the output.
3. Diff the output against last week's post — unintended style regressions are easy to miss.
4. After merge, the next Thursday run picks it up automatically. To preview immediately, trigger an on-demand run from the bot.
