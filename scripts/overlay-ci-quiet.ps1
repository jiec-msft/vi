$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'overlay-ci-attribution.ps1')
$directory = Join-Path $env:GITHUB_WORKSPACE 'artifacts-ci\overlay-recovery'
$file = Join-Path $directory 'quiet.json'
if (Test-Path -LiteralPath $file) { throw 'Normal GUI quiet may run only once in this job.' }
$started = [DateTime]::UtcNow
$deadline = $started.AddSeconds(65)
$report = @{ runId = $env:GITHUB_RUN_ID; attempt = $env:GITHUB_RUN_ATTEMPT; startedAt = $started.ToString('o');
    scope = 'observed new WSL client trees only; no daemon roots or VM-wide absence requirement';
    eligibleRoots = @(); observations = @(); unknowns = @(); status = 'waiting' }
$known = @{}
$quietFailure = $null
try {
    foreach ($source in Get-ChildItem -LiteralPath $directory -Filter '*.json') {
        $saved = Get-Content -Raw -LiteralPath $source.FullName | ConvertFrom-Json -AsHashtable
        if ($saved.runId -ne $env:GITHUB_RUN_ID -or $saved.attempt -ne $env:GITHUB_RUN_ATTEMPT) { continue }
        foreach ($entry in @($saved.actorAttributions) + @($saved.restoreActorAttributions)) {
            if (!$entry -or $entry.actor.exe -ne 'wsl.exe' -or $entry.attribution -eq 'owned') { continue }
            $actor = $entry.actor
            if ($actor.createdAt -and [DateTime] $actor.createdAt -lt [DateTime] $saved.startedAt) { continue }
            $key = Identity-Key $actor
            if ($known.ContainsKey([int] $actor.pid) -and (Identity-Key $known[[int] $actor.pid]) -ne $key) {
                throw 'Observed quiet roots contain conflicting PID generations.'
            }
            $known[[int] $actor.pid] = @{} + $actor
            $report.eligibleRoots += @{ source = $source.Name; attribution = $entry.attribution;
                reason = $entry.reason; identity = $actor }
        }
    }
    do {
        $remainingSeconds = [int] [Math]::Floor(($deadline - [DateTime]::UtcNow).TotalSeconds)
        if ($remainingSeconds -le 0) { throw 'Observed interference trees did not naturally quiet within the single 65-second deadline.' }
        $all = @(Get-CimInstance Win32_Process -OperationTimeoutSec ([Math]::Min(5, $remainingSeconds)) |
            Select-Object ProcessId, ParentProcessId, Name, CreationDate, SessionId)
        if ($all.Count -gt 1024) { throw 'Quiet process inventory exceeded its bound.' }
        $live = @{}
        foreach ($item in $all) {
            $live[[int] $item.ProcessId] = @{ pid = [int] $item.ProcessId; parentPid = [int] $item.ParentProcessId;
                exe = $item.Name; createdAt = if ($item.CreationDate) { $item.CreationDate.ToUniversalTime().ToString('o') } else { $null };
                session = if ($null -ne $item.SessionId) { [int] $item.SessionId } else { $null } }
        }
        for ($depth = 0; $depth -lt 8; $depth++) {
            $added = $false
            foreach ($child in @($live.Values)) {
                if ($known.ContainsKey($child.pid) -or !$known.ContainsKey($child.parentPid)) { continue }
                $parent = $known[$child.parentPid]
                if (!$child.exe -or $child.exe.Length -gt 260 -or $child.exe -match '[\\/\x00-\x1f]') {
                    throw 'Unsafe observed descendant executable metadata.'
                }
                if (!$live.ContainsKey($parent.pid) -or !(Identity-Key $parent) -or !(Identity-Key $child) -or
                    (Identity-Key $live[$parent.pid]) -ne (Identity-Key $parent) -or
                    $child.session -ne $parent.session -or [DateTime] $child.createdAt -lt [DateTime] $parent.createdAt) {
                    $report.unknowns += @{ reason = 'unverified-descendant-generation'; identity = $child }
                    throw 'Live descendant generation cannot be verified for the observed quiet tree.'
                }
                $known[$child.pid] = $child
                $added = $true
            }
            if (!$added) { break }
        }
        $remaining = @()
        foreach ($identity in @($known.Values)) {
            if (!$live.ContainsKey($identity.pid)) {
                $report.observations += @{ identity = $identity; reason = if (Identity-Key $identity) {
                    'observed-absent' } else { 'diagnostic-unknown-absent' }; at = [DateTime]::UtcNow.ToString('o') }
                continue
            }
            $current = $live[$identity.pid]
            if (!(Identity-Key $identity) -or !(Identity-Key $current) -or
                (Identity-Key $identity) -ne (Identity-Key $current) -or $current.exe -ne $identity.exe -or
                $current.parentPid -ne $identity.parentPid) {
                $report.unknowns += @{ reason = 'live-PID-generation-mismatch'; expected = $identity; actual = $current }
                throw 'Live observed interference identity cannot be verified; no PID reuse is treated as an exit.'
            }
            $remaining += $current
        }
        $report.observations += @{ at = [DateTime]::UtcNow.ToString('o'); remaining = $remaining;
            elapsedSeconds = ([DateTime]::UtcNow - $started).TotalSeconds }
        if (!$remaining.Count) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($remaining.Count -or [DateTime]::UtcNow -gt $deadline) { throw 'Observed interference trees failed the single quiet deadline.' }
    $report.status = 'quiet'
    $report.exitReason = 'observed trees naturally absent; unrelated and future actors are not claimed safe'
} catch {
    $report.status = 'failed'
    $report.exitReason = $_.Exception.Message
    $quietFailure = $_.Exception.Message
    throw
} finally {
    $report.finishedAt = [DateTime]::UtcNow.ToString('o')
    $report.elapsedSeconds = ([DateTime]::UtcNow - $started).TotalSeconds
    try { $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $file -Encoding utf8 }
    catch {
        $message = "Quiet receipt persistence failed: $($_.Exception.Message)"
        if ($quietFailure) { throw "$quietFailure; $message" }
        throw $message
    }
}
