using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public sealed class ViCaretFixture : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct Gui {
        public int Size, Flags;
        public IntPtr Active, Focus, Capture, Menu, Move, Caret;
        public Rect Bounds;
    }
    [StructLayout(LayoutKind.Sequential)] struct Key { public ushort Code, Scan; public uint Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct Mouse { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Explicit)] struct Union { [FieldOffset(0)] public Key Key; [FieldOffset(0)] public Mouse Mouse; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public Union Data; }
    delegate bool WindowCallback(IntPtr window, IntPtr unused);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder name, int bytes, out int needed);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref Gui info);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr unused);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] input, int size);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateWindowEx(uint extended, string className, string text, uint style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr handle, StringBuilder name, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr first, IntPtr second);
    [DllImport("user32.dll")] static extern IntPtr GetFocus();
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);
    sealed class EditorEvents : NativeWindow {
        public int Clicks;
        public EditorEvents(IntPtr handle) { AssignHandle(handle); }
        protected override void WndProc(ref Message message) {
            if (message.Msg == 0x201) Clicks++;
            base.WndProc(ref message);
        }
    }
    readonly Form window;
    readonly IntPtr editor, other, password, oldDpi, font;
    readonly EditorEvents editorEvents;
    readonly uint pid = (uint)Process.GetCurrentProcess().Id;
    static object JsonRect(Rect r) { return new { x = r.Left, y = r.Top, width = r.Right - r.Left, height = r.Bottom - r.Top }; }
    void Desktop() {
        IntPtr input = OpenInputDesktop(0, false, 1);
        if (input == IntPtr.Zero) throw new InvalidOperationException("Default input desktop unavailable.");
        try {
            int needed;
            var name = new StringBuilder(128);
            if (!GetUserObjectInformation(input, 2, name, 256, out needed) || name.ToString() != "Default")
                throw new InvalidOperationException("Fixture requires the Default input desktop.");
        } finally { CloseDesktop(input); }
    }
    public ViCaretFixture() {
        oldDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (oldDpi == IntPtr.Zero) throw new InvalidOperationException("Fixture DPI unavailable.");
        Desktop();
        var work = Screen.PrimaryScreen.Bounds;
        window = new Form { Text = "Synthetic CI editor", StartPosition = FormStartPosition.Manual,
            Bounds = work, FormBorderStyle = FormBorderStyle.None, TopMost = true,
            BackColor = Color.FromArgb(22, 34, 52), Font = new Font("Segoe UI", 20),
            AutoScaleMode = AutoScaleMode.None };
        window.Controls.Add(new Label { Text = "SYNTHETIC CI EDITOR - no account or user audio",
            ForeColor = Color.White, Location = new System.Drawing.Point(30, 20), Size = new Size(780, 45) });
        font = window.Font.ToHfont();
        editor = Edit("Synthetic caret fixture", 95, 180, 0x1044);
        other = Edit("Second synthetic field", 320, 50, 0);
        password = Edit("", 420, 50, 0x20);
        editorEvents = new EditorEvents(editor);
        foreach (var point in new[] { new System.Drawing.Point(8, 8), new System.Drawing.Point(work.Width - 32, 8),
            new System.Drawing.Point(8, work.Height - 32), new System.Drawing.Point(work.Width - 32, work.Height - 32),
            new System.Drawing.Point(work.Width / 2, work.Height / 2) }) {
            var marker = new Panel { BackColor = Color.Magenta, Location = point, Size = new Size(24, 24) };
            window.Controls.Add(marker); marker.BringToFront();
        }
        window.Show();
    }
    public object Ready() {
        Desktop();
        var name = new StringBuilder(64);
        if (GetClassName(editor, name, 64) == 0 || name.ToString() != "Edit")
            throw new InvalidOperationException("Fixture is not a native Edit control.");
        return new { window = window.Handle.ToInt64().ToString(), focus = editor.ToInt64().ToString(),
            pid, desktop = "Default", dpi = "per-monitor-v2", owned = true, fieldClass = name.ToString(),
            screen = new { x = window.Left, y = window.Top, width = window.Width, height = window.Height } };
    }
    IntPtr Edit(string text, int y, int height, uint style) {
        IntPtr handle = CreateWindowEx(0x200, "Edit", text, 0x50010000 | style, 40, y, 650, height,
            window.Handle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (handle == IntPtr.Zero) throw new InvalidOperationException("Owned native Edit creation failed.");
        SendMessage(handle, 0x0030, font, new IntPtr(1));
        return handle;
    }
    void Send(Input[] events) {
        if (SendInput((uint)events.Length, events, Marshal.SizeOf(typeof(Input))) != events.Length)
            throw new InvalidOperationException("Owned native input failed.");
    }
    void MouseClick(int x, int y) {
        Desktop();
        var rect = window.Bounds;
        if (!rect.Contains(x, y)) throw new InvalidOperationException("Mouse outside the owned fixture.");
        if (!SetCursorPos(x, y)) throw new InvalidOperationException("Owned mouse movement failed.");
        Send(new[] { new Input { Data = new Union { Mouse = new Mouse { Flags = 2 } } },
            new Input { Data = new Union { Mouse = new Mouse { Flags = 4 } } } });
        Pump();
        if (GetForegroundWindow() != window.Handle) throw new InvalidOperationException("OS click did not focus the owned editor.");
    }
    static void Pump() { for (int i = 0; i < 12; i++) { Application.DoEvents(); Thread.Sleep(10); } }
    public object Click(int field) {
        IntPtr target = field == 0 ? editor : field == 1 ? other : password;
        Rect rect;
        if (!GetWindowRect(target, out rect)) throw new InvalidOperationException("Owned field geometry unavailable.");
        MouseClick(rect.Left + 80, rect.Top + 20);
        if (GetFocus() != target) throw new InvalidOperationException("Owned field did not receive focus.");
        return Inspect(0);
    }
    static Input KeyEvent(ushort key, bool up) {
        return new Input { Type = 1, Data = new Union { Key = new Key { Code = key, Flags = up ? 2u : 0u } } };
    }
    public object Shortcut(bool cancel) {
        Desktop();
        if (GetForegroundWindow() != window.Handle) throw new InvalidOperationException("Shortcut target is not the owned editor.");
        ushort function = cancel ? (ushort)0x79 : (ushort)0x78;
        Send(new[] { KeyEvent(0x11, false), KeyEvent(0x12, false), KeyEvent(0x10, false), KeyEvent(function, false) });
        Thread.Sleep(80);
        Send(new[] { KeyEvent(function, true), KeyEvent(0x10, true), KeyEvent(0x12, true), KeyEvent(0x11, true) });
        Pump();
        return new { sent = 8, foreground = GetForegroundWindow().ToInt64().ToString(), pid };
    }
    List<object> Windows(uint helper) {
        var result = new List<object>();
        if (helper == 0) return result;
        EnumWindows((handle, unused) => {
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            if (owner == helper && IsWindowVisible(handle)) {
                Rect rect;
                if (!GetWindowRect(handle, out rect)) throw new InvalidOperationException("Marker geometry unavailable.");
                result.Add(new { window = handle.ToInt64().ToString(), owner = GetWindow(handle, 4).ToInt64().ToString(),
                    pid = owner, styles = GetWindowLong(handle, -20), rect = JsonRect(rect) });
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
    public object Inspect(uint helper) {
        Desktop();
        uint foregroundPid;
        uint thread = GetWindowThreadProcessId(GetForegroundWindow(), out foregroundPid);
        var gui = new Gui { Size = Marshal.SizeOf(typeof(Gui)) };
        if (!GetGUIThreadInfo(thread, ref gui)) throw new InvalidOperationException("Fixture caret unavailable.");
        var point = new Point { X = gui.Bounds.Left, Y = gui.Bounds.Top };
        if (gui.Caret != IntPtr.Zero && !ClientToScreen(gui.Caret, ref point))
            throw new InvalidOperationException("Fixture physical caret unavailable.");
        var text = new StringBuilder(4096);
        GetWindowText(editor, text, text.Capacity);
        long selection = SendMessage(editor, 0x00B0, IntPtr.Zero, IntPtr.Zero).ToInt64();
        int start = (int)(selection & 0xffff), end = (int)((selection >> 16) & 0xffff);
        return new { pid, window = window.Handle.ToInt64().ToString(), foregroundPid,
            focus = gui.Focus.ToInt64().ToString(), caret = new { x = point.X, y = point.Y,
                width = gui.Bounds.Right - gui.Bounds.Left, height = gui.Bounds.Bottom - gui.Bounds.Top },
            markers = Windows(helper), text = text.ToString(), clicks = editorEvents.Clicks,
            selectionStart = start, selectionLength = end - start };
    }
    public object Move() {
        if (GetFocus() != editor) throw new InvalidOperationException("Editor not focused.");
        Send(new[] { KeyEvent(0x27, false), KeyEvent(0x27, true) });
        Pump();
        return Inspect(0);
    }
    public object Selection() {
        if (GetFocus() != editor) throw new InvalidOperationException("Editor not focused.");
        SendMessage(editor, 0x00B1, IntPtr.Zero, new IntPtr(3));
        Pump();
        return Inspect(0);
    }
    public object PassThrough(uint helper) {
        Rect badge = new Rect();
        IntPtr found = IntPtr.Zero;
        EnumWindows((handle, unused) => {
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            if (owner == helper && IsWindowVisible(handle)) {
                Rect rect;
                GetWindowRect(handle, out rect);
                if (rect.Right - rect.Left >= 20) { badge = rect; found = handle; }
            }
            return true;
        }, IntPtr.Zero);
        if (found == IntPtr.Zero || GetWindow(found, 4) != window.Handle ||
            (GetWindowLong(found, -20) & 0x080800A8) != 0x080800A8)
            throw new InvalidOperationException("Owned transparent marker unavailable.");
        int before = editorEvents.Clicks;
        MouseClick((badge.Left + badge.Right) / 2, (badge.Top + badge.Bottom) / 2);
        // The badge overlays the editor client, so a real mouse must reach that editor.
        uint foreground;
        GetWindowThreadProcessId(GetForegroundWindow(), out foreground);
        return new { before, after = editorEvents.Clicks, editorFocused = GetFocus() == editor, foregroundPid = foreground };
    }
    public void Dispose() {
        editorEvents.ReleaseHandle();
        window.Dispose();
        DeleteObject(font);
        SetThreadDpiAwarenessContext(oldDpi);
    }
}
