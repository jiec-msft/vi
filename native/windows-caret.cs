using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

public sealed class ViCaret : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct Gui {
        public int Size, Flags;
        public IntPtr Active, Focus, Capture, Menu, Move, Caret;
        public Rect Bounds;
    }
    [StructLayout(LayoutKind.Sequential)] struct Monitor {
        public int Size;
        public Rect Bounds, Work;
        public int Flags;
    }
    [StructLayout(LayoutKind.Sequential)] struct Label { public IntPtr Sid; public uint Attributes; }
    delegate void WinEvent(IntPtr hook, uint evt, IntPtr window, int obj, int child, uint thread, uint time);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref Gui info);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int count);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)] static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", SetLastError = true)]
    static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr first, IntPtr second,
        uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromRect(ref Rect rect, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref Monitor info);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int bytes, out int needed);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEvent callback, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int size, out int needed);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

    sealed class Marker : Form {
        public bool Line;
        public Marker(bool line) {
            Line = line;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            BackColor = Color.Magenta;
            TransparencyKey = Color.Magenta;
            AccessibleRole = AccessibleRole.None;
            AutoScaleMode = AutoScaleMode.None;
            StartPosition = FormStartPosition.Manual;
            DoubleBuffered = true;
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams {
            get {
                var value = base.CreateParams;
                value.ExStyle |= 0x080800A8; // NOACTIVATE, LAYERED, TOOLWINDOW, TRANSPARENT, TOPMOST.
                return value;
            }
        }
        protected override void WndProc(ref Message message) {
            if (message.Msg == 0x21) { message.Result = new IntPtr(3); return; }
            if (message.Msg == 0x84) { message.Result = new IntPtr(-1); return; }
            base.WndProc(ref message);
        }
        protected override void OnPaint(PaintEventArgs evt) {
            var g = evt.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var blue = new SolidBrush(Color.FromArgb(25, 104, 255))) {
                if (Line) {
                    g.FillEllipse(blue, 0, 0, Width, Width);
                    g.FillRectangle(blue, 0, Width / 2f, Width, Math.Max(0, Height - Width));
                    g.FillEllipse(blue, 0, Height - Width, Width, Width);
                    return;
                }
                using (var shape = new GraphicsPath()) {
                    float r = Math.Min(Width, Height) * .55f;
                    shape.AddArc(0, 0, r, r, 180, 90);
                    shape.AddArc(Width - r - 1, 0, r, r, 270, 90);
                    shape.AddArc(Width - r - 1, Height - r - 1, r, r, 0, 90);
                    shape.AddArc(0, Height - r - 1, r, r, 90, 90);
                    shape.CloseFigure();
                    g.FillPath(blue, shape);
                    using (var border = new Pen(Color.White, Math.Max(1, Width / 24f))) g.DrawPath(border, shape);
                }
                g.ScaleTransform(Width / 24f, Height / 28f);
                using (var white = new Pen(Color.White, 1.8f)) {
                    g.DrawArc(white, 9, 5, 6, 6, 180, 180);
                    g.DrawLine(white, 9, 8, 9, 13);
                    g.DrawLine(white, 15, 8, 15, 13);
                    g.DrawArc(white, 9, 10, 6, 6, 0, 180);
                    g.DrawArc(white, 6, 7, 12, 13, 0, 180);
                    g.DrawLine(white, 12, 20, 12, 23);
                    g.DrawLine(white, 8, 23, 16, 23);
                }
            }
        }
    }
    sealed class Observation {
        public long Generation, Token, Started;
        public string Error;
        public Rect Caret;
        public Monitor Monitor;
        public double Scale;
    }
    readonly Stopwatch clock = Stopwatch.StartNew();
    readonly Marker badge, line;
    readonly System.Windows.Forms.Timer timer;
    readonly WinEvent callback;
    readonly IntPtr previousDpi;
    IntPtr window, focus, focusHook, foregroundHook, destroyHook;
    uint pid;
    long generation, sequence, queryStarted;
    volatile Observation completed;
    Observation sample;
    Observation offered;
    bool querying, bound, disposed;
    string blocked = "no-input";

    public ViCaret() {
        previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previousDpi == IntPtr.Zero || !AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4)))
            throw new InvalidOperationException("DPI context unavailable.");
        badge = new Marker(false);
        line = new Marker(true);
        IntPtr first = badge.Handle, second = line.Handle;
        callback = OnFocus;
        timer = new System.Windows.Forms.Timer { Interval = 20 };
        timer.Tick += (sender, args) => Tick();
        timer.Start();
    }
    public object Identity() {
        using (var process = Process.GetCurrentProcess()) {
            long created, exited, kernel, user;
            if (!GetProcessTimes(process.Handle, out created, out exited, out kernel, out user))
                throw new InvalidOperationException("Helper identity unavailable.");
            return new { ready = true, pid = process.Id, creationFileTime = created.ToString() };
        }
    }
    bool DesktopAvailable() {
        IntPtr input = OpenInputDesktop(0, false, 1);
        if (input == IntPtr.Zero) return false;
        try {
            int needed;
            var active = new StringBuilder(128);
            var own = new StringBuilder(128);
            return GetUserObjectInformation(input, 2, active, 256, out needed) &&
                GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()), 2, own, 256, out needed) &&
                active.ToString() == "Default" && own.ToString() == "Default";
        } finally { CloseDesktop(input); }
    }
    bool TargetCurrent() {
        uint owner;
        uint thread = GetWindowThreadProcessId(window, out owner);
        var info = new Gui { Size = Marshal.SizeOf(typeof(Gui)) };
        return thread != 0 && owner == pid && GetForegroundWindow() == window &&
            GetGUIThreadInfo(thread, ref info) && info.Focus == focus &&
            IsWindowVisible(window) && !IsIconic(window) && IsWindowVisible(focus) &&
            GetAncestor(focus, 2) == window;
    }
    void Hide() { badge.Hide(); line.Hide(); }
    void Invalidate(string reason) {
        if (!bound) return;
        bound = false;
        generation++;
        blocked = reason;
        sample = null;
        offered = null;
        Hide();
        RemoveHooks();
    }
    void RemoveHooks() {
        if (focusHook != IntPtr.Zero) { UnhookWinEvent(focusHook); focusHook = IntPtr.Zero; }
        if (foregroundHook != IntPtr.Zero) { UnhookWinEvent(foregroundHook); foregroundHook = IntPtr.Zero; }
        if (destroyHook != IntPtr.Zero) { UnhookWinEvent(destroyHook); destroyHook = IntPtr.Zero; }
    }
    void OnFocus(IntPtr hook, uint evt, IntPtr changed, int obj, int child, uint thread, uint time) {
        if (bound && (evt == 3 && changed != window || evt == 0x8005 && changed != focus ||
            evt == 0x8001 && (changed == window || changed == focus)))
            Invalidate("target-changed");
    }
    public void Bind(long targetWindow, long targetFocus, uint targetPid) {
        if (disposed || bound || querying || targetWindow <= 0 || targetFocus <= 0 || targetPid == 0)
            throw new InvalidOperationException("Invalid target.");
        window = new IntPtr(targetWindow); focus = new IntPtr(targetFocus); pid = targetPid;
        bound = true; generation++;
        if (!DesktopAvailable()) { Invalidate("desktop-unavailable"); return; }
        if (!TargetCurrent()) { Invalidate("target-changed"); return; }
        // Out-of-context accessibility events only during a bound turn; no low-level input hook.
        foregroundHook = SetWinEventHook(3, 3, IntPtr.Zero, callback, 0, 0, 0);
        focusHook = SetWinEventHook(0x8005, 0x8005, IntPtr.Zero, callback, pid, 0, 0);
        destroyHook = SetWinEventHook(0x8001, 0x8001, IntPtr.Zero, callback, pid, 0, 0);
        if (foregroundHook == IntPtr.Zero || focusHook == IntPtr.Zero || destroyHook == IntPtr.Zero) {
            Invalidate("caret-unavailable"); return;
        }
        StartQuery();
    }
    static int Integrity(uint owner) {
        IntPtr process = OpenProcess(0x1000, false, owner), token = IntPtr.Zero, data = IntPtr.Zero;
        if (process == IntPtr.Zero) throw new InvalidOperationException("integrity-unavailable");
        try {
            if (!OpenProcessToken(process, 8, out token)) throw new InvalidOperationException("integrity-unavailable");
            int needed;
            GetTokenInformation(token, 25, IntPtr.Zero, 0, out needed);
            if (needed <= 0 || needed > 4096) throw new InvalidOperationException("integrity-unavailable");
            data = Marshal.AllocHGlobal(needed);
            if (!GetTokenInformation(token, 25, data, needed, out needed)) throw new InvalidOperationException("integrity-unavailable");
            var label = (Label)Marshal.PtrToStructure(data, typeof(Label));
            byte count = Marshal.ReadByte(GetSidSubAuthorityCount(label.Sid));
            if (count == 0) throw new InvalidOperationException("integrity-unavailable");
            return Marshal.ReadInt32(GetSidSubAuthority(label.Sid, (uint)count - 1));
        } finally {
            if (data != IntPtr.Zero) Marshal.FreeHGlobal(data);
            if (token != IntPtr.Zero) CloseHandle(token);
            CloseHandle(process);
        }
    }
    void StartQuery() {
        if (!bound || querying) return;
        querying = true;
        queryStarted = clock.ElapsedMilliseconds;
        long revision = generation, token = ++sequence, started = queryStarted;
        var worker = new Thread(() => {
            var result = new Observation { Generation = revision, Token = token, Started = started };
            IntPtr oldDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
            try {
                if (oldDpi == IntPtr.Zero || !AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4)))
                    throw new InvalidOperationException("caret-unavailable");
                if (!TargetCurrent()) throw new InvalidOperationException("target-changed");
                uint ownSession, targetSession;
                uint ownPid = (uint)Process.GetCurrentProcess().Id;
                int integrity = Integrity(ownPid);
                if (!ProcessIdToSessionId(ownPid, out ownSession) || !ProcessIdToSessionId(pid, out targetSession) ||
                    ownSession != targetSession || integrity != 0x2000 || Integrity(pid) != integrity)
                    throw new InvalidOperationException("integrity-unavailable");
                var name = new StringBuilder(64);
                if (GetClassName(focus, name, 64) == 0 || name.ToString() != "Edit")
                    throw new InvalidOperationException("caret-unavailable");
                IntPtr targetDpi = GetWindowDpiAwarenessContext(focus);
                if (!AreDpiAwarenessContextsEqual(targetDpi, new IntPtr(-4)) &&
                    !AreDpiAwarenessContextsEqual(targetDpi, new IntPtr(-3)))
                    throw new InvalidOperationException("caret-unavailable");
                if ((GetWindowLong(focus, -16) & 0x20) != 0) throw new InvalidOperationException("secure-field");
                UIntPtr selection;
                if (SendMessageTimeout(focus, 0x00B0, IntPtr.Zero, IntPtr.Zero, 3, 50, out selection) == IntPtr.Zero ||
                    selection.ToUInt64() == UInt32.MaxValue ||
                    (selection.ToUInt64() & 0xffff) != ((selection.ToUInt64() >> 16) & 0xffff))
                    throw new InvalidOperationException("no-input");
                var element = AutomationElement.FocusedElement;
                if (element == null) throw new InvalidOperationException("no-input");
                var current = element.Current;
                if (current.IsPassword) throw new InvalidOperationException("secure-field");
                if (current.ProcessId != pid || current.NativeWindowHandle != focus.ToInt64() ||
                    !current.HasKeyboardFocus || !current.IsEnabled || current.IsOffscreen ||
                    current.ControlType != ControlType.Edit) throw new InvalidOperationException("no-input");
                object value;
                if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out value) || ((ValuePattern)value).Current.IsReadOnly)
                    throw new InvalidOperationException("no-input");
                uint owner;
                uint thread = GetWindowThreadProcessId(window, out owner);
                var gui = new Gui { Size = Marshal.SizeOf(typeof(Gui)) };
                if (!GetGUIThreadInfo(thread, ref gui) || gui.Focus != focus || gui.Caret != focus ||
                    gui.Bounds.Bottom <= gui.Bounds.Top || gui.Bounds.Right < gui.Bounds.Left)
                    throw new InvalidOperationException("caret-unavailable");
                var top = new Point { X = gui.Bounds.Left, Y = gui.Bounds.Top };
                var bottom = new Point { X = gui.Bounds.Right, Y = gui.Bounds.Bottom };
                Rect client;
                if (!GetClientRect(focus, out client) || gui.Bounds.Left < client.Left || gui.Bounds.Top < client.Top ||
                    gui.Bounds.Right > client.Right || gui.Bounds.Bottom > client.Bottom ||
                    !ClientToScreen(focus, ref top) || !ClientToScreen(focus, ref bottom))
                    throw new InvalidOperationException("caret-unavailable");
                result.Caret = new Rect { Left = top.X, Top = top.Y, Right = bottom.X, Bottom = bottom.Y };
                result.Monitor = new Monitor { Size = Marshal.SizeOf(typeof(Monitor)) };
                IntPtr monitor = MonitorFromRect(ref result.Caret, 0);
                uint dpi = GetDpiForWindow(focus);
                if (monitor == IntPtr.Zero || dpi < 96 || dpi > 768 || !GetMonitorInfo(monitor, ref result.Monitor) ||
                    !Contains(result.Monitor.Work, top.X, top.Y, bottom.X - top.X, bottom.Y - top.Y))
                    throw new InvalidOperationException("caret-unavailable");
                result.Scale = dpi / 96.0;
                var settled = AutomationElement.FocusedElement;
                if (settled == null || !Automation.Compare(element, settled) || !TargetCurrent())
                    throw new InvalidOperationException("target-changed");
            } catch (Exception error) {
                string message = error.Message;
                result.Error = message == "target-changed" || message == "secure-field" || message == "no-input" ||
                    message == "integrity-unavailable" ? message : "caret-unavailable";
            } finally {
                if (oldDpi != IntPtr.Zero) SetThreadDpiAwarenessContext(oldDpi);
            }
            completed = result;
        });
        worker.IsBackground = true;
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start();
    }
    void Tick() {
        if (!bound) return;
        if (!DesktopAvailable()) { Invalidate("desktop-unavailable"); return; }
        if (!TargetCurrent()) { Invalidate("target-changed"); return; }
        if (querying && clock.ElapsedMilliseconds - queryStarted > 250) { Invalidate("stale-query"); return; }
        var value = completed;
        if (value != null) {
            completed = null; querying = false;
            if (value.Generation != generation || clock.ElapsedMilliseconds - value.Started > 250) {
                Invalidate("stale-query"); return;
            }
            if (value.Error != null) { Invalidate(value.Error); return; }
            sample = value;
        }
        if (sample != null && clock.ElapsedMilliseconds - sample.Started > 250) Hide();
    }
    public string Sample() {
        Tick();
        if (!bound) return "{\"status\":\"blocked\",\"reason\":\"" + blocked + "\"}";
        var value = sample;
        if (value == null) return "{\"status\":\"pending\"}";
        offered = value;
        string json = "{\"status\":\"available\",\"token\":" + value.Token + ",\"caret\":" + JsonRect(value.Caret) +
            ",\"monitor\":{\"scale\":" + value.Scale.ToString(System.Globalization.CultureInfo.InvariantCulture) +
            ",\"workArea\":" + JsonRect(value.Monitor.Work) + "}}";
        StartQuery();
        return json;
    }
    public void CompositionActive() { Invalidate("composition-active"); }
    static string JsonRect(Rect r) {
        return "{\"x\":" + r.Left + ",\"y\":" + r.Top + ",\"width\":" + (r.Right - r.Left) + ",\"height\":" + (r.Bottom - r.Top) + "}";
    }
    static bool Contains(Rect outer, double x, double y, double width, double height) {
        return x >= outer.Left && y >= outer.Top && x + width <= outer.Right && y + height <= outer.Bottom;
    }
    bool PlaceWindow(Marker marker, int x, int y, int width, int height, long observed) {
        SetWindowLongPtr(marker.Handle, -8, window);
        if (GetWindow(marker.Handle, 4) != window || (GetWindowLong(marker.Handle, -20) & 0x080800A8) != 0x080800A8)
            return false;
        if (!SetWindowPos(marker.Handle, new IntPtr(-1), x, y, width, height, 0x0010) ||
            !bound || !TargetCurrent() || clock.ElapsedMilliseconds - observed > 250) return false;
        marker.Show();
        bool placed = SetWindowPos(marker.Handle, new IntPtr(-1), x, y, width, height, 0x0010 | 0x0040);
        marker.Invalidate();
        return placed && (GetWindowLong(marker.Handle, -20) & 0x080800A8) == 0x080800A8 && GetWindow(marker.Handle, 4) == window;
    }
    public bool Place(long token, double x, double y, double width, double height) {
        Tick();
        if (!bound || offered == null || offered.Token != token || clock.ElapsedMilliseconds - offered.Started > 250)
            return false;
        var value = offered;
        offered = null;
        var r = value.Caret;
        int lineWidth = (int)Math.Ceiling(4 * value.Scale);
        int lineX = r.Right + (int)Math.Ceiling(3 * value.Scale);
        if (Double.IsNaN(x) || Double.IsNaN(y) || Double.IsInfinity(x) || Double.IsInfinity(y) ||
            width != Math.Ceiling(24 * value.Scale) || height != Math.Ceiling(28 * value.Scale) ||
            !Contains(value.Monitor.Work, x, y, width, height) ||
            x < r.Right && x + width > r.Left && y < r.Bottom && y + height > r.Top ||
            !Contains(value.Monitor.Work, lineX, r.Top, lineWidth, r.Bottom - r.Top)) {
            Invalidate("caret-unavailable"); return false;
        }
        bool shown = PlaceWindow(badge, (int)x, (int)y, (int)width, (int)height, value.Started) &&
            PlaceWindow(line, lineX, r.Top, lineWidth, r.Bottom - r.Top, value.Started) && TargetCurrent();
        if (!shown) Invalidate("caret-unavailable");
        return shown;
    }
    public void Dispose() {
        if (disposed) return;
        disposed = true;
        Invalidate("no-input");
        RemoveHooks();
        timer.Stop(); timer.Dispose();
        badge.Dispose(); line.Dispose();
        SetThreadDpiAwarenessContext(previousDpi);
    }
}
