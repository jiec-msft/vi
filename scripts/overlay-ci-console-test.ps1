$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Terminal rollback fault checks require an isolated GitHub-hosted Windows runner.'
}
$helper = Join-Path $PSScriptRoot 'overlay-ci-console.ps1'
$pwsh = (Get-Process -Id $PID).Path
$file = Join-Path $env:GITHUB_WORKSPACE 'artifacts-ci\overlay-recovery\restore-fault.json'
try {
    & $pwsh -NoProfile -NonInteractive -File $helper prepare -ReportName restore-fault.json
    if ($LASTEXITCODE -ne 0) { throw 'Rollback fault fixture preparation failed.' }
    & $pwsh -NoProfile -NonInteractive -File $helper restore -ReportName restore-fault.json -FailRestoreSnapshot
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) { throw 'Injected restore diagnostic failure returned success.' }
    $report = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json -AsHashtable
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Console\%%Startup')
    try {
        if ([bool] $key -ne $report.original.keyExisted) { throw 'Rollback did not restore original key presence.' }
        foreach ($name in @('DelegationConsole', 'DelegationTerminal')) {
            $original = $report.original.values[$name]
            $exists = $key -and $key.GetValueNames() -contains $name
            if ([bool] $exists -ne $original.exists) { throw 'Rollback did not restore original value presence.' }
            if ($exists -and ($key.GetValue($name) -cne $original.value -or
                $key.GetValueKind($name).ToString() -ne $original.kind)) {
                throw 'Rollback did not restore original value and kind.'
            }
        }
    } finally { if ($key) { $key.Dispose() } }
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
            & $pwsh -NoProfile -NonInteractive -File $helper restore -ReportName restore-fault.json
            if ($LASTEXITCODE -ne 0) { throw 'Rollback fault fixture cleanup failed.' }
        }
    }
}
