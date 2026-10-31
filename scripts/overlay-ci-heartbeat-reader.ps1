[CmdletBinding()]
param([string] $Directory, [uint32] $ProducerPid)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:RUNNER_OS -cne 'Windows' -or -not $IsWindows -or $ProducerPid -eq 0 -or
    $env:GITHUB_RUN_ID -notmatch '^[1-9][0-9]*$' -or $env:GITHUB_RUN_ATTEMPT -notmatch '^[1-9][0-9]*$' -or
    [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString().ToLowerInvariant() -cne $env:VI_EXPECTED_ARCH) {
    throw 'Heartbeat reader verification requires native GitHub-hosted Windows CI.'
}
Add-Type -Path (Join-Path $PSScriptRoot 'windows-ci-desktop-native.cs')
$file = Join-Path $Directory 'heartbeat.json'
for ($iteration = 0; $iteration -lt 64; $iteration++) {
    $stream = [ViCiDesktop]::OpenHeartbeatSnapshot($file)
    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
    try {
        [Console]::WriteLine((@{ type = 'opened'; pid = $PID; iteration = $iteration } | ConvertTo-Json -Compress))
        if ([Console]::ReadLine() -cne 'replacement-complete') { throw 'Missing completed producer replacement.' }
        $before = $reader.ReadToEnd() | ConvertFrom-Json
        if ($before.pid -ne $ProducerPid -or $before.sequence -ne $iteration -or $before.time -le 0) {
            throw 'The stable open file handle did not retain its complete original JSON version.'
        }
    } finally { $reader.Dispose() }
    $stream = [ViCiDesktop]::OpenHeartbeatSnapshot($file)
    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
    try { $after = $reader.ReadToEnd() | ConvertFrom-Json }
    finally { $reader.Dispose() }
    $sampleAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($after.pid -ne $ProducerPid -or $after.sequence -ne ($iteration + 1) -or $after.time -le 0 -or
        -not [ViCiDesktop]::IsDefaultHeartbeatFresh($ProducerPid, $after.pid, $after.time, $sampleAt)) {
        throw 'The new open file handle lacks the fresh completed producer version.'
    }
    if (-not [ViCiDesktop]::IsDefaultHeartbeatFresh($ProducerPid, $ProducerPid, $after.time, ($after.time + 2999)) -or
        [ViCiDesktop]::IsDefaultHeartbeatFresh($ProducerPid, $ProducerPid, $after.time, ($after.time + 3000)) -or
        [ViCiDesktop]::IsDefaultHeartbeatFresh($ProducerPid, ($ProducerPid + 1), $after.time, $after.time)) {
        throw 'The actual heartbeat predicate lost its exact PID or 3000ms boundary.'
    }
    [Console]::WriteLine((@{ type = 'read'; pid = $PID; iteration = $iteration;
        old = $before; current = $after; sampleAt = $sampleAt } | ConvertTo-Json -Compress))
}
