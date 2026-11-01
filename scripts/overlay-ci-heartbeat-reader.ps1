[CmdletBinding()]
param(
    [ValidateSet('prepare', 'verify')] [string] $Mode = 'verify',
    [string] $Directory, [string] $Preparation, [string] $WorkingDirectory
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:RUNNER_OS -cne 'Windows' -or -not $IsWindows -or
    $env:GITHUB_RUN_ID -notmatch '^[1-9][0-9]*$' -or $env:GITHUB_RUN_ATTEMPT -notmatch '^[1-9][0-9]*$' -or
    $env:VI_PROBE_HEAD -notmatch '^[0-9a-f]{40}$' -or
    $env:VI_EXPECTED_ARCH -notin @('x64', 'arm64') -or
    [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString().ToLowerInvariant() -cne $env:VI_EXPECTED_ARCH) {
    throw 'Heartbeat protocol verification requires native GitHub-hosted Windows CI.'
}
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'windows-ci-desktop-native.cs'))
$Directory = [IO.Path]::GetFullPath($Directory)
$Preparation = [IO.Path]::GetFullPath($Preparation)
$WorkingDirectory = [IO.Path]::GetFullPath($WorkingDirectory)
$assembly = Join-Path $Preparation 'heartbeat-native.dll'
$manifestFile = Join-Path $Preparation 'manifest.json'
$checkout = (& git -C $WorkingDirectory rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $checkout -notmatch '^[0-9a-f]{40}$' -or
    $Preparation -cne (Join-Path $WorkingDirectory "artifacts-ci\overlay-recovery\heartbeat-preparation-$($env:VI_PROBE_HEAD)") -or
    $Directory -cne (Join-Path $WorkingDirectory 'artifacts-ci\overlay-recovery\heartbeat-reader')) {
    throw 'Heartbeat preparation paths or current checkout identity are invalid.'
}
function Save-Receipt([string] $File, $Value) {
    [IO.File]::WriteAllText($File, ($Value | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
}
function Assert-Preparation($Value) {
    if (-not $Value -or $Value.sourceHead -cne $env:VI_PROBE_HEAD -or $Value.checkoutSha -cne $checkout -or
        $Value.runId -cne $env:GITHUB_RUN_ID -or $Value.attempt -cne $env:GITHUB_RUN_ATTEMPT -or
        $Value.sourcePath -cne $source -or $Value.assemblyPath -cne $assembly -or
        $Value.verificationDirectory -cne $Directory -or
        $Value.nativeArchitecture -cne $env:VI_EXPECTED_ARCH -or
        $Value.osArchitecture -cne [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant() -or
        $Value.powerShellVersion -cne $PSVersionTable.PSVersion.ToString() -or
        $Value.framework -cne [Runtime.InteropServices.RuntimeInformation]::FrameworkDescription) {
        throw 'Heartbeat preparation manifest head/path/run/architecture/runtime identity mismatch.'
    }
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -cne $Value.sourceSHA256 -or
        (Get-FileHash -LiteralPath $assembly -Algorithm SHA256).Hash -cne $Value.assemblySHA256) {
        throw 'Heartbeat preparation source or assembly SHA256 mismatch.'
    }
    $expectedExecutable = Join-Path $WorkingDirectory 'node_modules\electron\dist\electron.exe'
    if ($Value.executablePath -cne $expectedExecutable -or
        (Get-Item -LiteralPath $expectedExecutable).VersionInfo.ProductVersion -cne $Value.executableVersion -or
        (Get-ChildItem -LiteralPath $Directory -Force | Measure-Object).Count -ne 0) {
        throw 'Heartbeat executable version/path or fresh verification target mismatch.'
    }
}
if ($Mode -eq 'prepare') {
    if (Test-Path -LiteralPath $Preparation) { throw 'Stale heartbeat preparation directory refused.' }
    if (Test-Path -LiteralPath $Directory) { throw 'Stale heartbeat verification target refused.' }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $startedTicks = [Diagnostics.Stopwatch]::GetTimestamp()
    $phases = [Collections.Generic.List[object]]::new()
    [IO.Directory]::CreateDirectory($Preparation) | Out-Null
    [IO.Directory]::CreateDirectory($Directory) | Out-Null
    $electronStartedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $electronStartedTicks = [Diagnostics.Stopwatch]::GetTimestamp()
    $electron = & node -p "JSON.stringify({path:require('electron'),version:require('electron/package.json').version})"
    if ($LASTEXITCODE -ne 0) { throw 'Existing Electron resolution failed during heartbeat preparation.' }
    $electron = $electron | ConvertFrom-Json
    $electronCompletedTicks = [Diagnostics.Stopwatch]::GetTimestamp()
    $phases.Add(@{ phase = 'resolve-electron'; startedAt = $electronStartedAt;
        completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();
        startedTicks = "$electronStartedTicks"; completedTicks = "$electronCompletedTicks";
        elapsedSeconds = ($electronCompletedTicks - $electronStartedTicks) / [double][Diagnostics.Stopwatch]::Frequency })
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    $compileStartedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $compileStartedTicks = [Diagnostics.Stopwatch]::GetTimestamp()
    Add-Type -Path $source -OutputAssembly $assembly
    $compileCompletedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $compileCompletedTicks = [Diagnostics.Stopwatch]::GetTimestamp()
    $phases.Add(@{ phase = 'compile-native'; startedAt = $compileStartedAt; completedAt = $compileCompletedAt;
        startedTicks = "$compileStartedTicks"; completedTicks = "$compileCompletedTicks";
        elapsedSeconds = ($compileCompletedTicks - $compileStartedTicks) / [double][Diagnostics.Stopwatch]::Frequency })
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -cne $sourceHash) {
        throw 'Native source changed during heartbeat preparation.'
    }
    $manifest = [ordered]@{
        sourceHead = $env:VI_PROBE_HEAD; checkoutSha = $checkout; runId = $env:GITHUB_RUN_ID;
        attempt = $env:GITHUB_RUN_ATTEMPT; sourcePath = $source; sourceSHA256 = $sourceHash;
        assemblyPath = $assembly; assemblySHA256 = (Get-FileHash -LiteralPath $assembly -Algorithm SHA256).Hash;
        nativeArchitecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString().ToLowerInvariant();
        osArchitecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant();
        powerShellVersion = $PSVersionTable.PSVersion.ToString();
        framework = [Runtime.InteropServices.RuntimeInformation]::FrameworkDescription;
        executablePath = $electron.path; executableVersion = (Get-Item -LiteralPath $electron.path).VersionInfo.ProductVersion;
        electronPackageVersion = $electron.version; verificationDirectory = $Directory; startedAt = $startedAt;
        startedTicks = "$startedTicks";
        monotonicClock = 'preparation-PowerShell-Stopwatch'; monotonicFrequency = "$([Diagnostics.Stopwatch]::Frequency)";
        phases = $phases
    }
    Assert-Preparation $manifest
    $negative = [Collections.Generic.List[object]]::new()
    foreach ($field in @('sourceHead', 'sourceSHA256', 'assemblySHA256', 'nativeArchitecture', 'verificationDirectory')) {
        $wrong = ($manifest | ConvertTo-Json -Depth 10 | ConvertFrom-Json)
        $wrong.$field = 'invalid'
        $rejected = $false
        try { Assert-Preparation $wrong }
        catch {
            $expected = if ($field -in @('sourceSHA256', 'assemblySHA256')) {
                'Heartbeat preparation source or assembly SHA256 mismatch.'
            } else { 'Heartbeat preparation manifest head/path/run/architecture/runtime identity mismatch.' }
            if ($_.Exception.Message -cne $expected) { throw }
            $rejected = $true; $negative.Add(@{ field = $field; error = $_.Exception.Message })
        }
        if (-not $rejected) { throw "Preparation rejected-field test did not fail: $field" }
    }
    $rejected = $false
    try { Assert-Preparation $null }
    catch {
        if ($_.Exception.Message -cne 'Heartbeat preparation manifest head/path/run/architecture/runtime identity mismatch.') { throw }
        $rejected = $true; $negative.Add(@{ field = 'missing-manifest'; error = $_.Exception.Message })
    }
    if (-not $rejected) { throw 'Preparation missing-manifest test did not fail.' }
    $staleFile = Join-Path $Directory 'stale-preflight.tmp'
    [IO.File]::WriteAllText($staleFile, 'owned negative preflight')
    try {
        $rejected = $false
        try { Assert-Preparation $manifest }
        catch {
            if ($_.Exception.Message -cne 'Heartbeat executable version/path or fresh verification target mismatch.') { throw }
            $rejected = $true; $negative.Add(@{ field = 'stale-content'; error = $_.Exception.Message })
        }
        if (-not $rejected) { throw 'Preparation stale-content test did not fail.' }
    } finally { Remove-Item -LiteralPath $staleFile }
    $manifest['negativeProvenanceCases'] = $negative
    $manifest['completedAt'] = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $manifest['completedTicks'] = "$([Diagnostics.Stopwatch]::GetTimestamp())"
    $manifest['elapsedSeconds'] = $clock.Elapsed.TotalSeconds
    Save-Receipt $manifestFile $manifest
    'Heartbeat preparation completed; no Default fixture was started. Preparation time remains in this UI job.'
    exit 0
}
$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
Assert-Preparation $manifest
$loadStartedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$loadStartedTicks = [Diagnostics.Stopwatch]::GetTimestamp()
Add-Type -Path $assembly
Assert-Preparation $manifest
Save-Receipt (Join-Path $Preparation 'loader.json') @{
    sourceHead = $env:VI_PROBE_HEAD; assemblySHA256 = $manifest.assemblySHA256;
    startedAt = $loadStartedAt; completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();
    startedTicks = "$loadStartedTicks"; completedTicks = "$([Diagnostics.Stopwatch]::GetTimestamp())";
    monotonicClock = 'loader-PowerShell-Stopwatch'; monotonicFrequency = "$([Diagnostics.Stopwatch]::Frequency)"
}
$result = [ViCiDesktop]::VerifyImmutableHeartbeats($manifest.executablePath,
    (Join-Path $PSScriptRoot 'windows-ci-desktop-probe.cjs'), $Directory, $WorkingDirectory)
exit $result
