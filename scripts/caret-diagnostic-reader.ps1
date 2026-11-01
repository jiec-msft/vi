$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') {
    throw 'Reader fixture requires the isolated hosted Windows job.'
}
$env:VI_EXPECTED_ARCH = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString().ToLowerInvariant()
Add-Type -Path @((Join-Path $PSScriptRoot 'windows-ci-desktop-native.cs'), (Join-Path $PSScriptRoot 'caret-access-diagnostic.cs'))
$proof = [ViCiDesktop]::VerifyOwnedDiagnosticSnapshotReader((Join-Path $PWD 'artifacts-ci\caret-reader'))
$proof | ConvertTo-Json -Compress
if (-not $proof.passed -or -not $proof.ownedFixtureRemoved) { throw 'Owned reader fixture failed.' }
