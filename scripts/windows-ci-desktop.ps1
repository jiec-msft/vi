[CmdletBinding()]
param(
    [ValidateSet('normal', 'failure', 'timeout', 'input', 'policy')]
    [string] $Case = 'normal',
    [string] $Executable,
    [string] $ChildScript = (Join-Path $PSScriptRoot 'windows-ci-desktop-probe.cjs'),
    [string] $Output,
    [ValidateRange(1, 90)]
    [int] $TimeoutSeconds = 45,
    [string] $DesktopName,
    [uint32] $TargetProcessId,
    [int] $X,
    [int] $Y
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
$result = [ViCiDesktop]::Run(
    [IO.Path]::GetFullPath($Executable), [IO.Path]::GetFullPath($ChildScript),
    [IO.Path]::GetFullPath($Output), $Case, $TimeoutSeconds
)
exit $result
