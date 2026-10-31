param(
    [ValidateSet('prepare', 'restore')][string] $Mode = 'prepare',
    [ValidateSet('environment.json', 'restore-fault.json', 'parent-prepare.json', 'parent-missing-receipt.json',
        'parent-mismatch.json', 'restore-write-fault.json', 'restore-combined-fault.json')]
    [string] $ReportName = 'environment.json',
    [switch] $FailRestoreSnapshot,
    [switch] $FailRestoreReportWrite,
    [switch] $FailPrepare
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or !$env:GITHUB_WORKSPACE -or
    $env:GITHUB_RUN_ID -notmatch '^\d+$' -or $env:GITHUB_RUN_ATTEMPT -notmatch '^\d+$') {
    throw 'Console preparation is restricted to an isolated GitHub-hosted Windows runner.'
}
$directory = Join-Path $env:GITHUB_WORKSPACE 'artifacts-ci\overlay-recovery'
$file = Join-Path $directory $ReportName
$registryPath = 'Console\%%Startup'
$names = @('DelegationConsole', 'DelegationTerminal')
$consoleHost = '{B23D10C0-E52E-411E-9D5B-C09FDF709C7D}'
$support = 'https://support.microsoft.com/en-us/windows/apps/command-prompt-and-windows-powershell'
New-Item -ItemType Directory -Path $directory -Force | Out-Null

function Save-Report {
    if ($Mode -eq 'restore' -and $FailRestoreReportWrite) { throw 'Injected restore report write failure.' }
    $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $file -Encoding utf8
}
function Read-Selection {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registryPath)
    try {
        $values = @{}
        foreach ($name in $names) {
            $exists = $key -and $key.GetValueNames() -contains $name
            $value = if ($exists) { $key.GetValue($name) } else { $null }
            $kind = if ($exists) { $key.GetValueKind($name).ToString() } else { $null }
            $parsed = [guid]::Empty
            if ($exists -and ($kind -ne 'String' -or ![guid]::TryParse($value, [ref] $parsed))) {
                throw 'Unexpected default-terminal value type or non-GUID content.'
            }
            $values[$name] = @{ exists = [bool] $exists; value = $value; kind = $kind }
        }
        return @{ keyExisted = [bool] $key; values = $values }
    } finally { if ($key) { $key.Dispose() } }
}
function Process-Snapshot {
    if ($Mode -eq 'restore' -and $FailRestoreSnapshot) { throw 'Injected restore Process-Snapshot failure.' }
    $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CreationDate)
    if ($all.Count -gt 1024) { throw 'Process diagnostic inventory exceeded its bound.' }
    $script:lastProcessInventory = $all
    $byId = @{}
    foreach ($item in $all) { $byId[[int] $item.ProcessId] = $item }
    $roots = @($all | Where-Object { $_.Name -in @('WindowsTerminal.exe', 'wt.exe', 'wsl.exe',
        'wslhost.exe', 'OpenConsole.exe', 'conhost.exe') -or $_.ProcessId -eq $PID })
    $chains = foreach ($root in $roots) {
        $chain = @()
        $next = [int] $root.ProcessId
        for ($depth = 0; $depth -lt 8 -and $next -gt 0; $depth++) {
            if (!$byId.ContainsKey($next)) { $chain += @{ pid = $next; missing = $true }; break }
            $item = $byId[$next]
            if (!$item.Name -or $item.Name.Length -gt 260 -or $item.Name -match '[\\/\x00-\x1f]') {
                throw 'Unexpected executable identity in diagnostic chain.'
            }
            $chain += @{ pid = [int] $item.ProcessId; parentPid = [int] $item.ParentProcessId; exe = $item.Name;
                createdAt = if ($item.CreationDate) { $item.CreationDate.ToUniversalTime().ToString('o') } else { $null };
                creationUnavailable = !$item.CreationDate }
            if ($item.ParentProcessId -eq $next) { break }
            $next = [int] $item.ParentProcessId
        }
        @{ rootPid = [int] $root.ProcessId; exe = $root.Name; chain = $chain }
    }
    return @{ at = [DateTime]::UtcNow.ToString('o'); chains = @($chains) }
}
function Read-ProcessStarts($identifier, $baseline) {
    $queued = @(Get-Event | Where-Object { $_.SourceIdentifier -eq $identifier })
    if ($queued.Count -gt 512) { throw 'Process-start diagnostic queue exceeded its bound.' }
    $starts = @($queued | ForEach-Object {
        $event = $_.SourceEventArgs.NewEvent
        if (!$event.ProcessName -or $event.ProcessName.Length -gt 260 -or $event.ProcessName -match '[\\/\x00-\x1f]') {
            throw 'Unsafe process-start executable metadata.'
        }
        @{ pid = [int] $event.ProcessID; parentPid = [int] $event.ParentProcessID; exe = $event.ProcessName;
            session = [int] $event.SessionID; createdAt = [DateTime]::FromFileTimeUtc([long] $event.TIME_CREATED).ToString('o') }
    })
    $parentIds = @($starts | ForEach-Object { $_.parentPid } | Select-Object -Unique)
    $existingParents = @($baseline | Where-Object { $_.ProcessId -in $parentIds } | ForEach-Object {
        if (!$_.Name -or $_.Name.Length -gt 260 -or $_.Name -match '[\\/\x00-\x1f]') {
            throw 'Unsafe existing parent executable metadata.'
        }
        @{ pid = [int] $_.ProcessId; parentPid = [int] $_.ParentProcessId; exe = $_.Name;
            createdAt = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } }
    })
    return @{ starts = $starts; existingParents = $existingParents; capturedAt = [DateTime]::UtcNow.ToString('o') }
}

if ($Mode -eq 'restore') {
    $report = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json -AsHashtable
    if ($report.runId -ne $env:GITHUB_RUN_ID -or $report.attempt -ne $env:GITHUB_RUN_ATTEMPT -or
        $report.selectedGuid -ne $consoleHost -or !$report.stateSaved) {
        throw 'Terminal snapshot does not belong to this run and supported selection.'
    }
    $current = Read-Selection
    foreach ($name in $names) {
        $value = $current.values[$name].value
        if ($value -ne $consoleHost -and $value -ne $report.original.values[$name].value) {
            $report.status = 'restore-refused-external-change'
            $message = 'Terminal choice changed outside this preparation; refusing to overwrite it.'
            try { Save-Report }
            catch { throw "$message Report persistence also failed: $($_.Exception.Message)" }
            throw $message
        }
    }
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($registryPath)
    try {
        foreach ($name in $names) {
            $original = $report.original.values[$name]
            if ($original.exists) { $key.SetValue($name, $original.value, [Microsoft.Win32.RegistryValueKind]::String) }
            else { $key.DeleteValue($name, $false) }
        }
        $empty = $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0
    } finally { $key.Dispose() }
    if (!$report.original.keyExisted -and $empty) {
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($registryPath, $false)
    }
    $report.restored = Read-Selection
    if ($report.restored.keyExisted -ne $report.original.keyExisted) {
        $report.status = 'restore-preserved-unrelated-key-data'
        $message = 'Original key presence could not be restored without deleting unrelated registry data.'
        try { Save-Report }
        catch { throw "$message Report persistence also failed: $($_.Exception.Message)" }
        throw $message
    }
    foreach ($name in $names) {
        if ($report.restored.values[$name].exists -ne $report.original.values[$name].exists -or
            $report.restored.values[$name].value -cne $report.original.values[$name].value -or
            $report.restored.values[$name].kind -ne $report.original.values[$name].kind) {
            throw 'Original terminal choice was not restored exactly.'
        }
    }
    $report.restoredAt = [DateTime]::UtcNow.ToString('o')
    $report.restoreVerified = $true
    $report.restoreDiagnosticError = $null
    try { $report.afterRegistryRestore = Process-Snapshot }
    catch {
        $report.afterRegistryRestore = $null
        $report.restoreDiagnosticError = $_.Exception.Message
    }
    $report.newTerminalActorsAtRestore = if ($report.afterRegistryRestore) {
        @($report.afterRegistryRestore.chains | Where-Object {
            $_.exe -in @('WindowsTerminal.exe', 'wt.exe', 'wsl.exe') -and
            $_.rootPid -notin @($report.before.chains | ForEach-Object { $_.rootPid }) -and
            (!$_.chain[0].createdAt -or [DateTime] $_.chain[0].createdAt -le [DateTime] $report.restoredAt)
        })
    } else { $null }
    $report.status = if ($report.restoreDiagnosticError) { 'restored-with-diagnostic-error' } else { 'restored' }
    $persistError = $null
    try { Save-Report } catch { $persistError = $_.Exception.Message }
    if ($report.restoreDiagnosticError -or $persistError) {
        $failures = @()
        if ($report.restoreDiagnosticError) { $failures += "diagnostics failed: $($report.restoreDiagnosticError)" }
        if ($persistError) { $failures += "report persistence failed: $persistError" }
        throw "Original terminal choice restored; $($failures -join '; ')"
    }
    if ($report.newTerminalActorsAtRestore.Count) {
        throw 'New Terminal/WSL actors appeared while Console Host was selected; original choice has been restored.'
    }
    Write-Output 'Original HKCU terminal choice restored and verified.'
    exit 0
}

if (Test-Path -LiteralPath $file) { throw 'Refusing to overwrite an existing terminal-choice snapshot.' }
$report = @{ runId = $env:GITHUB_RUN_ID; attempt = $env:GITHUB_RUN_ATTEMPT; scope = 'current isolated runner HKCU only';
    support = $support; selectedGuid = $consoleHost; selectedHost = 'Windows Console Host';
    startedAt = [DateTime]::UtcNow.ToString('o'); original = (Read-Selection);
    stateSaved = $true; status = 'preparing'; restoreVerified = $false }
Save-Report
if (!$env:GITHUB_OUTPUT) { throw 'Workflow output channel unavailable; terminal choice was not changed.' }
Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value 'state_saved=true'
$probe = $null
$prepareFailure = $null
$watchId = $null
$baselineInventory = @()
try {
    $report.before = Process-Snapshot
    $baselineInventory = @($script:lastProcessInventory)
    Save-Report
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($registryPath)
    try {
        foreach ($name in $names) { $key.SetValue($name, $consoleHost, [Microsoft.Win32.RegistryValueKind]::String) }
    } finally { $key.Dispose() }
    $report.applied = Read-Selection
    foreach ($name in $names) {
        if ($report.applied.values[$name].value -ne $consoleHost) { throw 'Supported Console Host choice was not applied.' }
    }
    $report.appliedAt = [DateTime]::UtcNow.ToString('o')
    Save-Report
    if ($FailPrepare) { throw 'Injected prepare failure.' }
    $existingWsl = @($report.before.chains | Where-Object { $_.exe -eq 'wsl.exe' } | ForEach-Object { $_.rootPid })
    $deadline = [DateTime]::UtcNow.AddSeconds(65)
    do {
        $remaining = @($existingWsl | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        if (!$remaining.Count) { break }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($remaining.Count) { throw 'Pre-existing unowned WSL clients did not exit; no UI or broad process cleanup is permitted.' }
    $report.preExistingWslQuietAt = [DateTime]::UtcNow.ToString('o')
    $identifier = "overlay-process-starts-$([guid]::NewGuid())"
    Register-CimIndicationEvent -Namespace root\cimv2 -Query 'SELECT * FROM Win32_ProcessStartTrace' `
        -SourceIdentifier $identifier | Out-Null
    $watchId = $identifier
    $report.processStartWatchRegisteredAt = [DateTime]::UtcNow.ToString('o')
    $probeFile = Join-Path $directory "$([IO.Path]::GetFileNameWithoutExtension($ReportName))-console-probe.json"
    $probeScript = @'
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class OwnedConsoleProbe {
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    public static string Read() {
        uint owner;
        IntPtr window = GetConsoleWindow();
        GetWindowThreadProcessId(window, out owner);
        if (window == IntPtr.Zero || owner == 0) throw new InvalidOperationException("No owned console host.");
        string host = Process.GetProcessById((int)owner).ProcessName;
        return "{\"clientPid\":" + Process.GetCurrentProcess().Id + ",\"consoleWindowPid\":" + owner +
            ",\"consoleWindowProcess\":\"" + host + "\"}";
    }
}
"@
'@
    $probeScript += "`n[OwnedConsoleProbe]::Read() | Set-Content -LiteralPath '$($probeFile.Replace("'", "''"))' -Encoding utf8`nStart-Sleep -Seconds 5"
    $probeStarted = [DateTime]::UtcNow.ToString('o')
    $probe = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') `
        -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand',
            [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probeScript))) -WindowStyle Normal -PassThru
    $report.probeProcess = @{ pid = $probe.Id; role = 'owned-console-probe'; startedAt = $probeStarted;
        scope = 'new console before app or OS mouse input'; windowStyle = 'Normal'; launchAPI = 'Start-Process' }
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while (!(Test-Path -LiteralPath $probeFile) -and !$probe.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 100
    }
    if (!(Test-Path -LiteralPath $probeFile)) { throw 'Owned console host probe did not produce a readiness receipt.' }
    $report.probe = Get-Content -Raw -LiteralPath $probeFile | ConvertFrom-Json -AsHashtable
    $report.duringProbe = Process-Snapshot
    $hosts = @($report.duringProbe.chains | Where-Object {
        $_.exe -eq 'conhost.exe' -and $_.chain[0].parentPid -eq $probe.Id
    })
    if ($report.probe.clientPid -ne $probe.Id -or $hosts.Count -ne 1) {
        throw 'Owned client was not correlated with exactly one inbox console host.'
    }
    $report.probe.consolePid = $hosts[0].rootPid
    $report.probe.consoleHost = $hosts[0].exe
    $report.probe.hostVerification = 'live Win32_Process host/client parent identity'
    $report.probeProcess.parentPid = $hosts[0].chain[1].parentPid
    $report.probeProcess.createdAt = $hosts[0].chain[1].createdAt
    if (!$probe.WaitForExit(5000) -or $probe.ExitCode -ne 0) { throw 'Owned console probe did not exit cleanly.' }
    $report.probeProcess.exitedAt = [DateTime]::UtcNow.ToString('o')
    $deadline = [DateTime]::UtcNow.AddSeconds(2)
    do {
        $consoleProcess = Get-Process -Id $report.probe.consolePid -ErrorAction SilentlyContinue
        if (!$consoleProcess) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($consoleProcess) { throw 'Owned probe console host did not exit after its client.' }
    $report.probeProcess.consoleObservedAbsentAt = [DateTime]::UtcNow.ToString('o')
    $report.afterProbe = Process-Snapshot
    $report.processStarts = Read-ProcessStarts $watchId $baselineInventory
    if (!@($report.processStarts.starts | Where-Object { $_.pid -eq $probe.Id }).Count) {
        throw 'Owned console probe process-start receipt missing.'
    }
    $originalActors = @($report.before.chains | ForEach-Object { $_.rootPid })
    $newDelegated = @(@($report.duringProbe.chains) + @($report.afterProbe.chains) | Where-Object {
        $_.exe -in @('WindowsTerminal.exe', 'wt.exe', 'wsl.exe', 'OpenConsole.exe') -and $_.rootPid -notin $originalActors
    })
    if ($newDelegated.Count) { throw 'Unexpected new Terminal/WSL actor appeared despite Console Host selection.' }
    $report.status = 'prepared'
    $report.preparedAt = [DateTime]::UtcNow.ToString('o')
    Save-Report
    Write-Output 'Supported HKCU Console Host selection and owned new-console host verified; no WSL update or broad cleanup.'
} catch {
    $prepareFailure = $_.Exception.Message
    $report.status = 'failed'
    $report.error = $prepareFailure
    try { Save-Report }
    catch { $prepareFailure += "; preparation report persistence failed: $($_.Exception.Message)" }
    throw $prepareFailure
} finally {
    $cleanupErrors = @()
    if ($probe) {
        try {
            if (!$probe.HasExited) {
                Stop-Process -Id $probe.Id -Force
                if (!$probe.WaitForExit(2000)) { throw 'Owned console probe could not be reaped.' }
            }
            $probe.Dispose()
        } catch { $cleanupErrors += "Owned console probe cleanup failed: $($_.Exception.Message)" }
    }
    if ($watchId) {
        try { $report.processStarts = Read-ProcessStarts $watchId $baselineInventory }
        catch { $cleanupErrors += "Process-start diagnostics failed: $($_.Exception.Message)" }
        try {
            Unregister-Event -SourceIdentifier $watchId -ErrorAction Stop
            Get-Event | Where-Object { $_.SourceIdentifier -eq $watchId } | Remove-Event -ErrorAction Stop
            $report.processStartWatchClosedAt = [DateTime]::UtcNow.ToString('o')
        } catch { $cleanupErrors += "Owned process-start subscription cleanup failed: $($_.Exception.Message)" }
        try { Save-Report }
        catch { $cleanupErrors += "Process-start receipt persistence failed: $($_.Exception.Message)" }
    }
    if ($cleanupErrors.Count) {
        if ($prepareFailure) { $cleanupErrors = @($prepareFailure) + $cleanupErrors }
        throw ($cleanupErrors -join '; ')
    }
}
