param([long] $Window, [long] $Foreground, [int] $Owner, [string] $Mode, [int] $X, [int] $Y,
    [switch] $CleanupOwnedDown, [string] $OwnedDownReceipt)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'OS input is restricted to an isolated GitHub-hosted Windows runner.' }
if ($CleanupOwnedDown) {
    if ($Mode -ne 'up' -or !$OwnedDownReceipt -or $OwnedDownReceipt.Length -gt 2048) {
        throw 'Cleanup requires an owned native down receipt and permits only mouse-up.'
    }
    $receipt = $OwnedDownReceipt | ConvertFrom-Json
    if (!$receipt.ownedDownInjected -or !$receipt.ownerVerified -or !$receipt.leftHeldAfter -or $receipt.mode -ne 'down' -or
        $receipt.input -ne 'win32-SendInput/SetCursorPos' -or
        $receipt.ownedOwnerPid -ne $Owner -or $receipt.ownedWindow -ne [string] $Window) {
        throw 'Cleanup receipt does not confirm this owned window and injected mouse-down.'
    }
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class OverlayCiMouse {
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT {
        public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint Type; public MOUSEINPUT Mouse; }
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    static void Button(uint flags) {
        var inputs = new[] { new INPUT { Mouse = new MOUSEINPUT { Flags = flags } } };
        if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) != 1)
            throw new InvalidOperationException("OS mouse injection denied.");
    }
    static bool Held() { return (GetAsyncKeyState(1) & 0x8000) != 0; }
    public static void Run(long handle, long expected, int owner, string mode, int x, int y, bool cleanup) {
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        IntPtr window = new IntPtr(handle);
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        if (!IsWindow(window) || pid != owner) throw new InvalidOperationException("Owned window unavailable.");
        if (cleanup || mode == "status") {
            if (cleanup && mode != "up") throw new InvalidOperationException("Cleanup permits only mouse-up.");
            IntPtr before = GetForegroundWindow();
            bool heldBefore = Held();
            bool sent = cleanup && heldBefore;
            if (sent) Button(4);
            Thread.Sleep(100);
            bool heldAfter = Held();
            Console.WriteLine("{\"ownerVerified\":true,\"cleanupUpOnly\":" + (cleanup ? "true" : "false") +
                ",\"releaseSent\":" + (sent ? "true" : "false") + ",\"leftHeldBefore\":" + (heldBefore ? "true" : "false") +
                ",\"leftHeldAfter\":" + (heldAfter ? "true" : "false") + ",\"foregroundUnchanged\":" +
                (GetForegroundWindow() == before ? "true" : "false") + "}");
            if (cleanup && heldAfter) throw new InvalidOperationException("Owned injected mouse button remained held after cleanup.");
            return;
        }
        IntPtr main = new IntPtr(expected);
        uint mainPid;
        GetWindowThreadProcessId(main, out mainPid);
        if (!IsWindow(main) || mainPid != owner) throw new InvalidOperationException("Owned foreground baseline unavailable.");
        IntPtr foreground = GetForegroundWindow();
        uint foregroundPid;
        GetWindowThreadProcessId(foreground, out foregroundPid);
        bool noActivate = (GetWindowLongPtr(window, -20).ToInt64() & 0x08000000L) != 0;
        if (foreground != main || !noActivate) throw new InvalidOperationException("Owned foreground or no-activate baseline changed before input.");
        if ((mode == "down" || mode == "click") && Held())
            throw new InvalidOperationException("Existing held mouse input is not owned by this new press.");
        if (mode != "up" && !SetCursorPos(x, y)) throw new InvalidOperationException("OS cursor unavailable.");
        Thread.Sleep(100);
        POINT point;
        if (!GetCursorPos(out point)) throw new InvalidOperationException("OS cursor unavailable.");
        if ((mode == "down" || mode == "click") && GetAncestor(WindowFromPoint(point), 2) != window)
            throw new InvalidOperationException("Mouse press is not over the owned window.");
        bool downSent = mode == "down";
        if (downSent) Button(2);
        else if (mode == "up") Button(4);
        else if (mode == "click") { Button(2); Thread.Sleep(100); Button(4); }
        else if (mode != "move" && mode != "hover") throw new InvalidOperationException("Invalid OS mouse action.");
        Thread.Sleep(100);
        IntPtr after = GetForegroundWindow();
        uint afterPid;
        GetWindowThreadProcessId(after, out afterPid);
        bool unchanged = after == foreground;
        bool noActivateAfter = (GetWindowLongPtr(window, -20).ToInt64() & 0x08000000L) != 0;
        Console.WriteLine("{\"input\":\"win32-SendInput/SetCursorPos\",\"ownerVerified\":true,\"mode\":\"" + mode +
            "\",\"ownedDownInjected\":" + (downSent ? "true" : "false") + ",\"ownedOwnerPid\":" + owner +
            ",\"ownedWindow\":\"" + handle + "\",\"leftHeldAfter\":" + (Held() ? "true" : "false") + ",\"foregroundUnchanged\":" +
            (unchanged ? "true" : "false") + ",\"foregroundBefore\":{\"window\":\"" + foreground.ToInt64() +
            "\",\"pid\":" + foregroundPid + "},\"foregroundAfter\":{\"window\":\"" + after.ToInt64() +
            "\",\"pid\":" + afterPid + "},\"overlayNoActivate\":" + (noActivate ? "true" : "false") +
            ",\"overlayNoActivateAfter\":" + (noActivateAfter ? "true" : "false") + "}");
        if (!unchanged || after != main || !noActivateAfter)
            throw new InvalidOperationException("Owned foreground or no-activate baseline changed after input.");
    }
}
'@
[OverlayCiMouse]::Run($Window, $Foreground, $Owner, $Mode, $X, $Y, [bool] $CleanupOwnedDown)
