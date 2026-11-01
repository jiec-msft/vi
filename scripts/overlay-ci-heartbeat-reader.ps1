[CmdletBinding()]
param([string] $Directory, [string] $Executable, [string] $WorkingDirectory)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:RUNNER_OS -cne 'Windows' -or -not $IsWindows -or
    $env:GITHUB_RUN_ID -notmatch '^[1-9][0-9]*$' -or $env:GITHUB_RUN_ATTEMPT -notmatch '^[1-9][0-9]*$' -or
    [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString().ToLowerInvariant() -cne $env:VI_EXPECTED_ARCH) {
    throw 'Heartbeat protocol verification requires native GitHub-hosted Windows CI.'
}
Add-Type -Path (Join-Path $PSScriptRoot 'windows-ci-desktop-native.cs')
$result = [ViCiDesktop]::VerifyImmutableHeartbeats($Executable,
    (Join-Path $PSScriptRoot 'windows-ci-desktop-probe.cjs'), $Directory, $WorkingDirectory)
exit $result
