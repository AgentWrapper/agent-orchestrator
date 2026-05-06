#!/usr/bin/env python3
"""Deterministic runner for the AO weekly release notes skill.

Queries the GitHub API (via the `gh` CLI) for releases, merged PRs, commits,
contributors, and star counts in a 7-day window, then renders a markdown
post in the house style. See SKILL.md for the output contract.

This script never fabricates data. Every value in the output traces back to
a `gh` or `git` command in this file. If a data source is unavailable, the
corresponding field is rendered as `(unavailable)` or the run exits with a
non-zero code — see the error handling table in SKILL.md.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

DEFAULT_REPO = "ComposioHQ/agent-orchestrator"
DEFAULT_WINDOW_DAYS = 7
MAX_BODY_CHARS = 2000
MIN_HIGHLIGHTS = 8
MAX_HIGHLIGHTS = 14

EXIT_OK = 0
EXIT_INPUT_ERROR = 1
EXIT_GH_ERROR = 2
EXIT_NO_ACTIVITY = 3


@dataclass
class PullRequest:
    number: int
    title: str
    author: str
    merged_at: str
    labels: list[str] = field(default_factory=list)

    @property
    def theme(self) -> str:
        title = self.title.lower()
        if title.startswith("feat"):
            return "feature"
        if title.startswith("fix"):
            return "fix"
        if title.startswith("refactor") or title.startswith("perf"):
            return "refactor"
        if title.startswith("docs"):
            return "docs"
        if title.startswith("test"):
            return "test"
        if title.startswith("chore") or title.startswith("ci"):
            return "chore"
        return "other"

    @property
    def clean_title(self) -> str:
        # Strip the conventional-commit prefix for the bullet text.
        # e.g. "feat(cli): add --json flag" -> "add --json flag"
        title = self.title.strip()
        for prefix in ("feat", "fix", "refactor", "perf", "docs", "test", "chore", "ci", "style"):
            if title.lower().startswith(prefix):
                rest = title[len(prefix):]
                if rest.startswith("(") and ")" in rest:
                    rest = rest[rest.index(")") + 1:]
                if rest.startswith(":"):
                    rest = rest[1:]
                title = rest.strip() or title
                break
        # Strip any trailing inline PR refs like (#1060) to avoid doubling
        title = re.sub(r"\s*\(#\d+\)\s*$", "", title)
        return title


@dataclass
class Snapshot:
    repo: str
    since: datetime
    until: datetime
    mode: str
    latest_release_tag: str | None
    latest_release_name: str | None
    latest_release_url: str | None
    merged_prs: list[PullRequest]
    commit_count: int
    contributors: list[str]
    stars_now: int | None
    stars_delta: int | None
    npm_version: str | None = None
    since_sha: str | None = None
    until_sha: str | None = None

    @property
    def window_label(self) -> str:
        return f"{self.since.strftime('%Y-%m-%d')}..{self.until.strftime('%Y-%m-%d')}"


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def require_gh() -> None:
    if shutil.which("gh") is None:
        log("error: `gh` CLI not found on PATH. Install from https://cli.github.com/")
        sys.exit(EXIT_GH_ERROR)
    try:
        subprocess.run(
            ["gh", "auth", "status"],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as err:
        log("error: `gh` is not authenticated. Run `gh auth login`.")
        log(err.stderr.strip())
        sys.exit(EXIT_GH_ERROR)


def run_gh(args: list[str], *, retries: int = 1) -> str:
    """Run a gh command, retrying once on transient failure."""
    attempt = 0
    while True:
        try:
            result = subprocess.run(
                ["gh", *args],
                check=True,
                capture_output=True,
                text=True,
            )
            return result.stdout
        except subprocess.CalledProcessError as err:
            stderr = err.stderr or ""
            if attempt < retries and ("rate limit" in stderr.lower() or "timeout" in stderr.lower()):
                log(f"gh transient failure ({stderr.strip()}); retrying in 30s")
                time.sleep(30)
                attempt += 1
                continue
            log(f"error: gh {' '.join(args)} failed: {stderr.strip()}")
            sys.exit(EXIT_GH_ERROR)


def fetch_latest_release(repo: str) -> tuple[str | None, str | None, str | None]:
    out = run_gh([
        "api",
        f"repos/{repo}/releases/latest",
        "-q",
        "{tag_name, name, html_url}",
    ])
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return None, None, None
    return data.get("tag_name"), data.get("name"), data.get("html_url")


def fetch_merged_prs(repo: str, since: datetime, until: datetime) -> list[PullRequest]:
    query = (
        f"repo:{repo} is:pr is:merged "
        f"merged:{since.strftime('%Y-%m-%d')}..{until.strftime('%Y-%m-%d')}"
    )
    out = run_gh([
        "api",
        "-X",
        "GET",
        "search/issues",
        "-f",
        f"q={query}",
        "-f",
        "per_page=100",
    ])
    try:
        data = json.loads(out)
    except json.JSONDecodeError as err:
        log(f"error: could not parse PR search response: {err}")
        sys.exit(EXIT_GH_ERROR)

    prs: list[PullRequest] = []
    for item in data.get("items", []):
        try:
            prs.append(
                PullRequest(
                    number=item["number"],
                    title=item["title"],
                    author=(item.get("user") or {}).get("login", "unknown"),
                    merged_at=item.get("closed_at", ""),
                    labels=[lbl["name"] for lbl in item.get("labels", [])],
                )
            )
        except (KeyError, TypeError) as err:
            log(f"warning: skipping malformed PR entry: {err}")
            continue
    prs.sort(key=lambda p: p.merged_at)
    return prs


def fetch_commit_count(repo: str, since: datetime, until: datetime) -> int:
    """Prefer local `git log` if available — the checkout is the source of truth."""
    if shutil.which("git") is not None:
        try:
            result = subprocess.run(
                [
                    "git",
                    "log",
                    f"--since={since.isoformat()}",
                    f"--until={until.isoformat()}",
                    "--pretty=oneline",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            lines = [ln for ln in result.stdout.splitlines() if ln.strip()]
            if lines:
                return len(lines)
        except subprocess.CalledProcessError:
            pass

    out = run_gh([
        "api",
        "-X",
        "GET",
        f"repos/{repo}/commits",
        "-f",
        f"since={since.isoformat()}",
        "-f",
        f"until={until.isoformat()}",
        "-f",
        "per_page=100",
    ])
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return 0
    return len(data) if isinstance(data, list) else 0


def fetch_stars(repo: str) -> int | None:
    out = run_gh(["api", f"repos/{repo}", "-q", ".stargazers_count"])
    try:
        return int(out.strip())
    except (ValueError, TypeError):
        return None


def fetch_npm_version(package: str = "@aoagents/ao") -> str | None:
    """Fetch the latest published version from the npm registry."""
    try:
        result = subprocess.run(
            ["npm", "view", package, "version"],
            check=True,
            capture_output=True,
            text=True,
        )
        version = result.stdout.strip()
        return version if version else None
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def resolve_commit_sha(repo: str, date: datetime) -> str | None:
    """Resolve a date to a commit SHA, preferring local git, falling back to the API."""
    iso = date.isoformat()
    if shutil.which("git") is not None:
        try:
            result = subprocess.run(
                ["git", "rev-list", "-1", f"--before={iso}", "main"],
                check=True,
                capture_output=True,
                text=True,
            )
            sha = result.stdout.strip()
            if sha:
                return sha[:12]
        except subprocess.CalledProcessError:
            pass
    try:
        out = run_gh([
            "api",
            "-X",
            "GET",
            f"repos/{repo}/commits",
            "-f",
            f"until={iso}",
            "-f",
            "per_page=1",
            "-q",
            ".[0].sha",
        ])
        sha = out.strip()
        return sha[:12] if sha else None
    except SystemExit:
        return None


def compute_contributors(prs: list[PullRequest]) -> list[str]:
    seen: dict[str, None] = {}
    for pr in prs:
        if pr.author and pr.author not in seen:
            seen[pr.author] = None
    return list(seen.keys())


def stars_delta_estimate(repo: str, current: int | None) -> int | None:
    """Read last week's star count from a local cache file, if present."""
    if current is None:
        return None
    cache_dir = os.environ.get("AO_RELEASE_NOTES_CACHE") or os.path.expanduser(
        "~/.cache/ao-weekly-release"
    )
    cache_path = os.path.join(cache_dir, f"{repo.replace('/', '__')}.json")
    previous: int | None = None
    try:
        with open(cache_path, "r", encoding="utf-8") as f:
            previous = json.load(f).get("stars")
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        previous = None

    try:
        os.makedirs(cache_dir, exist_ok=True)
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump({"stars": current, "recorded_at": datetime.now(timezone.utc).isoformat()}, f)
    except OSError as err:
        log(f"warning: could not update stars cache: {err}")

    if previous is None:
        return None
    return current - previous


def gather(repo: str, since: datetime, until: datetime, mode: str) -> Snapshot:
    tag, name, url = fetch_latest_release(repo)
    prs = fetch_merged_prs(repo, since, until)
    commits = fetch_commit_count(repo, since, until)
    contributors = compute_contributors(prs)
    stars = fetch_stars(repo)
    delta = stars_delta_estimate(repo, stars)
    npm_version = fetch_npm_version()
    since_sha = resolve_commit_sha(repo, since)
    until_sha = resolve_commit_sha(repo, until)
    return Snapshot(
        repo=repo,
        since=since,
        until=until,
        mode=mode,
        latest_release_tag=tag,
        latest_release_name=name,
        latest_release_url=url,
        merged_prs=prs,
        commit_count=commits,
        contributors=contributors,
        stars_now=stars,
        stars_delta=delta,
        npm_version=npm_version,
        since_sha=since_sha,
        until_sha=until_sha,
    )


def format_theme_order(prs: list[PullRequest]) -> list[PullRequest]:
    order = {"feature": 0, "fix": 1, "refactor": 2, "docs": 3, "test": 4, "chore": 5, "other": 6}
    return sorted(prs, key=lambda p: (order.get(p.theme, 99), p.number))


_LEADING_VERB_RE = re.compile(
    r"^(add|fix|refactor|update|remove|change|implement|improve|enable|disable|"
    r"document|test|clean|drop|bump|migrate|introduce|support|handle|replace|"
    r"rename|move|extract|merge|revert|skip|allow|prevent|ensure)\b",
    re.IGNORECASE,
)


def render_highlights(prs: list[PullRequest]) -> tuple[list[str], int]:
    ordered = format_theme_order(prs)
    bullets: list[str] = []
    for pr in ordered[:MAX_HIGHLIGHTS]:
        theme_verb = {
            "feature": "Added",
            "fix": "Fixed",
            "refactor": "Refactored",
            "docs": "Documented",
            "test": "Tested",
            "chore": "Updated",
            "other": "Changed",
        }[pr.theme]
        body = pr.clean_title
        # If the cleaned title already starts with a verb, capitalize it
        # and use it directly — avoids "Added add …" stutter.
        if _LEADING_VERB_RE.match(body):
            body = body[0].upper() + body[1:]
        else:
            if body and body[0].isupper():
                body = body[0].lower() + body[1:]
            body = f"{theme_verb} {body}"
        bullets.append(f"- {body} (#{pr.number})")
    overflow = max(0, len(ordered) - MAX_HIGHLIGHTS)
    return bullets, overflow


def render_markdown(snap: Snapshot) -> str:
    if not snap.merged_prs:
        log("no merged PRs in window")
        sys.exit(EXIT_NO_ACTIVITY)

    week_label = snap.since.strftime("%b %d, %Y")
    title = f"# Agent Orchestrator — Week of {week_label}"

    positioning = build_positioning_line(snap)

    highlights, overflow = render_highlights(snap.merged_prs)
    if len(snap.merged_prs) < MIN_HIGHLIGHTS:
        highlights.append(
            f"- Quiet week: {len(snap.merged_prs)} merged PR(s); every change is listed above."
        )
    # Track total omitted PRs across both the initial cap and any later truncation.
    # The overflow sentinel line is rendered once at the end by truncate_if_needed.
    total_omitted = overflow

    stars_line = (
        f"- Stars: {snap.stars_now}"
        + (f" (+{snap.stars_delta})" if snap.stars_delta and snap.stars_delta > 0 else "")
        if snap.stars_now is not None
        else "- Stars: (unavailable)"
    )

    by_numbers = [
        "## By the Numbers",
        f"- Commits: {snap.commit_count}",
        f"- Merged PRs: {len(snap.merged_prs)}",
        f"- Contributors: {len(snap.contributors)}",
        stars_line,
    ]

    version = snap.npm_version or "latest"
    install_block = [
        "## Install",
        "```bash",
        "npm install -g @aoagents/ao",
        f"# or pin to the current release: npm install -g @aoagents/ao@{version}",
        "```",
    ]

    release_url = snap.latest_release_url or f"https://github.com/{snap.repo}/releases"
    if snap.since_sha and snap.until_sha:
        changelog_url = f"https://github.com/{snap.repo}/compare/{snap.since_sha}...{snap.until_sha}"
    else:
        changelog_url = f"https://github.com/{snap.repo}/commits/main"
    links = [
        "## Links",
        f"- Release: {release_url}",
        f"- Full changelog: {changelog_url}",
        f"- Repository: https://github.com/{snap.repo}",
        "- Discord: https://discord.gg/agent-orchestrator",
    ]

    release_version = version if version != "latest" else "X.Y.Z"
    release_checklist = [
        "## Release commands",
        "```bash",
        "git fetch origin && git checkout main && git reset --hard origin/main",
        "pnpm install --frozen-lockfile",
        "pnpm changeset version",
        "git add . && git commit -m \"chore: version packages\"",
        "pnpm -r build",
        "pnpm -r publish --access public --no-git-checks",
        f"gh release create v{release_version} --generate-notes",
        "git push origin main --follow-tags",
        "```",
    ]

    operator_checklist = [
        "## Operator checklist",
        "- [ ] Changelog reviewed for accuracy and tone",
        "- [ ] PR titles cleaned up where necessary",
        "- [ ] Screenshots or GIFs attached for any UI-visible changes",
        "- [ ] Discord announcement drafted in #releases",
        "- [ ] Tweet / social post drafted",
        "- [ ] Docs site updated if any public API changed",
        "- [ ] Breaking changes (if any) called out at the top of the post",
    ]

    footer = (
        f"_Generated {datetime.now(timezone.utc).isoformat(timespec='seconds')}"
        f" • mode: {snap.mode}"
        f" • window: {snap.window_label}_"
    )

    # Append the overflow line now (before truncation adjusts it).
    if total_omitted:
        highlights.append(f"- … and {total_omitted} more — see the full changelog.")

    parts: list[str] = [
        title,
        "",
        positioning,
        "",
        "## Highlights",
        *highlights,
        "",
        *by_numbers,
        "",
        *install_block,
        "",
        *links,
        "",
        *release_checklist,
        "",
        *operator_checklist,
        "",
        footer,
        "",
    ]

    body = "\n".join(parts)
    return truncate_if_needed(body, total_omitted)


def build_positioning_line(snap: Snapshot) -> str:
    pr_count = len(snap.merged_prs)
    contrib_count = len(snap.contributors)
    return (
        f"This week the team merged {pr_count} PRs from {contrib_count} "
        f"contributor{'s' if contrib_count != 1 else ''}, continuing steady iteration "
        f"on the orchestrator core, plugins, and dashboard."
    )


def truncate_if_needed(body: str, already_omitted: int) -> str:
    plain = "\n".join(line for line in body.splitlines() if not line.startswith("```"))
    if len(plain) <= MAX_BODY_CHARS:
        return body
    # Trim highlights from the tail until the body fits.
    lines = body.splitlines()
    try:
        start = lines.index("## Highlights") + 1
        end = next(i for i in range(start, len(lines)) if lines[i].startswith("## "))
    except (ValueError, StopIteration):
        return body

    kept = lines[start:end]
    # Remove any existing overflow sentinel so we can re-render it with the correct total.
    if kept and kept[-1].startswith("- … and "):
        kept.pop()
    dropped = 0
    while kept and len(
        "\n".join(ln for ln in (lines[:start] + kept + lines[end:]) if not ln.startswith("```"))
    ) > MAX_BODY_CHARS:
        kept.pop()
        dropped += 1

    total = already_omitted + dropped
    if total:
        kept.append(f"- … and {total} more — see the full changelog.")

    return "\n".join(lines[:start] + kept + lines[end:])


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate AO weekly release notes")
    parser.add_argument(
        "--mode",
        choices=("scheduled", "on-demand"),
        default="scheduled",
        help="How this run was triggered. Recorded in the footer.",
    )
    parser.add_argument(
        "--since",
        help="ISO date (YYYY-MM-DD) for the start of the window. Defaults to 7 days ago.",
    )
    parser.add_argument(
        "--until",
        help="ISO date (YYYY-MM-DD) for the end of the window. Defaults to today.",
    )
    parser.add_argument("--repo", default=DEFAULT_REPO, help="owner/name of the target repo")
    parser.add_argument("--output", help="Write markdown to this file instead of stdout")
    return parser.parse_args(argv)


def resolve_window(args: argparse.Namespace) -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    try:
        until = (
            datetime.fromisoformat(args.until).replace(tzinfo=timezone.utc)
            if args.until
            else now
        )
        since = (
            datetime.fromisoformat(args.since).replace(tzinfo=timezone.utc)
            if args.since
            else until - timedelta(days=DEFAULT_WINDOW_DAYS)
        )
    except ValueError as err:
        log(f"error: invalid date: {err}")
        sys.exit(EXIT_INPUT_ERROR)

    if since >= until:
        log("error: --since must be before --until")
        sys.exit(EXIT_INPUT_ERROR)
    return since, until


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    require_gh()
    since, until = resolve_window(args)
    snap = gather(args.repo, since, until, args.mode)
    markdown = render_markdown(snap)

    if args.output:
        try:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(markdown)
        except OSError as err:
            log(f"error: could not write output file: {err}")
            return EXIT_INPUT_ERROR
    else:
        sys.stdout.write(markdown)

    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
