$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:RUNNER_OS -cne 'Windows' -or $env:VI_EXPECTED_ARCH -cne 'x64') {
    throw 'Caret launcher requires a standard hosted Windows x64 runner.'
}
Add-Type -Path @((Join-Path $PSScriptRoot 'windows-ci-desktop-native.cs'),
    (Join-Path $PSScriptRoot 'caret-access-diagnostic.cs'))
$root = (Get-Location).Path
$result = [ViCiDesktop]::RunQualifiedCaretAsUser((Join-Path $root 'node_modules\electron\dist\electron.exe'),
    (Join-Path $PSScriptRoot 'windows-caret-ui.cjs'), (Join-Path $root 'artifacts-ci\caret'), $root, 180, $true)
if ($result -ne 0) {
    Get-Content -LiteralPath (Join-Path $root 'artifacts-ci\caret\caret-launch.json')
    if (Test-Path -LiteralPath (Join-Path $root 'artifacts-ci\caret\caret-report.json')) {
        Get-Content -LiteralPath (Join-Path $root 'artifacts-ci\caret\caret-report.json')
    }
    throw 'Owned medium-integrity caret App integration failed.'
}
$negative = Join-Path $root 'artifacts-ci\caret\quiet-exit'
$failed = [ViCiDesktop]::RunQualifiedCaretAsUser((Join-Path $root 'node_modules\electron\dist\electron.exe'),
    (Join-Path $PSScriptRoot 'windows-caret-quiet.cjs'), $negative, $root, 180)
$receipt = Get-Content -LiteralPath (Join-Path $negative 'caret-launch.json') -Raw | ConvertFrom-Json
if ($failed -ne 1 -or $receipt.passed -or $receipt.rawExitCode -ne 37 -or
    $receipt.errors.Count -ne 1 -or $receipt.ownedJobCleanup.active -ne 0 -or
    -not $receipt.originalDefaultUnchanged -or -not $receipt.exactBinaryPathVerified -or
    -not $receipt.rootUserVerified -or $receipt.rootIntegrity -ne 8192 -or
    -not $receipt.parentPrivilegesUnchanged -or -not $receipt.parentPrivilegeAttributesRestoredAtApiReturn -or
    $receipt.processApi -ne 'CreateProcessAsUserW') {
    throw 'Quiet nonzero exit did not preserve raw failure and owned cleanup.'
}
foreach ($name in @('launchTokenVerification', 'rootTokenVerification')) {
    $proof = $receipt.$name
    if (-not $proof.primary -or -not $proof.sameUser -or -not $proof.sameLogon -or
        -not $proof.sameSession -or -not $proof.adminDenyOnly -or
        -not $proof.privilegesNotIncreased -or $proof.uiAccess -ne 0 -or
        $proof.integrity -ne 8192 -or
        ($receipt.tokenOrigin -eq 'derived-restricted-medium' -and -not $proof.hasRestrictions)) {
        throw 'Quiet-exit root lacks actual restricted medium token assertions.'
    }
}
