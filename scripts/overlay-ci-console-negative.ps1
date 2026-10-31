$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Console negative-path checks require an isolated GitHub-hosted Windows runner.'
}
$pwsh = (Get-Process -Id $PID).Path
$helper = Join-Path $PSScriptRoot 'overlay-ci-console.ps1'
$test = Join-Path $PSScriptRoot 'overlay-ci-console-test.ps1'
$directory = Join-Path $env:GITHUB_WORKSPACE 'artifacts-ci\overlay-recovery'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
function Registry-State {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Console\%%Startup')
    try {
        $state = @{ keyExisted = [bool] $key; values = @{} }
        foreach ($name in @('DelegationConsole', 'DelegationTerminal')) {
            $exists = $key -and $key.GetValueNames() -contains $name
            $state.values[$name] = @{ exists = [bool] $exists;
                value = if ($exists) { $key.GetValue($name) } else { $null };
                kind = if ($exists) { $key.GetValueKind($name).ToString() } else { $null } }
        }
        return $state
    } finally { if ($key) { $key.Dispose() } }
}
function Matches-Original($original, $actual) {
    if ($original.keyExisted -ne $actual.keyExisted) { return $false }
    foreach ($name in @('DelegationConsole', 'DelegationTerminal')) {
        if ($original.values[$name].exists -ne $actual.values[$name].exists -or
            $original.values[$name].value -cne $actual.values[$name].value -or
            $original.values[$name].kind -ne $actual.values[$name].kind) { return $false }
    }
    function Failure-Text($output) {
        $text = ($output | Out-String) -replace "$([char]27)\[[0-9;]*[a-zA-Z]", ''
        return $text -replace '\s+', ' '
    }
    return $true
}
$result = @{ cases = @(); status = 'running'; runId = $env:GITHUB_RUN_ID; attempt = $env:GITHUB_RUN_ATTEMPT }
foreach ($case in @('prepare', 'missing-receipt', 'mismatch')) {
    $before = Registry-State
    $output = & $pwsh -NoProfile -NonInteractive -File $test -FailParent $case 2>&1
    $code = $LASTEXITCODE
    $actual = Registry-State
    $marker = switch ($case) {
        'prepare' { 'VI_PARENT_FAIL:prepare' }
        'missing-receipt' { 'VI_PARENT_FAIL:receipt' }
        'mismatch' { 'VI_PARENT_FAIL:mismatch' }
    }
    $reason = switch ($case) {
        'prepare' { 'Injected prepare failure' }
        'missing-receipt' { 'diagnostic error receipt missing' }
        'mismatch' { 'Injected parent registry mismatch assertion' }
    }
    $text = Failure-Text $output
    $witness = $text -match [regex]::Escape($marker) -and $text -match [regex]::Escape($reason)
    $matched = Matches-Original $before $actual
    $result.cases += @{ name = "parent-$case"; exitCode = $code; original = $before; actual = $actual;
        originalMatched = $matched; expectedFailureReported = $witness;
        passed = $code -ne 0 -and $matched -and $witness }
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $directory 'negative-parent.json') -Encoding utf8
}
foreach ($case in @('write', 'combined')) {
    $before = Registry-State
    $reportName = if ($case -eq 'write') { 'restore-write-fault.json' } else { 'restore-combined-fault.json' }
    $caseFailure = $null
    try {
        $prepareOutput = & $pwsh -NoProfile -NonInteractive -File $helper prepare -ReportName $reportName 2>&1
        if ($LASTEXITCODE -ne 0) { throw 'Negative restore fixture preparation failed.' }
        $arguments = @('-NoProfile', '-NonInteractive', '-File', $helper, 'restore',
            '-ReportName', $reportName, '-FailRestoreReportWrite')
        if ($case -eq 'combined') { $arguments += '-FailRestoreSnapshot' }
        $output = & $pwsh @arguments 2>&1
        $code = $LASTEXITCODE
        $actual = Registry-State
        $text = Failure-Text $output
        $witness = $text -match 'Injected restore report write failure' -and $text -match 'Original terminal choice restored'
        if ($case -eq 'combined') { $witness = $witness -and $text -match 'Injected restore Process-Snapshot failure' }
        $matched = Matches-Original $before $actual
        $result.cases += @{ name = "restore-$case"; exitCode = $code; original = $before; actual = $actual;
            originalMatched = $matched; expectedFailureReported = $witness;
            passed = $code -ne 0 -and $matched -and $witness }
        $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $directory 'negative-parent.json') -Encoding utf8
    } catch {
        $caseFailure = $_.Exception.Message
        throw
    } finally {
        try {
            $state = Get-Content -Raw -LiteralPath (Join-Path $directory $reportName) | ConvertFrom-Json -AsHashtable
            if (!$state.restoreVerified) {
                & $pwsh -NoProfile -NonInteractive -File $helper restore -ReportName $reportName
                if ($LASTEXITCODE -ne 0) { throw 'Negative restore fixture cleanup failed.' }
            }
        } catch {
            $message = "Negative restore fixture cleanup failed: $($_.Exception.Message)"
            if ($caseFailure) { throw "$caseFailure; $message" }
            throw $message
        }
    }
}
$result.status = if (@($result.cases | Where-Object { !$_.passed }).Count) { 'failed' } else { 'passed' }
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $directory 'negative-parent.json') -Encoding utf8
if ($result.status -ne 'passed') { throw 'A parent failure returned success or a diagnostic failure blocked original registry rollback.' }
Write-Output 'All parent failures remained nonzero, and snapshot/report-write failures preserved original registry state.'
exit 0
