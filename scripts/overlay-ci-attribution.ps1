if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Actor attribution is restricted to an isolated GitHub-hosted Windows runner.'
}
function Identity-Key($record) {
    if (!$record -or !$record.ContainsKey('pid') -or !$record.ContainsKey('session') -or
        $null -eq $record.session -or !$record.createdAt) { return $null }
    $birth = [DateTime]::MinValue
    $sessionValue = 0
    $processId = 0
    if (![DateTime]::TryParse($record.createdAt, [ref] $birth) -or
        ![int]::TryParse([string] $record.session, [ref] $sessionValue) -or $sessionValue -lt 0 -or
        ![int]::TryParse([string] $record.pid, [ref] $processId) -or $processId -le 0) { return $null }
    return "${processId}:$($birth.ToUniversalTime().Ticks):$sessionValue"
}
function Get-ActorAttribution($actor, $records, $seeds, $events, $controlStartedAt) {
    $path = @()
    $current = $actor
    $visited = @()
    for ($depth = 0; $depth -lt 8; $depth++) {
        $key = Identity-Key $current
        if (!$key -or $current.missing) {
            return @{ attribution = 'unknown'; reason = 'missing-CIM-birth-or-session'; actor = $actor; path = $path }
        }
        if ($current.pid -in $visited) {
            return @{ attribution = 'unknown'; reason = 'cycle-or-PID-reuse'; actor = $actor; path = $path }
        }
        $visited += $current.pid
        $samePid = @($records | Where-Object { $_.pid -eq $current.pid })
        $keys = @($samePid | ForEach-Object { Identity-Key $_ } | Select-Object -Unique)
        $birthEvents = @($events | Where-Object { $_.pid -eq $current.pid })
        if (@($samePid | Where-Object { !(Identity-Key $_) }).Count -or
            $keys.Count -ne 1 -or !$keys[0] -or $keys[0] -ne $key -or $birthEvents.Count -gt 1 -or
            @($samePid | Where-Object { $_.parentPid -ne $current.parentPid -or $_.exe -ne $current.exe }).Count) {
            return @{ attribution = 'unknown'; reason = 'conflicting-generation-or-observations'; actor = $actor; path = $path }
        }
        if ($birthEvents.Count -eq 1) {
            $eventTime = [DateTime]::MinValue
            if ($null -eq $birthEvents[0].session -or $birthEvents[0].session -ne $current.session -or
                $birthEvents[0].parentPid -ne $current.parentPid -or $birthEvents[0].exe -ne $current.exe -or
                !$birthEvents[0].observedAt -or ![DateTime]::TryParse($birthEvents[0].observedAt, [ref] $eventTime) -or
                $eventTime.ToUniversalTime() -lt ([DateTime] $current.createdAt).ToUniversalTime()) {
                return @{ attribution = 'unknown'; reason = 'event-CIM-conflict'; actor = $actor; path = $path }
            }
        }
        $path += $current
        $owned = @($seeds | Where-Object { (Identity-Key $_) -eq $key })
        if ($owned.Count) {
            if ($owned[0].exitedAt -and [DateTime] $actor.createdAt -gt [DateTime] $owned[0].exitedAt) {
                return @{ attribution = 'unknown'; reason = 'ancestor-exited-before-child'; actor = $actor; path = $path }
            }
            return @{ attribution = 'owned'; reason = 'CIM-generation-owned-seed'; actor = $actor; path = $path }
        }
        $earliestSeed = @($seeds | Where-Object { Identity-Key $_ } | Sort-Object { [DateTime] $_.createdAt } | Select-Object -First 1)
        if ($current.baseline -and $earliestSeed.Count -and
            [DateTime] $current.createdAt -lt [DateTime] $earliestSeed[0].createdAt -and
            [DateTime] $current.createdAt -lt [DateTime] $controlStartedAt) {
            return @{ attribution = 'unowned'; reason = 'observed-pre-existing-parent'; actor = $actor; path = $path }
        }
        $parents = @($records | Where-Object { $_.pid -eq $current.parentPid })
        if (!$parents.Count) {
            return @{ attribution = 'unknown'; reason = 'missing-parent-or-indirect-association'; actor = $actor; path = $path }
        }
        $parent = @{} + @($parents | Sort-Object observedAt -Descending)[0]
        $parent.baseline = [bool] @($parents | Where-Object {
            $_.baseline -and (Identity-Key $_) -eq (Identity-Key $parent)
        }).Count
        if (!(Identity-Key $parent) -or $parent.session -ne $current.session -or
            [DateTime] $parent.createdAt -gt [DateTime] $current.createdAt -or
            ($parent.exitedAt -and [DateTime] $parent.exitedAt -lt [DateTime] $current.createdAt) -or
            (!$parent.exitedAt -and (!$parent.observedAt -or
                [DateTime] $parent.observedAt -lt [DateTime] $current.createdAt))) {
            return @{ attribution = 'unknown'; reason = 'invalid-parent-generation-or-lifetime'; actor = $actor; path = $path }
        }
        $current = $parent
    }
    return @{ attribution = 'unknown'; reason = 'bounded-parent-depth'; actor = $actor; path = $path }
}
function Get-ReportActorAttributions($report, $snapshot) {
    $records = @()
    foreach ($name in @('before', 'duringProbe', 'afterProbe', 'afterRegistryRestore')) {
        if ($report[$name]) {
            foreach ($chain in $report[$name].chains) {
                foreach ($record in $chain.chain) {
                    $copy = @{} + $record
                    $copy.observedAt = $report[$name].at
                    if ($name -eq 'before') { $copy.baseline = $true }
                    $records += $copy
                }
            }
        }
    }
    foreach ($chain in $snapshot.chains) {
        foreach ($record in $chain.chain) { $records += (@{} + $record + @{ observedAt = $snapshot.at }) }
    }
    foreach ($record in @($report.processStarts.existingParents)) {
        if ($record) { $records += (@{} + $record + @{ baseline = $true }) }
    }
    $seeds = @($report.ownedSeeds)
    $events = @($report.processStarts.starts)
    $results = @()
    foreach ($chain in $snapshot.chains) {
        if ($chain.exe -notin @('WindowsTerminal.exe', 'wt.exe', 'wsl.exe', 'OpenConsole.exe')) { continue }
        $results += Get-ActorAttribution $chain.chain[0] $records $seeds $events $report.startedAt
    }
    return $results
}
function Assert-OwnedActorBoundary($attributions) {
    if (@($attributions | Where-Object { $_.attribution -eq 'owned' }).Count) {
        throw 'Owned console or fixture delegated to an unexpected terminal.'
    }
}
