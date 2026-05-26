# PowerShell port of ao-update.sh — Windows-native source-checkout updater for AO.
# Invoked by `ao update` on Windows via runRepoScript() when install method is 'git'.

$ErrorActionPreference = 'Stop'

# Manual arg parsing — matches ao-update.sh's `--skip-smoke` / `--smoke-only` /
# `-h` / `--help` flags rather than PowerShell's `-SkipSmoke` convention, so the
# calling contract is identical on Linux/macOS/Windows.
$SkipSmoke    = $false
$SmokeOnly    = $false
$ForceRebuild = $false
$Help         = $false
foreach ($a in $args) {
    switch ($a) {
        '--skip-smoke'    { $SkipSmoke = $true }
        '--smoke-only'    { $SmokeOnly = $true }
        '--force-rebuild' { $ForceRebuild = $true }
        '-h'              { $Help = $true }
        '--help'          { $Help = $true }
        default {
            Write-Error "Unknown option: $a"
            exit 1
        }
    }
}

if ($Help) {
    @'
Usage: ao update [--skip-smoke] [--smoke-only] [--force-rebuild]

Fast-forwards the local Agent Orchestrator install repo to main, installs deps,
clean-rebuilds all workspace packages, refreshes the ao launcher, and runs smoke tests.

The rebuild runs whenever the compiled output is out of sync with the source at
the current commit — not only when new commits are pulled. This catches a manual
`git pull`, a branch switch, an interrupted earlier build, or a manual clean.

Options:
  --skip-smoke    Skip smoke tests after rebuild
  --smoke-only    Run smoke tests without fetching or rebuilding
  --force-rebuild Rebuild even when the build is already up to date
'@ | Write-Host
    exit 0
}

if ($SkipSmoke -and $SmokeOnly) {
    Write-Error "Conflicting options: use either --skip-smoke or --smoke-only, not both."
    exit 1
}

$TargetBranch = if ($env:AO_UPDATE_BRANCH) { $env:AO_UPDATE_BRANCH } else { 'main' }

function Test-AoRepoRoot([string]$path) {
    return (Test-Path (Join-Path $path 'packages/ao/bin/ao.js')) -and
           (Test-Path (Join-Path $path 'packages/cli'))
}

function Find-RepoRootFrom([string]$start) {
    $dir = (Resolve-Path $start).Path
    while ($dir) {
        if (Test-AoRepoRoot $dir) { return $dir }
        $parent = Split-Path -Parent $dir
        if (-not $parent -or $parent -eq $dir) { break }
        $dir = $parent
    }
    return $null
}

function Resolve-RepoRoot {
    if ($env:AO_REPO_ROOT) { return $env:AO_REPO_ROOT }
    $fromScript = Find-RepoRootFrom $PSScriptRoot
    if ($fromScript) { return $fromScript }
    $fromCwd = Find-RepoRootFrom (Get-Location).Path
    if ($fromCwd) { return $fromCwd }
    Write-Error "Unable to find Agent Orchestrator repo root. Fix: run via ao update or set AO_REPO_ROOT."
    exit 1
}

$RepoRoot = Resolve-RepoRoot

# Records the commit the compiled output was last built from. Lives under
# node_modules (gitignored) so it never dirties the working tree, and is rewritten
# only after a fully successful build + launcher refresh. Comparing it to HEAD is
# how we tell "dist is in sync with src at this commit" without fragile mtime checks.
$BuildShaFile = Join-Path $RepoRoot 'node_modules/.ao-build-sha'
$BuildOutputSentinels = @(
    'packages/core/dist/index.js',
    'packages/cli/dist/index.js',
    'packages/web/.next/BUILD_ID',
    'packages/plugins/agent-aider/dist/index.js',
    'packages/plugins/agent-claude-code/dist/index.js',
    'packages/plugins/agent-codex/dist/index.js',
    'packages/plugins/agent-cursor/dist/index.js',
    'packages/plugins/agent-grok/dist/index.js',
    'packages/plugins/agent-kimicode/dist/index.js',
    'packages/plugins/agent-opencode/dist/index.js',
    'packages/plugins/notifier-composio/dist/index.js',
    'packages/plugins/notifier-dashboard/dist/index.js',
    'packages/plugins/notifier-desktop/dist/index.js',
    'packages/plugins/notifier-discord/dist/index.js',
    'packages/plugins/notifier-openclaw/dist/index.js',
    'packages/plugins/notifier-slack/dist/index.js',
    'packages/plugins/notifier-webhook/dist/index.js',
    'packages/plugins/runtime-process/dist/index.js',
    'packages/plugins/runtime-tmux/dist/index.js',
    'packages/plugins/scm-github/dist/index.js',
    'packages/plugins/scm-gitlab/dist/index.js',
    'packages/plugins/terminal-iterm2/dist/index.js',
    'packages/plugins/terminal-web/dist/index.js',
    'packages/plugins/tracker-github/dist/index.js',
    'packages/plugins/tracker-gitlab/dist/index.js',
    'packages/plugins/tracker-linear/dist/index.js',
    'packages/plugins/workspace-clone/dist/index.js',
    'packages/plugins/workspace-worktree/dist/index.js'
) | ForEach-Object { Join-Path $RepoRoot $_ }

function Read-BuiltSha {
    if (Test-Path $BuildShaFile) {
        return (Get-Content $BuildShaFile -Raw -ErrorAction SilentlyContinue).Trim()
    }
    return ''
}

function Write-BuiltSha([string]$sha) {
    try {
        $dir = Split-Path -Parent $BuildShaFile
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Set-Content -Path $BuildShaFile -Value $sha -NoNewline
    } catch {
        Write-Host "Warning: could not write build-sha marker: $_"
    }
}

function Get-MissingBuildOutput {
    foreach ($sentinel in $BuildOutputSentinels) {
        if (-not (Test-Path $sentinel)) { return $sentinel }
    }
    return ''
}

function Require-Command([string]$name, [string]$fixHint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        Write-Error "Missing required command: $name. Fix: $fixHint"
        exit 1
    }
}

function Run-Cmd {
    Write-Host "-> $($args -join ' ')"
    & $args[0] @($args | Select-Object -Skip 1)
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed: $($args -join ' ') (exit $LASTEXITCODE)"
    }
}

function Has-Remote([string]$name) {
    & git remote get-url $name *> $null
    return ($LASTEXITCODE -eq 0)
}

function Get-RemoteUrl([string]$name) {
    $url = & git remote get-url $name 2>$null
    if ($LASTEXITCODE -ne 0) { return '' }
    return $url
}

function Get-GithubRepoSlug([string]$remoteName) {
    $url = Get-RemoteUrl $remoteName
    if (-not $url) { return $null }
    $patterns = @(
        '^https://github\.com/(.+?)(?:\.git)?$',
        '^http://github\.com/(.+?)(?:\.git)?$',
        '^ssh://git@github\.com/(.+?)(?:\.git)?$',
        '^git@github\.com:(.+?)(?:\.git)?$'
    )
    foreach ($p in $patterns) {
        $m = [regex]::Match($url, $p)
        if ($m.Success) { return $m.Groups[1].Value }
    }
    return $null
}

function Resolve-UpdateRemote {
    if (Has-Remote 'upstream') { return 'upstream' }
    return 'origin'
}

function Sync-OriginWithUpstream {
    if (-not (Has-Remote 'origin') -or -not (Has-Remote 'upstream')) { return }
    if (-not (Get-Command 'gh' -ErrorAction SilentlyContinue)) {
        Write-Host "Skipping fork sync: gh is not installed. Local update will use upstream/$TargetBranch directly."
        return
    }
    $originRepo   = Get-GithubRepoSlug 'origin'
    $upstreamRepo = Get-GithubRepoSlug 'upstream'
    if (-not $originRepo -or -not $upstreamRepo) { return }
    Write-Host ""
    Write-Host "Syncing $originRepo/$TargetBranch with $upstreamRepo/$TargetBranch via gh..."
    try {
        Run-Cmd gh repo sync $originRepo --source $upstreamRepo --branch $TargetBranch
    } catch {
        Write-Warning "Failed to sync $originRepo/$TargetBranch from $upstreamRepo/$TargetBranch via gh. Continuing with upstream/$TargetBranch for the local update."
    }
}

function Run-SmokeTests {
    Write-Host ""
    Write-Host "Running smoke tests..."
    $aoBin = Join-Path $RepoRoot 'packages/ao/bin/ao.js'
    Run-Cmd node $aoBin --version
    Run-Cmd node $aoBin doctor --help
    Run-Cmd node $aoBin update --help
}

function Ensure-RepoClean([string]$reason) {
    $status = & git status --porcelain
    if ($status) {
        Write-Error $reason
        exit 1
    }
}

function Ensure-OnTargetBranch {
    $current = (& git branch --show-current).Trim()
    if ($current -ne $TargetBranch) {
        Write-Error "Current branch is $current, expected $TargetBranch. Fix: git switch $TargetBranch then rerun ao update."
        exit 1
    }
}

Write-Host "Agent Orchestrator Update`n"

Require-Command 'node' 'install Node.js 20+'

Set-Location $RepoRoot

$UpdateRemote = Resolve-UpdateRemote

if (-not $SmokeOnly) {
    Require-Command 'git'  'install git 2.25+'
    Require-Command 'pnpm' 'enable corepack or run npm install -g pnpm'
    Require-Command 'npm'  'install npm with Node.js'

    & git rev-parse --is-inside-work-tree *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "The update command must run inside the Agent Orchestrator git checkout."
        exit 1
    }

    Ensure-RepoClean 'Working tree is dirty. Fix: commit or stash local changes before running ao update.'
    Ensure-OnTargetBranch

    Sync-OriginWithUpstream

    Run-Cmd git fetch $UpdateRemote $TargetBranch

    $localSha  = (& git rev-parse HEAD).Trim()
    $remoteSha = (& git rev-parse "$UpdateRemote/$TargetBranch").Trim()

    if ($localSha -ne $remoteSha) {
        Run-Cmd git pull --ff-only $UpdateRemote $TargetBranch
        # HEAD moved; rebuild decision below must compare against the new commit.
        $localSha = (& git rev-parse HEAD).Trim()
    }

    # Decide whether to rebuild. Gating purely on "did the SHA advance" misses the
    # common case where dist is stale at the current commit — a manual git pull, a
    # branch switch, an interrupted earlier build, or a manual clean. Rebuild when
    # the user forces it, the output is missing, or it wasn't built from HEAD.
    $builtSha = Read-BuiltSha
    $missingBuildOutput = Get-MissingBuildOutput
    $rebuildReason = ''
    if ($ForceRebuild) {
        $rebuildReason = 'forced via --force-rebuild'
    } elseif ($missingBuildOutput) {
        $rebuildReason = "build output missing ($missingBuildOutput)"
    } elseif ($builtSha -ne $localSha) {
        $lastBuilt = if ($builtSha) { $builtSha } else { 'unknown' }
        $rebuildReason = "build is stale (last built $lastBuilt, HEAD is $localSha)"
    }

    if (-not $rebuildReason) {
        Write-Host ""
        Write-Host "Already on latest version; build is up to date."
    } else {
        Write-Host ""
        Write-Host "Rebuilding: $rebuildReason"
        Run-Cmd pnpm install

        Run-Cmd pnpm -r --if-present clean
        Run-Cmd pnpm build

        Write-Host ""
        Write-Host "Refreshing ao launcher..."
        Push-Location (Join-Path $RepoRoot 'packages/ao')
        try {
            & npm link --force
            if ($LASTEXITCODE -ne 0) {
                Write-Error "npm link --force failed. On Windows, retry from an elevated terminal: cd $RepoRoot\packages\ao; npm link --force"
                exit 1
            }
        } finally { Pop-Location }

        Ensure-RepoClean 'Update modified tracked files. Inspect git status, review the changes, and rerun after restoring a clean checkout if needed.'

        # Only reached on a fully successful build + launcher refresh + clean tree.
        # Recording HEAD here lets the next run skip the rebuild when nothing changed.
        Write-BuiltSha $localSha
    }
}

if (-not $SkipSmoke) {
    Run-SmokeTests
}

Write-Host ""
Write-Host "Update complete."
exit 0
