param(
    [Parameter(Mandatory = $true)][string] $DesktopName,
    [Parameter(Mandatory = $true)][string] $Output,
    [ValidateSet('overlay-pointer', 'desktop-delivery')][string] $Role
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $DesktopName -notmatch '^vi-ci-[0-9]+-[0-9]+-[a-f0-9]{32}$') {
    throw 'Desktop attestation requires the current isolated owned CI desktop.'
}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class OverlayDesktopAttestor {
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint bytes, out uint needed);
    static string Name(IntPtr handle) {
        var value = new StringBuilder(512);
        uint needed;
        if (handle == IntPtr.Zero || !GetUserObjectInformation(handle, 2, value, 1024, out needed))
            throw new InvalidOperationException("Desktop identity unavailable.");
        return value.ToString();
    }
    public static string[] Read() {
        IntPtr input = OpenInputDesktop(0, false, 0x0141);
        try { return new[] { Name(GetProcessWindowStation()), Name(GetThreadDesktop(GetCurrentThreadId())), Name(input) }; }
        finally { if (input != IntPtr.Zero && !CloseDesktop(input)) throw new InvalidOperationException("Input desktop handle cleanup failed."); }
    }
}
'@
$names = [OverlayDesktopAttestor]::Read()
if ($names[0] -ne 'WinSta0' -or $names[1] -ne $DesktopName -or $names[2] -ne $DesktopName) {
    throw 'Owned PS5 helper did not inherit the active ordinary desktop.'
}
$receipt = @{ pid = $PID; thread = [OverlayDesktopAttestor]::GetCurrentThreadId(); role = $Role;
    station = $names[0]; threadDesktop = $names[1]; inputDesktop = $names[2]; actualInheritanceVerified = $true }
[IO.File]::WriteAllText((Join-Path $Output "desktop-$Role-$PID.json"),
    ($receipt | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
