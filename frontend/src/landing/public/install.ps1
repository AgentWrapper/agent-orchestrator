$ErrorActionPreference = "Stop"

$repo = if ($env:AO_INSTALL_REPO) { $env:AO_INSTALL_REPO } else { "AgentWrapper/agent-orchestrator" }
$baseUrl = if ($env:AO_INSTALL_BASE_URL) {
	$env:AO_INSTALL_BASE_URL
} else {
	"https://github.com/$repo/releases/latest/download"
}

if (-not [Environment]::Is64BitOperatingSystem) {
	throw "Agent Orchestrator currently requires 64-bit Windows."
}

$asset = "agent-orchestrator-win32-x64.exe"
$url = "$baseUrl/$asset"
$destination = Join-Path ([IO.Path]::GetTempPath()) $asset

Write-Host "Downloading Agent Orchestrator from $url"
Invoke-WebRequest -Uri $url -OutFile $destination

if ($env:AO_INSTALL_NO_RUN -eq "1") {
	Write-Host "Downloaded installer to $destination"
	Write-Host "Run it to install Agent Orchestrator."
	exit 0
}

Write-Host "Starting installer..."
$process = Start-Process -FilePath $destination -Wait -PassThru
if ($process.ExitCode -ne 0) {
	throw "Installer exited with code $($process.ExitCode)."
}

Write-Host "Agent Orchestrator installer finished."
