$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:RUNNER_OS -cne 'Windows' -or $env:VI_CARET_TRUSTED_HEAD -cne 'true') {
    throw 'Token OBJECT diagnostic requires trusted hosted Windows CI.'
}
Add-Type -Path @((Join-Path $PSScriptRoot 'windows-ci-desktop-native.cs'),
    (Join-Path $PSScriptRoot 'caret-access-diagnostic.cs'), (Join-Path $PSScriptRoot 'caret-token-access.cs'))
$output = Join-Path $PWD 'artifacts-ci\caret-token-access'
$code = [ViCiDesktop]::DiagnoseCaretTokenObject($output)
Get-Content -LiteralPath (Join-Path $output 'token-object-report.json')
if ($code -ne 0) { throw 'Read-only generated token OBJECT diagnostic failed.' }
