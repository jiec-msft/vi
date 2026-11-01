param(
    [Parameter(Mandatory = $true)][long] $Window,
    [Parameter(Mandatory = $true)][int] $Parent,
    [string] $DiagnosticsDirectory = '',
    [string] $DiagnosticRun = '',
    [int] $DiagnosticGeneration = 0,
    [int] $DiagnosticParent = 0
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-diagnostics.ps1')
[ViNativeDiagnostics]::Configure($DiagnosticsDirectory, $DiagnosticRun, 'pointer', $DiagnosticGeneration, $DiagnosticParent, $true)
[ViNativeDiagnostics]::Record('compile', 'begin', 0)
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class OverlayMouse {
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [DllImport("user32.dll", SetLastError=true)] static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    bool initialized, previous, tracking, suspended;
    POINT last;
    long lastHeartbeat;

    public string Suspend() {
        bool cancel = tracking;
        initialized = previous = tracking = false;
        if (suspended) return null;
        suspended = true;
        return (cancel ? "{\"type\":\"cancel\"}\n" : "") + "{\"type\":\"suspended\"}";
    }

    public string SampleUnavailable(long elapsedMilliseconds) {
        string transition = Suspend();
        if (transition != null) {
            lastHeartbeat = elapsedMilliseconds;
            return transition;
        }
        if (elapsedMilliseconds - lastHeartbeat < 1000) return null;
        lastHeartbeat = elapsedMilliseconds;
        return "{\"type\":\"heartbeat\"}";
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
        Action<string,string,int> notice = null;
        Action sample = null;
        foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies()) {
            Type type = assembly.GetType("ViNativeDiagnostics");
            if (type != null) {
                notice = (Action<string,string,int>)Delegate.CreateDelegate(typeof(Action<string,string,int>), type.GetMethod("Record"));
                sample = (Action)Delegate.CreateDelegate(typeof(Action), type.GetMethod("Sample"));
                break;
            }
        }
        IntPtr window = new IntPtr(handle);
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        var owner = Process.GetProcessById(parent);
        var mouse = new OverlayMouse();
        var clock = Stopwatch.StartNew();
        while (!owner.HasExited && IsWindow(window)) {
            POINT point;
            string value;
            if (!GetCursorPos(out point)) {
                int error = Marshal.GetLastWin32Error();
                value = mouse.SampleUnavailable(clock.ElapsedMilliseconds);
                if (value != null && value.IndexOf("suspended", StringComparison.Ordinal) >= 0 && notice != null)
                    notice("GetCursorPos", "suspended", error);
            }
            else {
                bool inside = IsWindowVisible(window) && GetAncestor(WindowFromPoint(point), 2) == window;
                value = mouse.Sample((GetAsyncKeyState(1) & 0x8000) != 0, inside, point.X, point.Y);
                if (value == "{\"type\":\"ready\"}" && notice != null) notice("GetCursorPos", "ready", 0);
            }
            if (value != null) Console.WriteLine(value);
            if (sample != null) sample();
            Thread.Sleep(16);
        }
    }
}
'@
[ViNativeDiagnostics]::Record('compile', 'end', 0)
try { [OverlayMouse]::Run($Window, $Parent); [ViNativeDiagnostics]::Record('native-exit', 'exit', 0) }
catch { [Console]::Error.WriteLine('Floating window pointer observer failed.'); exit 1 }
finally { [ViNativeDiagnostics]::Close() }
