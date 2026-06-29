---
name: ao-weekly-release
description: Generate weekly AO release notes from git history, merged PRs, and contributor data. Posts to Discord and supports on-demand execution.
version: 1.0.0
trigger:
  - cron: "30 4 * * 4"
  - on-demand: true
output:
  format: markdown
  delivery: discord
  channel: "1486439595498405950"
---

# AO Weekly Release Notes Generator

## Purpose

Automatically generate polished, publishable release notes for Agent Orchestrator on a weekly cadence. Detects the previous release tag, diffs against current main, and produces professional release content matching the established tone.

## Modes

### Scheduled Mode (Cron)
Runs every Thursday at 10:00 IST. Cron pulls latest main, executes this skill, and posts output to Discord channel `1486439595498405950`.

### On-Demand Mode
Run manually at any time via the runner script. Produces identical output format. Useful for pre-release review or ad-hoc generation.

## Data Collection Steps

1. **Detect previous release tag**
   - Query `gh release list --limit 1` to find the latest release tag
   - Extract the tag name and publication date
   - If no previous release exists, generate "Initial Release Summary" from full history

2. **Gather commit history**
   - Use `gh api` to get commits between previous tag and HEAD of main
   - Count total commits
   - Extract unique contributors

3. **Collect merged PRs**
   - Query `gh pr list --state merged` with date filter since last release
   - Extract PR number, title, author, merge date, labels
   - Categorize by type: feat, fix, chore, docs, refactor, test

4. **Compute statistics**
   - Total commits since last release
   - Total merged PRs
   - Unique contributor count
   - Star count delta (current vs last known, via `gh api`)

5. **Categorize highlights**
   Group PRs/commits into narrative themes:
   - New features
   - Bug fixes
   - DX improvements
   - Performance
   - Infrastructure/CI
   - Documentation

## Output Format (Strict)

The output must follow this structure exactly:

1. **Release Title**: `AO vX.Y.Z — Month Year`
2. **Release Date**: `Release Date: <Date IST>`
3. **One-line positioning statement** (border-left styled lead paragraph)
4. **Highlights** (8-14 bullets, professional, high signal)
5. **By the Numbers** (commits, PRs, contributors, stars delta)
6. **Install** block with npm commands
7. **Links** section
8. **Release Commands** (step-by-step checklist)
9. **Operator Checklist** (checkbox style)

## Style Constraints

- Professional, concise, serious tone
- No draft language ("TODO", "FIXME", "TBD")
- No filler phrases
- Every highlight must be factual and specific
- Final publishable quality — no post-editing required

## Error Handling

- No previous release: Generate "Initial Release Summary" using all-time stats
- API/network failures: Retry up to 3 times with exponential backoff
- Missing metrics: Omit gracefully without blocking output
- Empty diff: Generate "No changes since last release" summary

## Cron Integration

The cron job must:
1. cd into the repo
2. git fetch origin && git checkout main && git reset --hard origin/main
3. Execute `python3 skills/release-notes/ao-weekly-release/run.py`
4. Post stdout to Discord channel 1486439595498405950

## Skill Updates

All changes go through PRs to ComposioHQ/agent-orchestrator. Edit files under skills/release-notes/ao-weekly-release/. Next cron run picks up changes automatically.
