$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:RUNNER_OS -cne 'Windows' -or $env:VI_EXPECTED_ARCH -cne 'x64' -or
    $env:VI_CARET_TRUSTED_HEAD -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'jiec-msft/vi') {
    throw 'Read-only access diagnostic requires the trusted hosted Windows x64 job.'
}
Add-Type -Path @((Join-Path $PSScriptRoot 'windows-ci-desktop-native.cs'),
    (Join-Path $PSScriptRoot 'caret-access-diagnostic.cs'))
$root = (Get-Location).Path
$output = Join-Path $root 'artifacts-ci\caret-access'
$code = [ViCiDesktop]::RunCaretAccessDiagnostic($root, $output, $true)
Get-Content -LiteralPath (Join-Path $output 'access-report.json')
if ($code -ne 0) { throw 'Read-only controlled access diagnostic failed; no launch was attempted.' }
