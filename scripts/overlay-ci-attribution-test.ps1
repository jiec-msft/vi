. (Join-Path $PSScriptRoot 'overlay-ci-attribution.ps1')
$ErrorActionPreference = 'Stop'
function Record($pidValue, $parent, $birth, $sessionValue, $baseline = $false) {
    return @{ pid = $pidValue; parentPid = $parent; createdAt = $birth; session = $sessionValue;
        exe = 'wsl.exe'; baseline = $baseline; observedAt = '2026-01-01T00:00:30Z' }
}
$old = '2026-01-01T00:00:00Z'
$start = '2026-01-01T00:00:10Z'
$later = '2026-01-01T00:00:20Z'
$seed = Record 1 99 $start 0
$owned = Record 2 1 $later 0
$external = Record 3 90 $later 0
$daemon = Record 90 0 $old 0 $true
$expired = @{} + $seed + @{ exitedAt = '2026-01-01T00:00:15Z' }
$unobserved = @{} + $seed
$unobserved.observedAt = '2026-01-01T00:00:15Z'
$wrongEvent = @{} + $owned
$wrongEvent.exe = 'pwsh.exe'
$earlyEvent = @{} + $owned
$earlyEvent.observedAt = '2026-01-01T00:00:15Z'
$endedAfterChild = @{} + $seed + @{ exitedAt = '2026-01-01T00:00:25Z' }
$tests = @(
    @{ name = 'owned-same-name-session-zero'; actor = $owned; records = @($seed, $owned); seeds = @($seed); expected = 'owned' },
    @{ name = 'unowned-pre-existing-parent-same-name'; actor = $external; records = @($external, $daemon); seeds = @($seed); expected = 'unowned' },
    @{ name = 'missing-parent'; actor = $external; records = @($external); seeds = @($seed); expected = 'unknown' },
    @{ name = 'PID-reuse'; actor = $owned; records = @($seed, $owned, (Record 1 99 $old 0)); seeds = @($seed); expected = 'unknown' },
    @{ name = 'session-mismatch'; actor = (Record 2 1 $later 2); records = @($seed, (Record 2 1 $later 2)); seeds = @($seed); expected = 'unknown' },
    @{ name = 'indirect-owned'; actor = (Record 4 2 $later 0); records = @($seed, $owned, (Record 4 2 $later 0)); seeds = @($seed); expected = 'owned' },
    @{ name = 'duplicate-start-events'; actor = $owned; records = @($seed, $owned); seeds = @($seed); events = @($owned, $owned); expected = 'unknown' },
    @{ name = 'missing-birth'; actor = (Record 2 1 $null 0); records = @($seed, (Record 2 1 $null 0)); seeds = @($seed); expected = 'unknown' },
    @{ name = 'missing-session'; actor = (Record 2 1 $later $null); records = @($seed, (Record 2 1 $later $null)); seeds = @($seed); expected = 'unknown' },
    @{ name = 'expired-parent'; actor = $owned; records = @($expired, $owned); seeds = @($expired); expected = 'unknown' },
    @{ name = 'unverified-parent-existence'; actor = $owned; records = @($unobserved, $owned); seeds = @($unobserved); expected = 'unknown' },
    @{ name = 'event-CIM-parent-conflict'; actor = $owned; records = @($seed, $owned); seeds = @($seed);
        events = @((Record 2 99 $null 0)); expected = 'unknown' },
    @{ name = 'event-only-parent-does-not-supply-birth'; actor = (Record 4 2 $later 0); records = @($seed, (Record 4 2 $later 0));
        seeds = @($seed); events = @((Record 2 1 $null 0)); expected = 'unknown' },
    @{ name = 'repeated-consistent-CIM-not-independent-proof'; actor = $owned; records = @($seed, $seed, $owned);
        seeds = @($seed); expected = 'owned' },
    @{ name = 'event-exe-conflict'; actor = $owned; records = @($seed, $owned);
        seeds = @($seed); events = @($wrongEvent); expected = 'unknown' },
    @{ name = 'event-before-CIM-birth'; actor = $owned; records = @($seed, $owned);
        seeds = @($seed); events = @($earlyEvent); expected = 'unknown' },
    @{ name = 'late-event-after-parent-exit-is-not-creation-time'; actor = $owned; records = @($endedAfterChild, $owned);
        seeds = @($endedAfterChild); events = @($owned); expected = 'owned' }
)
$results = foreach ($test in $tests) {
    $result = Get-ActorAttribution $test.actor $test.records $test.seeds @($test.events) $start
    if ($result.attribution -ne $test.expected) { throw "Attribution fixture failed: $($test.name)" }
    $blocked = $false
    try { Assert-OwnedActorBoundary @($result) }
    catch {
        if ($_.Exception.Message -ne 'Owned console or fixture delegated to an unexpected terminal.') { throw }
        $blocked = $true
    }
    if ($blocked -ne ($test.expected -eq 'owned')) { throw "Owned-delegation guard fixture failed: $($test.name)" }
    @{ name = $test.name; expected = $test.expected; actual = $result.attribution; reason = $result.reason; delegationBlocked = $blocked }
}
$directory = Join-Path $env:GITHUB_WORKSPACE 'artifacts-ci\overlay-recovery'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
@{ status = 'passed'; cases = @($results) } | ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath (Join-Path $directory 'attribution-tests.json') -Encoding utf8
