$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Desktop preparation is restricted to an isolated Windows CI runner.'
}
New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\OOBE' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\OOBE' `
    -Name DisablePrivacyExperience -PropertyType DWord -Value 1 -Force | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CiAppIdentity {
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr process);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetApplicationUserModelId(
        IntPtr process, ref uint length, StringBuilder name);
    public static string Read(int id) {
        IntPtr process = OpenProcess(0x1000, false, id);
        if (process == IntPtr.Zero) return "";
        try {
            uint length = 0;
            if (GetApplicationUserModelId(process, ref length, null) != 122) return "";
            var name = new StringBuilder((int)length);
            return GetApplicationUserModelId(process, ref length, name) == 0 ? name.ToString() : "";
        } finally { CloseHandle(process); }
    }
}
'@
foreach ($process in Get-Process) {
    $onboarding = $process.ProcessName -in @('UserOOBEBroker', 'CloudExperienceHost', 'CloudExperienceHostBroker')
    if ($process.ProcessName -eq 'WWAHost') {
        $onboarding = [CiAppIdentity]::Read($process.Id).StartsWith('Microsoft.Windows.CloudExperienceHost_')
    }
    if ($onboarding) {
        Write-Output "Closing CI onboarding process $($process.Id) ($($process.ProcessName))."
        Stop-Process -Id $process.Id -Force
    }
}
