$ErrorActionPreference = 'Stop'
function Write-ViStartup([ValidateSet('host-entry','inbox-ready','script-entry','diagnostics-ready','input-begin','input-ready','forms-ready','clipboard-ready','pointer-ready','protocol-ready')][string]$Stage) {
    $edition = if ($PSVersionTable.PSEdition -eq 'Desktop') { 'Desktop' } elseif ($PSVersionTable.PSEdition -eq 'Core') { 'Core' } else { 'unknown' }
    [Console]::Error.WriteLine("VI_STARTUP $Stage $PID $([IntPtr]::Size) $($PSVersionTable.PSVersion.Major) $edition")
}
Write-ViStartup 'host-entry'
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) {
    throw 'Native helpers require the Windows PowerShell inbox engine.'
}
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
foreach ($module in @('Microsoft.PowerShell.Management','Microsoft.PowerShell.Utility')) {
    Import-Module ([IO.Path]::Combine($env:PSModulePath, $module, "$module.psd1")) -ErrorAction Stop
}
$PSModuleAutoLoadingPreference = 'None'
Write-ViStartup 'inbox-ready'
