param(
    [Parameter(Mandatory = $true)][long] $Window,
    [Parameter(Mandatory = $true)][int] $Parent
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class OverlayMouse {
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    bool initialized, previous, tracking, suspended;
    POINT last;

    public string Suspend() {
        bool cancel = tracking;
        initialized = previous = tracking = false;
        if (suspended) return null;
        suspended = true;
        return (cancel ? "{\"type\":\"cancel\"}\n" : "") + "{\"type\":\"suspended\"}";
    }

    public string Sample(bool held, bool inside, int x, int y) {
        bool ready = !initialized;
        suspended = false;
        string kind = null;
        if (initialized) {
            if (held && !previous && inside) { tracking = true; kind = "down"; }
            else if (!held && tracking) { tracking = false; kind = "up"; }
            else if (held && tracking && (x != last.X || y != last.Y)) kind = "move";
        }
        initialized = true;
        previous = held;
        last = new POINT { X = x, Y = y };
        return ready ? "{\"type\":\"ready\"}"
            : kind == null ? null : "{\"type\":\"" + kind + "\",\"x\":" + x + ",\"y\":" + y + "}";
    }

    public static void Run(long handle, int parent) {
        IntPtr window = new IntPtr(handle);
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        var owner = Process.GetProcessById(parent);
        var mouse = new OverlayMouse();
        while (!owner.HasExited && IsWindow(window)) {
            POINT point;
            string value;
            if (!GetCursorPos(out point)) value = mouse.Suspend();
            else {
                bool inside = IsWindowVisible(window) && GetAncestor(WindowFromPoint(point), 2) == window;
                value = mouse.Sample((GetAsyncKeyState(1) & 0x8000) != 0, inside, point.X, point.Y);
            }
            if (value != null) Console.WriteLine(value);
            Thread.Sleep(16);
        }
    }
}
'@
try { [OverlayMouse]::Run($Window, $Parent) }
catch { [Console]::Error.WriteLine('Floating window pointer observer failed.'); exit 1 }
