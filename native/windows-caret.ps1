$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
& (Join-Path $PSScriptRoot 'windows-input.ps1') -Action load
Add-Type -AssemblyName System.Drawing, UIAutomationClient, UIAutomationTypes
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing,UIAutomationClient,UIAutomationTypes,WindowsBase `
    -Path (Join-Path $PSScriptRoot 'windows-caret.cs')
$marker = [ViCaret]::new()
try {
    while ($null -ne ($line = [VoiceCommands]::ReadNext())) {
        $request = $null
        try {
            if ($line.Length -gt 4096) { throw 'invalid-request' }
            $request = $line | ConvertFrom-Json
            $value = switch ($request.action) {
                'ready' { @{ ready = $true } }
                'bind' {
                    $marker.Bind([long]$request.target.window, [long]$request.target.focus, [uint32]$request.target.pid)
                    $script:caretTarget = $request.target
                    @{ bound = $true }
                }
                'sample' {
                    if ($null -ne $script:caretTarget -and [VoiceInput]::CompositionActive([long]$script:caretTarget.focus)) {
                        $marker.CompositionActive()
                    }
                    $marker.Sample() | ConvertFrom-Json
                }
                'show' {
                    @{ visible = $marker.Place([long]$request.token, [double]$request.rect.x,
                        [double]$request.rect.y, [double]$request.rect.width, [double]$request.rect.height) }
                }
                default { throw 'invalid-request' }
            }
            @{ id = $request.id; ok = $true; value = $value } | ConvertTo-Json -Compress -Depth 8
        } catch {
            @{ id = $request.id; ok = $false; code = 'caret-unavailable' } | ConvertTo-Json -Compress
        }
    }
} finally { $marker.Dispose() }
