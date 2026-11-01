$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:RUNNER_OS -cne 'Windows' -or $env:VI_EXPECTED_ARCH -cne 'x64') {
    throw 'Caret fixture requires the standard hosted Windows x64 runner.'
}
& (Join-Path $PSScriptRoot '..\native\windows-input.ps1') -Action load
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing `
    -Path (Join-Path $PSScriptRoot 'windows-caret-fixture.cs')
$fixture = [ViCaretFixture]::new()
try {
    while ($null -ne ($line = [VoiceCommands]::ReadNext())) {
        $request = $null
        try {
            if ($line.Length -gt 4096) { throw 'Invalid fixture request.' }
            $request = $line | ConvertFrom-Json
            $value = switch ($request.action) {
                'ready' { $fixture.Ready() }
                'click' { $fixture.Click([int]$request.field) }
                'shortcut' { $fixture.Shortcut([bool]$request.cancel) }
                'inspect' { $fixture.Inspect([uint32]$request.helper) }
                'move' { $fixture.Move() }
                'selection' { $fixture.Selection() }
                'pass-through' { $fixture.PassThrough([uint32]$request.helper) }
                default { throw 'Invalid fixture action.' }
            }
            @{ id = $request.id; ok = $true; value = $value } | ConvertTo-Json -Compress -Depth 8
        } catch {
            [Console]::Error.WriteLine($_.Exception.Message)
            @{ id = $request.id; ok = $false; code = 'fixture-failed' } | ConvertTo-Json -Compress
        }
    }
} finally { $fixture.Dispose() }
