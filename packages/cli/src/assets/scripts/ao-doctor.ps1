# PowerShell port of ao-doctor.sh — Windows-native health checks for AO.
# Invoked by `ao doctor` on Windows via runRepoScript().

$ErrorActionPreference = 'Continue'

# Manual arg parsing — matches ao-doctor.sh's `--fix` / `-h` / `--help` flags
# rather than PowerShell's `-Fix` convention, so the calling contract is
# identical on Linux/macOS/Windows.
$Fix  = $false
$Help = $false
foreach ($a in $args) {
    switch ($a) {
        '--fix'   { $Fix = $true }
        '-h'      { $Help = $true }
        '--help'  { $Help = $true }
        default {
            Write-Error "Unknown option: $a"
            exit 1
        }
    }
}

if ($Help) {
    @'
Usage: ao doctor [--fix]

Checks install, PATH, binaries, service health, stale temp files, and runtime sanity.

Options:
  --fix    Apply safe fixes for missing launcher links, missing support dirs, and stale temp files
'@ | Write-Host
    exit 0
}

# AO_REPO_ROOT and AO_SCRIPT_LAYOUT are exported by runRepoScript().
$RepoRoot = if ($env:AO_REPO_ROOT) { $env:AO_REPO_ROOT } else { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$ScriptLayout = $env:AO_SCRIPT_LAYOUT
if (-not $ScriptLayout) {
    if ((Test-Path (Join-Path $RepoRoot 'package.json')) -and
        (Test-Path (Join-Path $RepoRoot 'dist/index.js')) -and
        -not (Test-Path (Join-Path $RepoRoot 'packages'))) {
        $ScriptLayout = 'package-install'
    } else {
        $ScriptLayout = 'source-checkout'
    }
}

$DefaultConfigHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $RepoRoot }

$script:PassCount = 0
$script:WarnCount = 0
$script:FailCount = 0
$script:FixCount  = 0

function Write-Pass($msg)  { $script:PassCount++;  Write-Host "PASS $msg" }
function Write-Warn2($msg) { $script:WarnCount++;  Write-Host "WARN $msg" }
function Write-Fail($msg)  { $script:FailCount++;  Write-Host "FAIL $msg" }
function Write-Fixed($msg) { $script:FixCount++;   Write-Host "FIXED $msg" }

function Expand-HomePath([string]$p) {
    if ($p -like '~/*' -or $p -like '~\*') {
        return Join-Path $DefaultConfigHome $p.Substring(2)
    }
    if ($p -eq '~') { return $DefaultConfigHome }
    return $p
}

function Find-AoConfig {
    if ($env:AO_CONFIG_PATH -and (Test-Path $env:AO_CONFIG_PATH)) {
        return $env:AO_CONFIG_PATH
    }
    $current = Get-Location | Select-Object -ExpandProperty Path
    while ($current) {
        foreach ($name in @('agent-orchestrator.yaml', 'agent-orchestrator.yml')) {
            $candidate = Join-Path $current $name
            if (Test-Path $candidate) { return $candidate }
        }
        $parent = Split-Path $current -Parent
        if (-not $parent -or $parent -eq $current) { break }
        $current = $parent
    }
    foreach ($candidate in @(
        (Join-Path $RepoRoot 'agent-orchestrator.yaml'),
        (Join-Path $DefaultConfigHome '.agent-orchestrator.yaml')
    )) {
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

function Read-ConfigValue([string]$key, [string]$file) {
    $line = Get-Content $file -ErrorAction SilentlyContinue |
        Where-Object { $_ -match "^\s*${key}:" } |
        Select-Object -First 1
    if (-not $line) { return '' }
    # Strip key, comments, quotes, surrounding whitespace.
    $val = ($line -replace "^\s*${key}:", '').Trim()
    $val = ($val -split '#', 2)[0].Trim()
    $val = $val.Trim('"').Trim("'").Trim()
    return $val
}

function Ensure-Dir([string]$dir, [string]$label, [string]$fixHint) {
    if (Test-Path $dir -PathType Container) {
        Write-Pass "$label exists at $dir"
        return
    }
    if ($Fix) {
        try {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            Write-Fixed "$label created at $dir"
        } catch {
            Write-Fail "$label could not be created at $dir. Fix: $fixHint"
        }
        return
    }
    Write-Warn2 "$label is missing at $dir. Fix: $fixHint"
}

function Check-Command([string]$name, [string]$required, [string]$fixHint) {
    $resolved = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $resolved) {
        if ($required -eq 'required') {
            Write-Fail "$name is not in PATH. Fix: $fixHint"
        } else {
            Write-Warn2 "$name is not in PATH. Fix: $fixHint"
        }
        return $false
    }
    Write-Pass "$name resolves to $($resolved.Source)"
    return $true
}

function Check-Node {
    if (-not (Check-Command 'node' 'required' 'install Node.js 20+ and reopen your shell')) { return }
    $version = (& node --version 2>$null)
    if (-not $version) { return }
    $major = [int](($version.TrimStart('v')) -split '\.')[0]
    if ($major -lt 20) {
        Write-Fail "Node.js 20+ is required, found $version. Fix: install Node.js 20+"
        return
    }
    Write-Pass "Node.js version $version is supported"
}

function Check-Git {
    if (-not (Check-Command 'git' 'required' 'install git 2.25+ and reopen your shell')) { return }
    $out = (& git --version 2>$null)
    if (-not $out) { return }
    $match = [regex]::Match($out, '(\d+)\.(\d+)')
    if (-not $match.Success) {
        Write-Fail "git 2.25+ is required, could not parse '$out'. Fix: upgrade git"
        return
    }
    $major = [int]$match.Groups[1].Value
    $minor = [int]$match.Groups[2].Value
    if ($major -lt 2 -or ($major -eq 2 -and $minor -lt 25)) {
        Write-Fail "git 2.25+ is required, found $major.$minor. Fix: upgrade git"
        return
    }
    Write-Pass "git version $major.$minor supports worktrees"
}

function Check-Pnpm {
    $required = 'required'
    $hint = 'enable corepack or run npm install -g pnpm'
    if ($ScriptLayout -eq 'package-install') {
        $required = 'optional'
        $hint = 'install pnpm if you plan to use pnpm-managed repos with AO'
    }
    if (-not (Check-Command 'pnpm' $required $hint)) { return }
    $version = (& pnpm --version 2>$null)
    $shown = if ($version) { $version } else { 'unknown' }
    Write-Pass "pnpm version $shown is available"
}

function Check-Launcher {
    $resolved = Get-Command 'ao' -ErrorAction SilentlyContinue
    if ($resolved) {
        Write-Pass "ao launcher resolves to $($resolved.Source)"
        return
    }
    if ($ScriptLayout -eq 'source-checkout' -and $Fix -and (Get-Command npm -ErrorAction SilentlyContinue) -and (Test-Path (Join-Path $RepoRoot 'packages/ao'))) {
        Push-Location (Join-Path $RepoRoot 'packages/ao')
        try {
            $null = & npm link --force 2>&1
            if ($LASTEXITCODE -eq 0 -and (Get-Command 'ao' -ErrorAction SilentlyContinue)) {
                Write-Fixed "ao launcher refreshed with npm link --force"
                return
            }
        } finally { Pop-Location }
        Write-Warn2 "ao launcher refresh failed. Fix: cd $RepoRoot\packages\ao; npm link --force"
        return
    }
    if ($ScriptLayout -eq 'package-install') {
        Write-Warn2 "ao launcher is not in PATH. Fix: reinstall with npm install -g @aoagents/ao@latest"
        return
    }
    Write-Warn2 "ao launcher is not in PATH. Fix: cd $RepoRoot; pwsh scripts/setup.ps1 (or run npm link --force in packages/ao)"
}

function Check-Tmux {
    # tmux is not native on Windows. The default Windows runtime is `process`,
    # so tmux is informational only.
    if (Get-Command 'tmux' -ErrorAction SilentlyContinue) {
        Write-Pass "tmux is installed (note: Windows default runtime is 'process')"
        return
    }
    Write-Pass "tmux not installed (Windows default runtime is 'process' — tmux not required)"
}

function Check-Gh {
    if (-not (Get-Command 'gh' -ErrorAction SilentlyContinue)) {
        Write-Warn2 "GitHub CLI is not installed. Fix: install gh from https://cli.github.com/"
        return
    }
    & gh auth status *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Pass "gh is installed and authenticated"
        return
    }
    Write-Warn2 "gh is installed but not authenticated. Fix: run gh auth login"
}

function Check-InstallLayout {
    if ($ScriptLayout -eq 'package-install') {
        $checks = @(
            @{ Path = 'package.json';                    Label = 'CLI package metadata is present' }
            @{ Path = 'dist/index.js';                   Label = 'packaged CLI entrypoint exists' }
            @{ Path = 'dist/assets/scripts/ao-doctor.ps1'; Label = 'bundled doctor script is available' }
            @{ Path = 'dist/assets/scripts/ao-update.ps1'; Label = 'bundled update script is available' }
        )
        foreach ($c in $checks) {
            $full = Join-Path $RepoRoot $c.Path
            if (Test-Path $full) { Write-Pass $c.Label } else { Write-Fail "$($c.Label) (missing $full). Fix: reinstall @aoagents/ao" }
        }
        return
    }
    if (Test-Path (Join-Path $RepoRoot 'node_modules')) {
        Write-Pass "dependencies are installed at $RepoRoot\node_modules"
    } else {
        Write-Fail "dependencies are missing at $RepoRoot\node_modules. Fix: run pnpm install"
    }
    if (Test-Path (Join-Path $RepoRoot 'packages/core/dist/index.js')) {
        Write-Pass "core package is built"
    } else {
        Write-Fail "core package is not built. Fix: run pnpm --filter @aoagents/ao-core build"
    }
    if (Test-Path (Join-Path $RepoRoot 'packages/cli/dist/index.js')) {
        Write-Pass "CLI package is built"
    } else {
        Write-Fail "CLI package is not built. Fix: run pnpm --filter @aoagents/ao-cli build"
    }
}

function Check-RuntimeSanity {
    if ($ScriptLayout -eq 'package-install') {
        $entry = Join-Path $RepoRoot 'dist/index.js'
        if (-not (Test-Path $entry)) {
            Write-Fail "packaged CLI entrypoint is missing. Fix: reinstall @aoagents/ao"
            return
        }
        & node $entry --version *> $null
        if ($LASTEXITCODE -eq 0) {
            Write-Pass "packaged CLI runtime sanity check passed (ao --version)"
        } else {
            Write-Fail "packaged CLI runtime sanity check failed. Fix: reinstall @aoagents/ao"
        }
        return
    }
    $entry = Join-Path $RepoRoot 'packages/ao/bin/ao.js'
    if (-not (Test-Path $entry)) {
        Write-Fail "launcher entrypoint is missing. Fix: reinstall from a clean checkout"
        return
    }
    & node $entry --version *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Pass "launcher runtime sanity check passed (ao --version)"
    } else {
        Write-Fail "launcher runtime sanity check failed. Fix: run pnpm build and refresh the launcher"
    }
}

function Check-ConfigDirs {
    $configPath = Find-AoConfig
    if (-not $configPath) {
        Write-Warn2 "No agent-orchestrator config was found. Fix: run ao init --auto in a target repo"
        return
    }
    Write-Pass "config found at $configPath"
    $dataDir = Read-ConfigValue 'dataDir' $configPath
    $worktreeDir = Read-ConfigValue 'worktreeDir' $configPath
    if (-not $dataDir)     { $dataDir     = Join-Path $DefaultConfigHome '.agent-orchestrator' }
    if (-not $worktreeDir) { $worktreeDir = Join-Path $DefaultConfigHome '.worktrees' }
    $dataDir     = Expand-HomePath $dataDir
    $worktreeDir = Expand-HomePath $worktreeDir
    Ensure-Dir $dataDir     'metadata directory' "New-Item -ItemType Directory -Path $dataDir -Force"
    Ensure-Dir $worktreeDir 'worktree directory' "New-Item -ItemType Directory -Path $worktreeDir -Force"
}

function Check-StaleTempFiles {
    $tempRoot = if ($env:AO_DOCTOR_TMP_ROOT) { $env:AO_DOCTOR_TMP_ROOT } else { Join-Path $env:TEMP 'agent-orchestrator' }
    if (-not (Test-Path $tempRoot)) {
        Write-Pass "temp root exists check skipped because $tempRoot does not exist"
        return
    }
    $cutoff = (Get-Date).AddMinutes(-60)
    $stale = Get-ChildItem -Path $tempRoot -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt $cutoff -and ($_.Name -like 'ao-*.tmp' -or $_.Name -like 'ao-*.pid' -or $_.Name -like 'ao-*.lock') }

    if (-not $stale -or $stale.Count -eq 0) {
        Write-Pass "no stale temp files were detected under $tempRoot"
        return
    }
    if ($Fix) {
        $deleted = 0
        foreach ($f in $stale) {
            try { Remove-Item $f.FullName -Force; $deleted++ } catch { }
        }
        if ($deleted -eq $stale.Count) {
            Write-Fixed "$deleted stale temp files removed from $tempRoot"
        } else {
            Write-Warn2 "Only removed $deleted of $($stale.Count) stale temp files from $tempRoot. Fix: inspect that directory manually"
        }
        return
    }
    Write-Warn2 "$($stale.Count) stale temp files older than 60 minutes found under $tempRoot. Fix: rerun ao doctor --fix"
}

Write-Host "Agent Orchestrator Doctor`n"

Check-Node
Check-Git
Check-Pnpm
Check-Launcher
Check-Tmux
Check-Gh
Check-ConfigDirs
Check-StaleTempFiles
Check-InstallLayout
Check-RuntimeSanity

Write-Host ""
Write-Host "Results: $script:PassCount PASS, $script:WarnCount WARN, $script:FailCount FAIL, $script:FixCount FIXED"

if ($script:FailCount -gt 0) {
    Write-Error "Environment needs attention before AO is safe to update or run."
    exit 1
}

Write-Host "Environment looks healthy enough to run Agent Orchestrator."
exit 0
