param([long] $Window, [int] $Owner, [string] $Mode, [int] $X, [int] $Y)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'OS input is restricted to an isolated CI runner.' }
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
    [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    static void Button(uint flags) {
        var inputs = new[] { new INPUT { Mouse = new MOUSEINPUT { Flags = flags } } };
        if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) != 1)
            throw new InvalidOperationException("OS mouse injection denied.");
    }
    public static void Run(long handle, int owner, string mode, int x, int y) {
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        IntPtr window = new IntPtr(handle);
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        if (!IsWindow(window) || pid != owner) throw new InvalidOperationException("Owned window unavailable.");
        IntPtr foreground = GetForegroundWindow();
        if (mode != "up" && !SetCursorPos(x, y)) throw new InvalidOperationException("OS cursor unavailable.");
        Thread.Sleep(100);
        POINT point;
        if (!GetCursorPos(out point)) throw new InvalidOperationException("OS cursor unavailable.");
        if ((mode == "down" || mode == "click") && GetAncestor(WindowFromPoint(point), 2) != window)
            throw new InvalidOperationException("Mouse press is not over the owned window.");
        if (mode == "down") Button(2);
        else if (mode == "up") Button(4);
        else if (mode == "click") { Button(2); Thread.Sleep(100); Button(4); }
        else if (mode != "move" && mode != "hover") throw new InvalidOperationException("Invalid OS mouse action.");
        Thread.Sleep(100);
        if (GetForegroundWindow() != foreground) throw new InvalidOperationException("Overlay changed the OS foreground window.");
        Console.WriteLine("{\"input\":\"win32-SendInput/SetCursorPos\",\"ownerVerified\":true,\"foregroundUnchanged\":true}");
    }
}
'@
[OverlayCiMouse]::Run($Window, $Owner, $Mode, $X, $Y)
