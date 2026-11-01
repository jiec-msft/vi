param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('capture', 'load')]
    [string] $Action
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;

public static class VoiceCommands {
    static readonly ConcurrentQueue<string> queue = new ConcurrentQueue<string>();
    static volatile bool ended;
    static bool started;
    public static string ReadNext() {
        if (!started) {
            started = true;
            var reader = new Thread(() => {
                try {
                    string line;
                    while ((line = Console.ReadLine()) != null) queue.Enqueue(line);
                } finally { ended = true; }
            });
            reader.IsBackground = true;
            reader.Start();
        }
        for (;;) {
            // Clipboard ownership requires an STA message pump even while stdin is idle.
            System.Windows.Forms.Application.DoEvents();
            string value;
            if (queue.TryDequeue(out value)) return value;
            if (ended) return null;
            Thread.Sleep(10);
        }
    }
}
public static class VoiceInput {
    static readonly Action<string,string,int> diagnostic = FindDiagnostic();
    static Action<string,string,int> FindDiagnostic() {
        foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies()) {
            Type type = assembly.GetType("ViNativeDiagnostics");
            if (type != null) return (Action<string,string,int>)Delegate.CreateDelegate(typeof(Action<string,string,int>), type.GetMethod("Record"));
        }
        return null;
    }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct GUI {
        public int Size, Flags;
        public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        public RECT CaretRect;
    }
    [StructLayout(LayoutKind.Sequential)] public struct KEY {
        public ushort Key, Scan; public uint Flags, Time; public UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSE {
        public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Explicit)] public struct UNION {
        [FieldOffset(0)] public KEY Keyboard;
        [FieldOffset(0)] public MOUSE Mouse;
    }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint Type; public UNION Data; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(
        IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GUI info);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, System.Text.StringBuilder name, int count);
    [DllImport("user32.dll")] static extern bool IsWindowUnicode(IntPtr window);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    static extern IntPtr SendTextMessage(IntPtr window, uint message, UIntPtr parameter, string text,
        uint flags, uint timeout, out UIntPtr result);
    [DllImport("imm32.dll")] static extern IntPtr ImmGetContext(IntPtr window);
    [DllImport("imm32.dll")] static extern bool ImmReleaseContext(IntPtr window, IntPtr context);
    [DllImport("imm32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] static extern int ImmGetCompositionStringW(IntPtr context, uint index, IntPtr buffer, uint size);

    public static bool CompositionActive(long focus) {
        IntPtr window = new IntPtr(focus);
        IntPtr context = ImmGetContext(window);
        if (context == IntPtr.Zero) return false;
        try {
            int length = ImmGetCompositionStringW(context, 8, IntPtr.Zero, 0);
            if (length == -1) return false;
            if (length < 0) throw new InvalidOperationException("IME composition state unavailable.");
            return length > 0;
        } finally { ImmReleaseContext(window, context); }
    }

    public static bool SettleWindowOrder(long handle, int expectedOwner) {
        IntPtr window = new IntPtr(handle);
        uint owner;
        if (handle <= 0 || expectedOwner <= 0 || GetWindowThreadProcessId(window, out owner) == 0 ||
            owner != expectedOwner || GetAncestor(window, 2) != window)
            throw new InvalidOperationException("Invalid application window.");
        if (!IsWindowVisible(window) || IsIconic(window)) return false;
        IntPtr foreground = GetForegroundWindow();
        if (foreground == IntPtr.Zero) throw new InvalidOperationException("Foreground window unavailable.");
        IntPtr root = GetAncestor(foreground, 2);
        if (root == window) return false;
        if (root == IntPtr.Zero || !IsWindowVisible(root))
            throw new InvalidOperationException("Foreground window unavailable.");
        uint foregroundOwner;
        if (GetWindowThreadProcessId(root, out foregroundOwner) == 0)
            throw new InvalidOperationException("Foreground window unavailable.");
        if (foregroundOwner == expectedOwner) return false;
        // Show() can raise a window even when Windows denies its activation request.
        // Do not cover the still-active application or change its keyboard focus.
        IntPtr after = (GetWindowLong(root, -20) & 8) != 0 ? new IntPtr(-2) : root;
        if (diagnostic != null) diagnostic("SetWindowPos", "begin", 0);
        bool placed = SetWindowPos(window, after, 0, 0, 0, 0, 0x0213);
        int error = placed ? 0 : Marshal.GetLastWin32Error();
        if (diagnostic != null) diagnostic("SetWindowPos", placed ? "end" : "failure", error);
        if (!placed) throw new System.ComponentModel.Win32Exception(error);
        return true;
    }

    public static long[] Capture() {
        IntPtr window = GetForegroundWindow();
        for (int attempt = 0; window == IntPtr.Zero && attempt < 10; attempt++) {
            Thread.Sleep(20);
            window = GetForegroundWindow();
        }
        if (window == IntPtr.Zero) throw new InvalidOperationException("No foreground window.");
        uint pid;
        uint thread = GetWindowThreadProcessId(window, out pid);
        GUI info = new GUI { Size = Marshal.SizeOf(typeof(GUI)) };
        if (!GetGUIThreadInfo(thread, ref info) || info.Focus == IntPtr.Zero)
            throw new InvalidOperationException("No focused input target.");
        var name = new System.Text.StringBuilder(256);
        GetClassName(info.Focus, name, 256);
        if (name.ToString().Equals("Edit", StringComparison.OrdinalIgnoreCase) &&
            (GetWindowLong(info.Focus, -16) & 0x20) != 0)
            throw new InvalidOperationException("Password field.");
        return new long[] { window.ToInt64(), info.Focus.ToInt64() };
    }
    public static bool ModifiersHeld() {
        foreach (int key in new int[] { 0x10, 0x11, 0x12, 0x5B, 0x5C })
            if ((GetAsyncKeyState(key) & 0x8000) != 0) return true;
        return false;
    }
    public static bool KeysHeld(int[] keys) {
        if (keys == null || keys.Length < 1 || keys.Length > 6) throw new ArgumentException("Invalid keys.");
        foreach (int key in keys) {
            if (key < 1 || key > 255) throw new ArgumentException("Invalid key.");
            if ((GetAsyncKeyState(key) & 0x8000) == 0 &&
                !(key == 0x5B && (GetAsyncKeyState(0x5C) & 0x8000) != 0)) return false;
        }
        return true;
    }
    public static void PasteChord() {
        var inputs = new INPUT[4];
        for (int i = 0; i < inputs.Length; i++) {
            inputs[i].Type = 1;
            inputs[i].Data.Keyboard.Key = (ushort)(i == 0 || i == 3 ? 0x11 : 0x56);
            inputs[i].Data.Keyboard.Flags = i >= 2 ? 2u : 0u;
        }
        try {
            if (SendInput(1, new INPUT[] { inputs[0] }, Marshal.SizeOf(typeof(INPUT))) != 1)
                throw new InvalidOperationException("Paste modifier blocked.");
            Thread.Sleep(20);
            if (SendInput(1, new INPUT[] { inputs[1] }, Marshal.SizeOf(typeof(INPUT))) != 1)
                throw new InvalidOperationException("Paste shortcut blocked.");
            Thread.Sleep(30);
        } finally {
            if (SendInput(2, new INPUT[] { inputs[2], inputs[3] }, Marshal.SizeOf(typeof(INPUT))) != 2)
                throw new InvalidOperationException("Paste shortcut release blocked.");
        }
    }
    public static void WaitForModifiers() {
        var deadline = DateTime.UtcNow.AddSeconds(2);
        while (ModifiersHeld() || MouseHeld()) {
            if (DateTime.UtcNow >= deadline) throw new InvalidOperationException("Release modifier keys.");
            Thread.Sleep(20);
        }
        Thread.Sleep(30);
    }
    public static bool MouseHeld() {
        foreach (int key in new int[] { 1, 2, 4 })
            if ((GetAsyncKeyState(key) & 0x8000) != 0) return true;
        return false;
    }
    public static bool TargetReady(long window, long focus) {
        if (ModifiersHeld() || MouseHeld()) return false;
        var current = Capture();
        return current[0] == window && current[1] == focus;
    }
    public static bool IsSelectionEditClass(string name) {
        return String.Equals(name, "Edit", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(name, "RichEdit20W", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(name, "RICHEDIT50W", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(name, "RichEditD2DPT", StringComparison.OrdinalIgnoreCase);
    }
    public static bool SupportsSelectionMessage(long focus) {
        var name = new System.Text.StringBuilder(256);
        IntPtr target = new IntPtr(focus);
        if (GetClassName(target, name, 256) == 0)
            throw new InvalidOperationException("Focused input control is unavailable.");
        return IsSelectionEditClass(name.ToString()) && IsWindowUnicode(target);
    }
    public static bool ReplaceSelection(long window, long focus, string text) {
        if (text == null || text.Length > 65536 || text.IndexOf('\0') >= 0)
            throw new ArgumentException("Invalid input text.");
        if (!TargetReady(window, focus)) return false;
        if (!SupportsSelectionMessage(focus))
            throw new InvalidOperationException("Native text replacement is not supported by this control.");
        UIntPtr result;
        // EM_REPLACESEL preserves text/formatting outside the selection and allows Undo.
        if (SendTextMessage(new IntPtr(focus), 0x00C2, new UIntPtr(1), text, 0x23, 2000, out result) == IntPtr.Zero)
            throw new InvalidOperationException("Native edit control did not confirm text replacement.");
        return true;
    }
    public static INPUT[] UnicodeEvents(string text) {
        if (text == null || text.Length > 65536) throw new ArgumentException("Invalid input text.");
        var inputs = new INPUT[text.Length * 2];
        for (int i = 0; i < text.Length; i++) {
            inputs[i * 2].Type = 1;
            inputs[i * 2].Data.Keyboard.Scan = text[i];
            inputs[i * 2].Data.Keyboard.Flags = 4;
            inputs[i * 2 + 1] = inputs[i * 2];
            inputs[i * 2 + 1].Data.Keyboard.Flags = 6;
        }
        return inputs;
    }
    public static bool TypeText(long window, long focus, string text) {
        if (text == null || text.Length > 65536) throw new ArgumentException("Invalid input text.");
        if (SupportsSelectionMessage(focus)) return ReplaceSelection(window, focus, text);
        for (int offset = 0; offset < text.Length;) {
            if (!TargetReady(window, focus)) return false;
            int count = Math.Min(128, text.Length - offset);
            if (offset + count < text.Length && Char.IsHighSurrogate(text[offset + count - 1])) count--;
            var inputs = UnicodeEvents(text.Substring(offset, count));
            uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent != inputs.Length) {
                if (sent % 2 == 1) {
                    var release = inputs[(int)sent - 1];
                    release.Data.Keyboard.Flags = 6;
                    SendInput(1, new INPUT[] { release }, Marshal.SizeOf(typeof(INPUT)));
                }
                throw new InvalidOperationException("Text input blocked.");
            }
            offset += count;
        }
        return true;
    }
    public static bool DeleteSelection(long window, long focus) {
        if (SupportsSelectionMessage(focus)) return ReplaceSelection(window, focus, "");
        if (!TargetReady(window, focus)) return false;
        var inputs = new INPUT[2];
        for (int i = 0; i < 2; i++) {
            inputs[i].Type = 1;
            inputs[i].Data.Keyboard.Key = 8;
            inputs[i].Data.Keyboard.Flags = i == 1 ? 2u : 0u;
        }
        if (SendInput(1, new INPUT[] { inputs[0] }, Marshal.SizeOf(typeof(INPUT))) != 1)
            throw new InvalidOperationException("Text deletion blocked.");
        try { Thread.Sleep(20); }
        finally {
            if (SendInput(1, new INPUT[] { inputs[1] }, Marshal.SizeOf(typeof(INPUT))) != 1)
                throw new InvalidOperationException("Text deletion key release blocked.");
        }
        return true;
    }
}
'@
if ($Action -eq 'capture') {
    $target = [VoiceInput]::Capture()
    [uint32] $owner = 0
    [void] [VoiceInput]::GetWindowThreadProcessId([IntPtr] $target[0], [ref] $owner)
    if ($owner -eq 0) { throw 'Foreground input target is no longer available.' }
    @{ window = $target[0].ToString(); focus = $target[1].ToString(); pid = $owner } | ConvertTo-Json -Compress
}
