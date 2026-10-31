<#
.SYNOPSIS
Runs an owned fixture on an ordinary desktop in native GitHub-hosted Windows CI.
.DESCRIPTION
No elevation, secure desktops, background-process termination or local GUI use.
The child is launched with explicit WinSta0 desktop placement and an owned Job.
Nonzero child exits/timeouts remain nonzero after restore and cleanup.
Output contains sanitized ownership/restore receipts and child-owned evidence.
ChildScript is an Electron entry point accepting --desktop-probe-* arguments;
the default probe is unchanged. Finite P0 entries start the real Electron harness,
with metadata separated from product assertions and raw exits kept distinct.
#>
[CmdletBinding()]
param(
    [ValidateSet('normal', 'failure', 'timeout', 'input', 'policy')]
    [string] $Case = 'normal',
    [ValidateSet('probe', 'overlay', 'release-negative')]
    [string] $Entry = 'probe',
    [string] $Executable,
    [string] $ChildScript = (Join-Path $PSScriptRoot 'windows-ci-desktop-probe.cjs'),
    [string] $Output,
    [ValidateRange(1, 150)]
    [int] $TimeoutSeconds = 45,
    [string] $DesktopName,
    [uint32] $TargetProcessId,
    [int] $X,
    [int] $Y,
    [string] $WorkingDirectory = (Get-Location).Path,
    [switch] $HarnessTimeoutProbe,
    [switch] $HarnessEarlyRecovery
)

$ErrorActionPreference = 'Stop'
# Refuse before Add-Type, USER32, process creation, or input.
if ($env:GITHUB_ACTIONS -cne 'true' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:RUNNER_OS -cne 'Windows' -or -not $IsWindows -or
    $env:GITHUB_RUN_ID -notmatch '^[1-9][0-9]*$' -or
    $env:GITHUB_RUN_ATTEMPT -notmatch '^[1-9][0-9]*$' -or
    $env:VI_EXPECTED_ARCH -notin @('x64', 'arm64') -or
    [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString().ToLowerInvariant() -cne $env:VI_EXPECTED_ARCH) {
    throw 'Windows desktop probe requires a native GitHub-hosted Actions Windows job.'
}
Add-Type -Path (Join-Path $PSScriptRoot 'windows-ci-desktop-native.cs')

if ($Case -eq 'policy') {
    foreach ($sample in @(
        @('Default', 'Default', 'vi-ci-owned', 'unchanged'),
        @('vi-ci-owned', 'Default', 'vi-ci-owned', 'restore'),
        @('external', 'Default', 'vi-ci-owned', 'refuse'),
        @('Winlogon', 'Default', 'vi-ci-owned', 'refuse')
    )) {
        if ([ViCiDesktop]::RestoreDecision($sample[0], $sample[1], $sample[2]) -cne $sample[3]) {
            throw 'Restore policy assertion failed.'
        }
    }
    'Restore policy passed; no desktop or input APIs invoked.'
    exit 0
}
if (-not $Output) { throw 'An evidence output directory is required.' }
[IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($Output)) | Out-Null
if ($Case -eq 'input') {
    [ViCiDesktop]::Input($DesktopName, $TargetProcessId, $X, $Y, [IO.Path]::GetFullPath($Output))
    exit 0
}
if (-not $Executable -or -not (Test-Path -LiteralPath $Executable -PathType Leaf) -or
    -not (Test-Path -LiteralPath $ChildScript -PathType Leaf)) {
    throw 'Existing executable and child script paths are required.'
}
if ($Entry -ne 'probe') {
    if ($Case -ne 'normal') { throw 'Integration entry does not change original probe case semantics.' }
    $harness = Join-Path $PSScriptRoot $(if ($Entry -eq 'overlay') { 'overlay-recovery-ui.cjs' } else { 'overlay-release-negative.cjs' })
    if (-not (Test-Path -LiteralPath $harness -PathType Leaf) -or
        -not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) { throw 'Existing integration harness and repository cwd required.' }
    $result = [ViCiDesktop]::RunHarness([IO.Path]::GetFullPath($Executable),
        [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'windows-ci-desktop-probe.cjs')),
        [IO.Path]::GetFullPath($harness), [IO.Path]::GetFullPath($Output), $Entry,
        [IO.Path]::GetFullPath($WorkingDirectory), $TimeoutSeconds, [bool] $HarnessTimeoutProbe, [bool] $HarnessEarlyRecovery)
    exit $result
}
if ($HarnessTimeoutProbe -or $HarnessEarlyRecovery) { throw 'Harness witnesses are not original probe cases.' }
$result = [ViCiDesktop]::Run(
    [IO.Path]::GetFullPath($Executable), [IO.Path]::GetFullPath($ChildScript),
    [IO.Path]::GetFullPath($Output), $Case, $TimeoutSeconds
)
exit $result
