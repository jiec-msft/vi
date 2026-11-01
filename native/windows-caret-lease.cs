using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class ViCaretLease {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Gui {
        public int Size, Flags;
        public IntPtr Active, Focus, Capture, Menu, Move, Caret;
        public Rect Bounds;
    }
    delegate void Event(IntPtr hook, uint evt, IntPtr window, int obj, int child, uint thread, uint time);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref Gui info);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, Event callback, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    static readonly Event callback = Changed;
    static IntPtr foregroundHook, focusHook, destroyHook, window, focus;
    static uint pid;
    static long generation;
    static bool active, broken;
    static void Changed(IntPtr hook, uint evt, IntPtr changed, int obj, int child, uint thread, uint time) {
        if (active && (evt == 3 && changed != window || evt == 0x8005 && changed != focus ||
            evt == 0x8001 && (changed == window || changed == focus))) Break();
    }
    static void Break() { broken = true; RemoveHooks(); }
    static void RemoveHooks() {
        if (foregroundHook != IntPtr.Zero) { UnhookWinEvent(foregroundHook); foregroundHook = IntPtr.Zero; }
        if (focusHook != IntPtr.Zero) { UnhookWinEvent(focusHook); focusHook = IntPtr.Zero; }
        if (destroyHook != IntPtr.Zero) { UnhookWinEvent(destroyHook); destroyHook = IntPtr.Zero; }
    }
    static bool Current() {
        uint owner;
        uint thread = GetWindowThreadProcessId(window, out owner);
        var info = new Gui { Size = Marshal.SizeOf(typeof(Gui)) };
        return owner == pid && thread != 0 && GetForegroundWindow() == window &&
            GetGUIThreadInfo(thread, ref info) && info.Focus == focus;
    }
    public static long Begin(long targetWindow, long targetFocus, uint targetPid) {
        RemoveHooks();
        window = new IntPtr(targetWindow); focus = new IntPtr(targetFocus); pid = targetPid;
        generation++; active = true; broken = false;
        foregroundHook = SetWinEventHook(3, 3, IntPtr.Zero, callback, 0, 0, 0);
        focusHook = SetWinEventHook(0x8005, 0x8005, IntPtr.Zero, callback, pid, 0, 0);
        destroyHook = SetWinEventHook(0x8001, 0x8001, IntPtr.Zero, callback, pid, 0, 0);
        if (foregroundHook == IntPtr.Zero || focusHook == IntPtr.Zero || destroyHook == IntPtr.Zero || !Current()) Break();
        return generation;
    }
    public static bool Valid(long id) {
        Application.DoEvents();
        if (!active || id != generation || broken) return false;
        if (!Current()) Break();
        return !broken;
    }
    public static void Release(long id) {
        if (id != generation) return;
        active = false;
        RemoveHooks();
    }
}
