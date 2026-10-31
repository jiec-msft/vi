param([ValidateSet('none', 'prepare', 'missing-receipt', 'mismatch')][string] $FailParent = 'none')
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Terminal rollback fault checks require an isolated GitHub-hosted Windows runner.'
}
$helper = Join-Path $PSScriptRoot 'overlay-ci-console.ps1'
$pwsh = (Get-Process -Id $PID).Path
$reportName = if ($FailParent -eq 'none') { 'restore-fault.json' } else { "parent-$FailParent.json" }
$file = Join-Path $env:GITHUB_WORKSPACE "artifacts-ci\overlay-recovery\$reportName"
try {
    $prepareArgs = @('-NoProfile', '-NonInteractive', '-File', $helper, 'prepare', '-ReportName', $reportName)
    if ($FailParent -eq 'prepare') { $prepareArgs += '-FailPrepare' }
    & $pwsh @prepareArgs
    if ($LASTEXITCODE -ne 0) { throw 'Rollback fault fixture preparation failed.' }
    & $pwsh -NoProfile -NonInteractive -File $helper restore -ReportName $reportName -FailRestoreSnapshot
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) { throw 'Injected restore diagnostic failure returned success.' }
    $report = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json -AsHashtable
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Console\%%Startup')
    try {
        $actual = @{ keyExisted = [bool] $key; values = @{} }
        foreach ($name in @('DelegationConsole', 'DelegationTerminal')) {
            $exists = $key -and $key.GetValueNames() -contains $name
            $actual.values[$name] = @{ exists = [bool] $exists;
                value = if ($exists) { $key.GetValue($name) } else { $null };
                kind = if ($exists) { $key.GetValueKind($name).ToString() } else { $null } }
        }
    } finally { if ($key) { $key.Dispose() } }
    $report.faultObservation = @{ restoreExitCode = $exitCode; actualRegistry = $actual }
    $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $file -Encoding utf8
    if ($FailParent -eq 'mismatch') { throw 'Injected parent registry mismatch assertion.' }
    if ($actual.keyExisted -ne $report.original.keyExisted) { throw 'Rollback did not restore original key presence.' }
    foreach ($name in @('DelegationConsole', 'DelegationTerminal')) {
        $original = $report.original.values[$name]
        if ($actual.values[$name].exists -ne $original.exists) { throw 'Rollback did not restore original value presence.' }
        if ($actual.values[$name].value -cne $original.value -or $actual.values[$name].kind -ne $original.kind) {
            throw 'Rollback did not restore original value and kind.'
        }
    }
    if ($FailParent -eq 'missing-receipt') { $report.restoreDiagnosticError = $null }
    if (!$report.restoreVerified -or $report.restoreDiagnosticError -ne 'Injected restore Process-Snapshot failure.') {
        throw 'Rollback verification or explicit diagnostic error receipt missing.'
    }
    $report.faultTest = @{ result = 'passed'; restoreExitCode = $exitCode;
        actualRegistryReadbackMatchedOriginal = $true; diagnosticFailureExplicit = $true }
    $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $file -Encoding utf8
    Write-Output 'Injected restore diagnostic failed explicitly and original registry state was independently verified.'
} finally {
    if (Test-Path -LiteralPath $file) {
        $state = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json -AsHashtable
        if (!$state.restoreVerified) {
            & $pwsh -NoProfile -NonInteractive -File $helper restore -ReportName $reportName
            if ($LASTEXITCODE -ne 0) { throw 'Rollback fault fixture cleanup failed.' }
        }
    }
    exit 0
}
