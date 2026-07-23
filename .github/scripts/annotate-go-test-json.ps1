param(
	[Parameter(Mandatory = $true)]
	[string]$LogPath,
	[string]$File = "."
)

function Escape-Annotation([string]$Value) {
	return $Value.Replace("%", "%25").Replace("`r", "%0D").Replace("`n", "%0A")
}

$events = @()
foreach ($line in Get-Content -LiteralPath $LogPath) {
	try {
		$events += $line | ConvertFrom-Json
	} catch {
		# Non-JSON lines can still appear for build or runtime failures.
	}
}

$failedTests = @($events | Where-Object { $_.Action -eq "fail" -and $_.Test })
if ($failedTests.Count -eq 0) {
	$failedTests = @($events | Where-Object { $_.Action -eq "fail" -and $_.Package } | Select-Object -First 20)
}

foreach ($failure in $failedTests) {
	$package = [string]$failure.Package
	$test = [string]$failure.Test
	$title = if ($test -ne "") { "$package $test" } else { $package }
	$related = @($events | Where-Object {
		$_.Package -eq $failure.Package -and
		$_.Action -eq "output" -and
		($test -eq "" -or $_.Test -eq $test)
	} | Select-Object -Last 40)
	$output = ($related | ForEach-Object { [string]$_.Output }) -join ""
	if ($output.Trim() -eq "") {
		$output = "Go test failed; no structured output was attached to the failing event."
	}
	$message = Escape-Annotation("$title`n$output")
	$escapedTitle = Escape-Annotation($title)
	Write-Host "::error file=$File,title=$escapedTitle::$message"
}
