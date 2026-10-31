if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Owned child launch diagnostics require an isolated GitHub-hosted Windows runner.'
}
function Invoke-OverlayChild {
    param(
        [string[]] $Arguments,
        [ValidateSet('negative-parent', 'fixture-prepare', 'fixture-restore')][string] $Role
    )
    $parent = Get-Process -Id $PID
    $trace = @{ role = $Role; callerPid = $PID; callerExe = [IO.Path]::GetFileName($parent.Path);
        requestedAt = [DateTime]::UtcNow.ToString('o'); createNoWindow = $true; useShellExecute = $false;
        redirectedOutput = $true; diagnosticErrors = @(); hostChoiceBeforeLaunch = @{} }
    $key = $null
    try {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Console\%%Startup')
        foreach ($name in @('DelegationConsole', 'DelegationTerminal')) {
            $value = if ($key) { $key.GetValue($name) } else { $null }
            $guid = [guid]::Empty
            if ($null -ne $value -and ![guid]::TryParse($value, [ref] $guid)) {
                throw 'Non-GUID terminal selector was excluded from launch diagnostics.'
            }
            $trace.hostChoiceBeforeLaunch[$name] = $value
        }
    } catch { $trace.diagnosticErrors += $_.Exception.Message }
    finally {
        try { if ($key) { $key.Dispose() } }
        catch { $trace.diagnosticErrors += $_.Exception.Message }
    }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $parent.Path
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $child = [Diagnostics.Process]::new()
    $child.StartInfo = $start
    $failure = $null
    try {
        if (!$child.Start()) { throw 'Owned PowerShell child did not start.' }
        $trace.pid = $child.Id
        $trace.createdAt = $child.StartTime.ToUniversalTime().ToString('o')
        $stdout = $child.StandardOutput.ReadToEndAsync()
        $stderr = $child.StandardError.ReadToEndAsync()
        try {
            $identities = @(Get-CimInstance Win32_Process -Filter "ProcessId=$($child.Id) OR ProcessId=$PID" `
                -OperationTimeoutSec 5 | Select-Object ProcessId, ParentProcessId, Name, CreationDate)
            $trace.identities = @($identities | ForEach-Object {
                @{ pid = [int] $_.ProcessId; parentPid = [int] $_.ParentProcessId; exe = $_.Name;
                    createdAt = $_.CreationDate.ToUniversalTime().ToString('o') }
            })
            $trace.childParentUnknown = !@($identities | Where-Object { $_.ProcessId -eq $child.Id }).Count
        } catch {
            $trace.childParentUnknown = $true
            $trace.diagnosticErrors += $_.Exception.Message
        }
        if (!$child.WaitForExit(120000)) { throw 'Owned PowerShell child exceeded its bounded execution deadline.' }
        $output = $stdout.GetAwaiter().GetResult() + "`n" + $stderr.GetAwaiter().GetResult()
        $code = $child.ExitCode
        $trace.exitCode = $code
        $trace.exitedAt = [DateTime]::UtcNow.ToString('o')
    } catch {
        $failure = $_.Exception.Message
        throw
    } finally {
        $cleanupFailure = $null
        try {
            if ($trace.pid -and !$child.HasExited) {
                Stop-Process -Id $child.Id -Force
                if (!$child.WaitForExit(2000)) { throw 'Owned PowerShell child could not be reaped.' }
            }
            if ($trace.pid -and $child.HasExited) {
                $trace.exitCode = $child.ExitCode
                $trace.exitedAt = [DateTime]::UtcNow.ToString('o')
            }
            $child.Dispose()
        } catch { $cleanupFailure = $_.Exception.Message }
        $trace.failure = $failure
        $trace.cleanupFailure = $cleanupFailure
        $traceFailure = $null
        try {
            $directory = Join-Path $env:GITHUB_WORKSPACE 'artifacts-ci\overlay-recovery'
            New-Item -ItemType Directory -Path $directory -Force | Out-Null
            $trace | ConvertTo-Json -Depth 6 -Compress |
                Add-Content -LiteralPath (Join-Path $directory 'process-launches.jsonl') -Encoding utf8
        } catch { $traceFailure = $_.Exception.Message }
        if ($cleanupFailure -or $traceFailure) {
            $errors = @()
            if ($failure) { $errors += $failure }
            if ($cleanupFailure) { $errors += "owned child cleanup failed: $cleanupFailure" }
            if ($traceFailure) { $errors += "child lifecycle persistence failed after exit $($trace.exitCode): $traceFailure" }
            throw ($errors -join '; ')
        }
    }
    return @{ exitCode = $code; output = $output }
}
