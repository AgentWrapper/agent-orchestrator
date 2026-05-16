# PowerShell port of ao-update.sh — Windows-native source-checkout updater for AO.
# Invoked by `ao update` on Windows via runRepoScript() when install method is 'git'.

$ErrorActionPreference = 'Stop'

# Manual arg parsing — matches ao-update.sh's `--skip-smoke` / `--smoke-only` /
# `-h` / `--help` flags rather than PowerShell's `-SkipSmoke` convention, so the
# calling contract is identical on Linux/macOS/Windows.
$SkipSmoke = $false
$SmokeOnly = $false
$Help      = $false
foreach ($a in $args) {
    switch ($a) {
        '--skip-smoke' { $SkipSmoke = $true }
        '--smoke-only' { $SmokeOnly = $true }
        '-h'           { $Help = $true }
        '--help'       { $Help = $true }
        default {
            Write-Error "Unknown option: $a"
            exit 1
        }
    }
}

if ($Help) {
    @'
Usage: ao update [--skip-smoke] [--smoke-only]

Fast-forwards the local Agent Orchestrator install repo to main, installs deps,
clean-rebuilds critical packages, refreshes the ao launcher, and runs smoke tests.

Options:
  --skip-smoke  Skip smoke tests after rebuild
  --smoke-only  Run smoke tests without fetching or rebuilding
'@ | Write-Host
    exit 0
}

if ($SkipSmoke -and $SmokeOnly) {
    Write-Error "Conflicting options: use either --skip-smoke or --smoke-only, not both."
    exit 1
}

$TargetBranch = if ($env:AO_UPDATE_BRANCH) { $env:AO_UPDATE_BRANCH } else { 'main' }
$RepoRoot = if ($env:AO_REPO_ROOT) { $env:AO_REPO_ROOT } else { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }

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

    if ($localSha -eq $remoteSha) {
        Write-Host ""
        Write-Host "Already on latest version."
    } else {
        Run-Cmd git pull --ff-only $UpdateRemote $TargetBranch
        Run-Cmd pnpm install

        Run-Cmd pnpm --filter @aoagents/ao-core clean
        Run-Cmd pnpm --filter @aoagents/ao-cli  clean
        Run-Cmd pnpm --filter @aoagents/ao-web  clean

        Run-Cmd pnpm --filter @aoagents/ao-core build
        Run-Cmd pnpm --filter @aoagents/ao-cli  build
        Run-Cmd pnpm --filter @aoagents/ao-web  build

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
    }
}

if (-not $SkipSmoke) {
    Run-SmokeTests
}

Write-Host ""
Write-Host "Update complete."
exit 0
