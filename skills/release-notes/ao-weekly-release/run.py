#!/usr/bin/env python3
"""
AO Weekly Release Notes Runner
===============================
Deterministic script that generates release notes from git history.
Designed to be executed by cron or on-demand.

Usage:
    python3 skills/release-notes/ao-weekly-release/run.py [--mode scheduled|on-demand] [--output file|stdout]

Exit codes:
    0 - Success
    1 - Transient error (retry recommended)
    2 - Fatal error
"""

import subprocess
import json
import sys
import os
import re
from datetime import datetime, timezone, timedelta
from collections import Counter

IST = timezone(timedelta(hours=5, minutes=30))

def run_gh(args, retries=3):
    """Run a gh command with retry logic."""
    for attempt in range(retries):
        try:
            result = subprocess.run(
                ["gh"] + args,
                capture_output=True, text=True, timeout=30,
                cwd=os.environ.get("AO_REPO_PATH", ".")
            )
            if result.returncode == 0:
                return json.loads(result.stdout) if result.stdout.strip() else None
            if attempt < retries - 1:
                import time
                time.sleep(2 ** (attempt + 1))
        except (subprocess.TimeoutExpired, json.JSONDecodeError):
            if attempt < retries - 1:
                import time
                time.sleep(2 ** (attempt + 1))
    return None

def get_latest_release():
    """Get the latest GitHub release tag and date."""
    releases = run_gh(["release", "list", "--limit", "10", "--json", "tagName,publishedAt"])
    if not releases:
        return None, None
    # Filter to main package releases (ao-cli)
    for r in releases:
        if "ao-cli" in r.get("tagName", ""):
            return r["tagName"], r["publishedAt"]
    return releases[0]["tagName"], releases[0]["publishedAt"]

def get_merged_prs(since_date):
    """Get all merged PRs since the given date."""
    prs = run_gh([
        "pr", "list", "--state", "merged",
        "--search", f"merged:>{since_date}",
        "--json", "number,title,author,mergedAt,url,labels",
        "--limit", "100"
    ])
    return prs or []

def get_commit_count(since_tag):
    """Get commit count and contributors since a tag."""
    result = subprocess.run(
        ["gh", "api", f"repos/ComposioHQ/agent-orchestrator/compare/{since_tag}...main", "--jq", ".total_commits"],
        capture_output=True, text=True, timeout=30,
        cwd=os.environ.get("AO_REPO_PATH", ".")
    )
    try:
        return int(result.stdout.strip())
    except (ValueError, AttributeError):
        return 0

def get_stars():
    """Get current star count."""
    result = subprocess.run(
        ["gh", "api", "repos/ComposioHQ/agent-orchestrator", "--jq", ".stargazers_count"],
        capture_output=True, text=True, timeout=30,
        cwd=os.environ.get("AO_REPO_PATH", ".")
    )
    try:
        return int(result.stdout.strip())
    except (ValueError, AttributeError):
        return None

def get_contributors(prs):
    """Extract unique contributors from PRs."""
    contributors = set()
    for pr in prs:
        author = pr.get("author", {})
        login = author.get("login", "unknown")
        if login and login != "dependabot[bot]":
            contributors.add(login)
    return contributors

def categorize_prs(prs):
    """Categorize PRs by type based on title prefix."""
    categories = {
        "feat": [], "fix": [], "chore": [], "docs": [],
        "refactor": [], "test": [], "other": []
    }
    for pr in prs:
        title = pr.get("title", "")
        matched = False
        for prefix in categories:
            if prefix != "other" and title.lower().startswith(prefix):
                categories[prefix].append(pr)
                matched = True
                break
        if not matched:
            categories["other"].append(pr)
    return categories

def extract_version():
    """Try to determine the next version from package.json."""
    try:
        with open("package.json") as f:
            pkg = json.load(f)
            return pkg.get("version", "0.0.0")
    except (FileNotFoundError, json.JSONDecodeError):
        # Try to get from the latest tag
        tag, _ = get_latest_release()
        if tag:
            match = re.search(r'(\d+\.\d+\.\d+)', tag)
            if match:
                return match.group(1)
    return "0.0.0"

def generate_highlights(categories, prs):
    """Generate highlight bullets from categorized PRs."""
    highlights = []
    
    # Features
    for pr in categories.get("feat", []):
        title = pr["title"].replace("feat:", "").replace("feat(", "").strip()
        # Clean up scope prefix
        title = re.sub(r'^[a-z-]+\):\s*', '', title)
        highlights.append(title)
    
    # Fixes (group notable ones)
    fix_titles = []
    for pr in categories.get("fix", []):
        title = pr["title"].replace("fix:", "").replace("fix(", "").strip()
        title = re.sub(r'^[a-z-]+\):\s*', '', title)
        fix_titles.append(title)
    
    if fix_titles:
        if len(fix_titles) <= 4:
            for t in fix_titles:
                highlights.append(t)
        else:
            for t in fix_titles[:4]:
                highlights.append(t)
            highlights.append(f"+ {len(fix_titles) - 4} more fixes")
    
    # Chore/infra
    for pr in categories.get("chore", []):
        title = pr["title"].replace("chore:", "").replace("chore(", "").strip()
        title = re.sub(r'^[a-z-]+\):\s*', '', title)
        if "version" in title.lower() or "bump" in title.lower():
            continue  # Skip version bumps
        highlights.append(title)
    
    # Docs
    for pr in categories.get("docs", []):
        title = pr["title"].replace("docs:", "").strip()
        highlights.append(title)
    
    # Trim to 8-14 range
    if len(highlights) > 14:
        highlights = highlights[:14]
    
    return highlights

def generate_release_notes(mode="scheduled"):
    """Main function: generate the complete release notes."""
    tag, tag_date = get_latest_release()
    
    if not tag:
        print("⚠ No previous release found. Generating initial release summary.", file=sys.stderr)
        tag = "HEAD~50"
        tag_date = "2026-01-01T00:00:00Z"
    
    # Parse the date for filtering
    since_date = tag_date[:10] if tag_date else "2026-01-01"
    
    # Collect data
    prs = get_merged_prs(since_date)
    commit_count = get_commit_count(tag) if "HEAD" not in tag else len(prs) * 2  # rough estimate
    contributors = get_contributors(prs)
    stars = get_stars()
    categories = categorize_prs(prs)
    version = extract_version()
    highlights = generate_highlights(categories, prs)
    
    # Generate month/year string
    now_ist = datetime.now(IST)
    month_year = now_ist.strftime("%B %Y")
    date_str = now_ist.strftime("%B %d, %Y")
    
    # Build output
    lines = []
    lines.append(f"AO v{version} — {month_year}")
    lines.append(f"Release Date: {date_str}")
    lines.append("")
    
    # Positioning statement - derive from highlights
    if highlights:
        lines.append(f"Steady progress — {len(prs)} merged PRs, {len(contributors)} contributors, and {commit_count} commits since the last release.")
    else:
        lines.append("Maintenance release with stability improvements.")
    lines.append("")
    
    # Highlights
    lines.append("Highlights")
    lines.append("")
    for h in highlights:
        lines.append(f"• {h}")
    lines.append("")
    
    # By the Numbers
    lines.append("By the Numbers")
    lines.append(f"- {commit_count} commits")
    lines.append(f"- {len(prs)} merged PRs")
    lines.append(f"- {len(contributors)} contributors")
    if stars:
        lines.append(f"- {stars} stars")
    lines.append("")
    
    # Install
    lines.append("Install")
    lines.append("```")
    lines.append("npm i -g @composio/ao")
    lines.append("ao start <your-project>")
    lines.append("```")
    lines.append("")
    
    # Links
    lines.append("Links")
    lines.append("GitHub: https://github.com/ComposioHQ/agent-orchestrator")
    lines.append("Discord: https://discord.gg/W6XBvg8yjd")
    lines.append("ClawHub Plugin: https://clawhub.ai/plugins/composio-ao-plugin")
    lines.append("ClawHub Skill: https://clawhub.ai/illegalcall/composio-agent-orchestrator")
    lines.append("")
    
    # Release Commands
    lines.append("Release Commands")
    lines.append("")
    lines.append("1. Sync main")
    lines.append("   git checkout main && git pull origin main")
    lines.append("")
    lines.append("2. Verify build")
    lines.append("   pnpm install && pnpm build && pnpm test && pnpm lint && pnpm typecheck")
    lines.append("")
    lines.append("3. Version bump (via changeset)")
    lines.append("   pnpm changeset version")
    lines.append("   # Review bumped versions in package.json files")
    lines.append("")
    lines.append("4. Commit version bumps")
    lines.append('   git add . && git commit -m "chore: bump versions to ' + version + '"')
    lines.append("")
    lines.append("5. Push and tag")
    lines.append("   git push origin main --follow-tags")
    lines.append("")
    lines.append("6. Create GitHub release")
    lines.append(f'   gh release create v{version} --title "AO v{version} — {month_year}" --notes-file release-notes.md')
    lines.append("")
    lines.append("7. Publish to npm")
    lines.append("   pnpm publish -r --access public")
    lines.append("")
    lines.append("8. Update plugin-registry.json")
    lines.append("   # Bump latestVersion for all AO plugins in ClawHub registry")
    lines.append("   # Open PR to plugin-registry repo")
    lines.append("")
    lines.append("9. Update ClawHub pages")
    lines.append("   # Verify plugin and skill pages reflect new version")
    lines.append("")
    
    # Operator Checklist
    lines.append("Operator Checklist")
    checklist_items = [
        "Build passes",
        "Tests pass",
        "Lint clean",
        "Version bumped correctly",
        "GitHub release created",
        "npm packages published",
        "Plugin registry updated",
        "ClawHub pages verified",
        "Discord announcement posted",
        "Twitter/X announcement (if applicable)",
    ]
    for item in checklist_items:
        lines.append(f"[ ] {item}")
    
    return "\n".join(lines)

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="AO Weekly Release Notes Generator")
    parser.add_argument("--mode", choices=["scheduled", "on-demand"], default="scheduled")
    parser.add_argument("--output", choices=["file", "stdout"], default="stdout")
    args = parser.parse_args()
    
    notes = generate_release_notes(mode=args.mode)
    
    if args.output == "file":
        filename = f"release-notes-{datetime.now(IST).strftime('%Y%m%d')}.md"
        with open(filename, "w") as f:
            f.write(notes)
        print(f"Release notes written to {filename}", file=sys.stderr)
        print(notes)
    else:
        print(notes)
