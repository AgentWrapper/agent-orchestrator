[CmdletBinding()]
param(
    [switch]$Fetch,
    [switch]$InstallDependencies,
    [switch]$Start,
    [string]$InstallDirectory = (Join-Path $HOME '.local\bin')
)

$ErrorActionPreference = 'Stop'

function Invoke-Native {
    param(
        [Parameter(Mandatory)]
        [string]$Command,

        [Parameter(Mandatory)]
        [string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command exited with code $LASTEXITCODE"
    }
}

function Test-Native {
    param(
        [Parameter(Mandatory)]
        [string]$Command,

        [Parameter(Mandatory)]
        [string[]]$Arguments
    )

    $previousErrorPreference = $ErrorActionPreference
    $hadNativeErrorPreference = Test-Path Variable:PSNativeCommandUseErrorActionPreference
    $previousNativeErrorPreference = $PSNativeCommandUseErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $PSNativeCommandUseErrorActionPreference = $false
        & $Command @Arguments *> $null
        return $LASTEXITCODE -eq 0
    }
    finally {
        $ErrorActionPreference = $previousErrorPreference
        if ($hadNativeErrorPreference) {
            $PSNativeCommandUseErrorActionPreference = $previousNativeErrorPreference
        }
        else {
            Remove-Item Variable:PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue
        }
    }
}

function Test-SamePath {
    param(
        [Parameter(Mandatory)]
        [string]$Left,

        [Parameter(Mandatory)]
        [string]$Right
    )

    $leftPath = [System.IO.Path]::GetFullPath(
        [Environment]::ExpandEnvironmentVariables($Left).Trim().Trim('"')
    ).TrimEnd('\')
    $rightPath = [System.IO.Path]::GetFullPath(
        [Environment]::ExpandEnvironmentVariables($Right).Trim().Trim('"')
    ).TrimEnd('\')
    return $leftPath.Equals($rightPath, [System.StringComparison]::OrdinalIgnoreCase)
}

function Ensure-AOOnPath {
    param(
        [Parameter(Mandatory)]
        [string]$Directory,

        [Parameter(Mandatory)]
        [string]$Executable
    )

    $currentAO = Get-Command ao -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($currentAO -and (Test-SamePath -Left $currentAO.Source -Right $Executable)) {
        Write-Host "ao already resolves to $Executable; PATH is unchanged."
        return
    }

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $userEntries = @($userPath -split ';' | Where-Object { $_ })
    $otherUserEntries = @($userEntries | Where-Object {
        -not (Test-SamePath -Left $_ -Right $Directory)
    })
    $newUserPath = (@($Directory) + $otherUserEntries) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')

    $processEntries = @($env:PATH -split ';' | Where-Object { $_ })
    $otherProcessEntries = @($processEntries | Where-Object {
        -not (Test-SamePath -Left $_ -Right $Directory)
    })
    $env:PATH = (@($Directory) + $otherProcessEntries) -join ';'
    Write-Host "Placed $Directory at the beginning of your user PATH."
}

function Install-Binary {
    param(
        [Parameter(Mandatory)]
        [string]$Source,

        [Parameter(Mandatory)]
        [string]$Destination
    )

    try {
        Copy-Item -LiteralPath $Source -Destination $Destination -Force
        return
    }
    catch {
        $copyError = $_
        if (-not (Test-Path -LiteralPath $Destination)) {
            throw
        }
    }

    # Windows can keep an executable locked while restored PTY hosts continue
    # serving live sessions after the daemon exits. Rename the old image out of
    # the stable PATH location, then publish the new build in its place.
    $setAsidePath = "$Destination.in-use-$PID"
    try {
        Move-Item -LiteralPath $Destination -Destination $setAsidePath -Force
    }
    catch {
        throw $copyError
    }

    try {
        Copy-Item -LiteralPath $Source -Destination $Destination -Force
    }
    catch {
        Move-Item -LiteralPath $setAsidePath -Destination $Destination -Force
        throw
    }

    try {
        Remove-Item -LiteralPath $setAsidePath -Force
    }
    catch {
        Write-Warning "The previous in-use binary remains at $setAsidePath and can be removed after its sessions exit."
    }
}

function Ensure-ElectronBinary {
    param(
        [Parameter(Mandatory)]
        [string]$FrontendDirectory
    )

    $electronRoot = Join-Path $FrontendDirectory 'node_modules\electron'
    $electronExe = Join-Path $electronRoot 'dist\electron.exe'
    if (Test-Path -LiteralPath $electronExe) {
        return
    }

    $packagePath = Join-Path $electronRoot 'package.json'
    $installScript = Join-Path $electronRoot 'install.js'
    if (-not (Test-Path -LiteralPath $packagePath) -or -not (Test-Path -LiteralPath $installScript)) {
        throw 'Electron is missing from frontend dependencies after npm ci'
    }

    Write-Host 'Electron binary is missing; repairing its installation...'
    Invoke-Native -Command node -Arguments @($installScript)
    if (Test-Path -LiteralPath $electronExe) {
        return
    }

    # Electron's extract-zip installer can return successfully after extracting
    # only part of the cached archive under some Windows/Node combinations.
    # Reuse the checksum-verified cache artifact and let PowerShell finish it.
    $electronVersion = (Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json).version
    $cacheRoot = if ($env:electron_config_cache) {
        $env:electron_config_cache
    }
    else {
        Join-Path $env:LOCALAPPDATA 'electron\Cache'
    }
    $archive = Get-ChildItem -LiteralPath $cacheRoot -Recurse -File -Filter "electron-v$electronVersion-win32-*.zip" -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $archive) {
        throw "Electron $electronVersion did not install and its cache archive was not found under $cacheRoot"
    }

    $distPath = Join-Path $electronRoot 'dist'
    New-Item -ItemType Directory -Force -Path $distPath | Out-Null
    Expand-Archive -LiteralPath $archive.FullName -DestinationPath $distPath -Force
    [System.IO.File]::WriteAllText((Join-Path $electronRoot 'path.txt'), 'electron.exe')
    if (-not (Test-Path -LiteralPath $electronExe)) {
        throw "Electron repair completed without producing $electronExe"
    }
}

$isWindowsHost = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
if (-not $isWindowsHost) {
    throw 'scripts/install.ps1 supports Windows only'
}

$scriptDir = Split-Path -Parent $PSCommandPath
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
$backendDir = Join-Path $repoRoot 'backend'
$frontendDir = Join-Path $repoRoot 'frontend'
$nodeModules = Join-Path $frontendDir 'node_modules'
$resolvedInstallDirectory = [System.IO.Path]::GetFullPath($InstallDirectory)
$installPath = Join-Path $resolvedInstallDirectory 'ao.exe'

foreach ($command in @('git', 'go', 'npm')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "$command is required but was not found on PATH"
    }
}

if ($Fetch) {
    $branch = (& git -C $repoRoot branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not determine the current Git branch'
    }
    if ($branch -ne 'main') {
        throw "Fetch mode requires the main branch; current branch is '$branch'"
    }

    $trackedChanges = & git -C $repoRoot status --porcelain --untracked-files=no
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not inspect the Git worktree'
    }
    if ($trackedChanges) {
        throw 'Fetch mode requires a worktree with no tracked changes'
    }

    Invoke-Native -Command git -Arguments @('-C', $repoRoot, 'fetch', 'origin', 'main')
    Invoke-Native -Command git -Arguments @('-C', $repoRoot, 'pull', '--ff-only', 'origin', 'main')
}

if (Test-Path -LiteralPath $nodeModules) {
    $dependenciesReady = Test-Native -Command npm -Arguments @('--prefix', $frontendDir, 'ls', '--depth=0')
}
else {
    $dependenciesReady = $false
}

if ($InstallDependencies -or -not $dependenciesReady) {
    if (-not $dependenciesReady) {
        Write-Host 'Frontend dependencies are missing or stale; running npm ci...'
    }
    Invoke-Native -Command npm -Arguments @('ci', '--prefix', $frontendDir)
}
Ensure-ElectronBinary -FrontendDirectory $frontendDir

if ($Start) {
    $releaseApp = Get-Process -Name 'agent-orchestrator' -ErrorAction SilentlyContinue
    if ($releaseApp) {
        throw 'Close the installed Agent Orchestrator desktop app before using -Start'
    }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ao-source-install-$PID"
$builtPath = Join-Path $tempRoot 'ao.exe'
New-Item -ItemType Directory -Path $tempRoot | Out-Null

try {
    Push-Location $backendDir
    try {
        Invoke-Native -Command go -Arguments @('build', '-trimpath', '-o', $builtPath, './cmd/ao')
    }
    finally {
        Pop-Location
    }

    & $builtPath status *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Host 'Stopping the running AO daemon before replacing ao.exe...'
        Invoke-Native -Command $builtPath -Arguments @('stop', '--timeout', '10s')
    }

    New-Item -ItemType Directory -Force -Path $resolvedInstallDirectory | Out-Null
    Install-Binary -Source $builtPath -Destination $installPath
    Ensure-AOOnPath -Directory $resolvedInstallDirectory -Executable $installPath

    $resolvedAO = (Get-Command ao -CommandType Application -ErrorAction Stop).Source
    if (-not (Test-SamePath -Left $resolvedAO -Right $installPath)) {
        throw "ao resolves to $resolvedAO instead of $installPath; open a new PowerShell and check Get-Command -All ao"
    }

    Write-Host "Installed source-built AO at $installPath"
    & $installPath version
    if ($LASTEXITCODE -ne 0) {
        throw 'The installed AO binary did not run successfully'
    }
    Write-Host ''
    if ($Start) {
        Write-Host "Starting AO from source at $repoRoot"
        Write-Host 'This terminal stays attached to the dev app; press Ctrl-C to stop it.'
        $previousDaemonCommand = $env:AO_DAEMON_COMMAND
        $previousPort = $env:AO_PORT
        $previousRunFile = $env:AO_RUN_FILE
        $previousDataDirectory = $env:AO_DATA_DIR
        $env:AO_DAEMON_COMMAND = "`"$installPath`" daemon"
        if (-not $env:AO_PORT) {
            $env:AO_PORT = '3001'
        }
        if (-not $env:AO_RUN_FILE) {
            $env:AO_RUN_FILE = Join-Path $HOME '.ao\running.json'
        }
        if (-not $env:AO_DATA_DIR) {
            $env:AO_DATA_DIR = Join-Path $HOME '.ao\data'
        }
        Push-Location $frontendDir
        try {
            # Invoke Forge directly so npm does not run the predev release-build
            # hook. The installer already built the exact daemon executable and
            # AO_DAEMON_COMMAND makes the source app supervise that binary.
            Invoke-Native -Command npm -Arguments @('exec', '--', 'electron-forge', 'start')
        }
        finally {
            Pop-Location
            if ($null -eq $previousDaemonCommand) {
                Remove-Item Env:AO_DAEMON_COMMAND -ErrorAction SilentlyContinue
            }
            else {
                $env:AO_DAEMON_COMMAND = $previousDaemonCommand
            }
            foreach ($entry in @{
                AO_PORT = $previousPort
                AO_RUN_FILE = $previousRunFile
                AO_DATA_DIR = $previousDataDirectory
            }.GetEnumerator()) {
                if ($null -eq $entry.Value) {
                    Remove-Item "Env:$($entry.Key)" -ErrorAction SilentlyContinue
                }
                else {
                    Set-Item "Env:$($entry.Key)" $entry.Value
                }
            }
        }
    }
    else {
        Write-Host 'Start the source app with:'
        Write-Host "  & '$PSCommandPath' -Start"
    }
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
