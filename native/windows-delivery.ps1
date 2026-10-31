$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
& (Join-Path $PSScriptRoot 'windows-input.ps1') -Action load
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public sealed class TranscriptClipboard : NativeWindow, IDisposable {
    [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] static extern bool CloseClipboard();
    [DllImport("user32.dll")] static extern bool EmptyClipboard();
    [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint format, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr GetClipboardOwner();
    [DllImport("user32.dll")] static extern IntPtr GetOpenClipboardWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] static extern int CountClipboardFormats();
    [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern uint RegisterClipboardFormat(string name);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr memory);
    [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr memory);
    DataObject saved;
    string text;
    uint sequence;
    bool rendered, renderFailed, began;
    readonly Stopwatch clock = new Stopwatch();
    long renderedAt;
    long pasteAt = -1;
    long holdAt = -1;
    public uint TargetOwner;
    public bool ReaderMatched, ReaderUnknown;
    public bool RenderedBeforePaste { get { return rendered && (pasteAt < 0 || renderedAt < pasteAt); } }
    public long HoldMilliseconds { get { return holdAt < 0 ? 0 : clock.ElapsedMilliseconds - holdAt; } }
    public void PasteStarted() { pasteAt = clock.ElapsedMilliseconds; }
    public void PasteFinished() { holdAt = clock.ElapsedMilliseconds; }

    public TranscriptClipboard() {
        CreateHandle(new CreateParams { Caption = "provider clipboard delivery", Parent = new IntPtr(-3) });
    }
    static IntPtr Bytes(byte[] data) {
        IntPtr memory = GlobalAlloc(0x42, new UIntPtr((uint)data.Length));
        if (memory == IntPtr.Zero) throw new InvalidOperationException("Clipboard allocation failed.");
        IntPtr pointer = GlobalLock(memory);
        if (pointer == IntPtr.Zero) { GlobalFree(memory); throw new InvalidOperationException("Clipboard lock failed."); }
        try { Marshal.Copy(data, 0, pointer, data.Length); }
        finally { GlobalUnlock(memory); }
        return memory;
    }
    static void SetBytes(uint format, byte[] data) {
        IntPtr memory = Bytes(data);
        if (SetClipboardData(format, memory) == IntPtr.Zero) {
            GlobalFree(memory);
            throw new InvalidOperationException("Clipboard write failed.");
        }
    }
    static byte[] ReadGlobalBytes(uint format) {
        if (!OpenClipboard(IntPtr.Zero)) throw new ExternalException("Clipboard is busy.");
        try {
            IntPtr memory = GetClipboardData(format);
            if (memory == IntPtr.Zero) throw new InvalidOperationException("Clipboard format unavailable.");
            ulong length = GlobalSize(memory).ToUInt64();
            if (length == 0 || length > 67108864) throw new NotSupportedException("Unsupported clipboard payload.");
            IntPtr pointer = GlobalLock(memory);
            if (pointer == IntPtr.Zero) throw new InvalidOperationException("Clipboard data unavailable.");
            var bytes = new byte[(int)length];
            try { Marshal.Copy(pointer, bytes, 0, bytes.Length); }
            finally { GlobalUnlock(memory); }
            return bytes;
        } finally { CloseClipboard(); }
    }
    void Render() {
        if (rendered) return;
        SetBytes(13, Encoding.Unicode.GetBytes(text + "\0"));
        uint reader;
        GetWindowThreadProcessId(GetOpenClipboardWindow(),out reader);
        ReaderMatched = reader == TargetOwner;
        ReaderUnknown = reader == 0;
        rendered = true;
        renderedAt = clock.ElapsedMilliseconds;
        sequence = GetClipboardSequenceNumber();
    }
    protected override void WndProc(ref Message message) {
        try {
            if (message.Msg == 0x305 && message.WParam.ToInt32() == 13) { Render(); return; }
            if (message.Msg == 0x306 && GetClipboardOwner() == Handle && OpenClipboard(Handle)) {
                try { Render(); } finally { CloseClipboard(); }
                return;
            }
        } catch { renderFailed = true; }
        base.WndProc(ref message);
    }
    static DataObject Snapshot() {
        var result = new DataObject();
        var original = Clipboard.GetDataObject();
        if (original == null && CountClipboardFormats() > 0)
            throw new InvalidOperationException("Clipboard snapshot unavailable.");
        if (original != null) foreach (string format in original.GetFormats(false)) {
            int id = DataFormats.GetFormat(format).Id;
            object data;
            if (id >= 0xC000) {
                // Managed clipboard projections can return zero-filled streams despite valid native bytes.
                data = new MemoryStream(ReadGlobalBytes((uint)id));
            } else if (id == 13) {
                var bytes = ReadGlobalBytes(13);
                if (bytes.Length % 2 != 0) throw new NotSupportedException("Invalid Unicode clipboard data.");
                var chars = new char[bytes.Length / 2];
                Buffer.BlockCopy(bytes, 0, chars, 0, bytes.Length);
                data = new string(chars).TrimEnd('\0');
            } else { data = original.GetData(format, false); }
            if (data == null) throw new InvalidOperationException("Clipboard format cannot be preserved.");
            var stream = data as MemoryStream;
            var image = data as System.Drawing.Image;
            if (stream != null) data = new MemoryStream(stream.ToArray());
            else if (image != null) data = image.Clone();
            else if (data is byte[]) data = ((byte[])data).Clone();
            else if (data is string[]) data = ((string[])data).Clone();
            else if (!(data is string)) throw new NotSupportedException("Unsupported clipboard format.");
            result.SetData(format, false, data);
        }
        return result;
    }
    public void Begin(string value) {
        if (value == null || value.Length == 0 || value.Length > 262144 || value.IndexOf('\0') >= 0)
            throw new ArgumentException("Invalid transcript.");
        uint before = GetClipboardSequenceNumber();
        for (int attempt = 0; attempt < 5; attempt++) {
            if (GetClipboardSequenceNumber() != before) throw new InvalidOperationException("Clipboard changed.");
            try { saved = Snapshot(); break; }
            catch (ExternalException) { if (attempt == 4) throw; }
            catch (InvalidOperationException) { if (attempt == 4) throw; }
            Application.DoEvents();
            Thread.Sleep(50);
        }
        if (GetClipboardSequenceNumber() != before) throw new InvalidOperationException("Clipboard changed.");
        if (saved.GetFormats(false).Length == 0 && CountClipboardFormats() > 0)
            throw new InvalidOperationException("Clipboard snapshot unavailable.");
        bool opened = false;
        for (int attempt = 0; attempt < 5 && !opened; attempt++) {
            opened = OpenClipboard(Handle);
            if (!opened) { Application.DoEvents(); Thread.Sleep(20); }
        }
        if (!opened) throw new InvalidOperationException("Clipboard busy.");
        try {
            if (GetClipboardSequenceNumber() != before) throw new InvalidOperationException("Clipboard changed.");
            if (!EmptyClipboard()) throw new InvalidOperationException("Clipboard unavailable.");
            text = value;
            began = true;
            SetClipboardData(13, IntPtr.Zero);
            SetBytes(RegisterClipboardFormat("CanIncludeInClipboardHistory"), BitConverter.GetBytes(0));
            SetBytes(RegisterClipboardFormat("CanUploadToCloudClipboard"), BitConverter.GetBytes(0));
            clock.Start();
        } finally {
            if (began) sequence = GetClipboardSequenceNumber();
            CloseClipboard();
        }
    }
    public bool WaitForRead() {
        while (clock.ElapsedMilliseconds < 2500 || rendered && clock.ElapsedMilliseconds - renderedAt < 350) {
            Application.DoEvents();
            if (renderFailed) throw new InvalidOperationException("Clipboard rendering failed.");
            // Clipboard sync/history can read before the target consumes its paste request.
            if (rendered && clock.ElapsedMilliseconds - holdAt >= 1000 &&
                clock.ElapsedMilliseconds - renderedAt >= 350) return true;
            if (GetClipboardOwner() != Handle) return rendered;
            Thread.Sleep(10);
        }
        return rendered;
    }
    public void Restore() {
        if (!began) return;
        Application.DoEvents();
        if (GetClipboardOwner() != Handle || GetClipboardSequenceNumber() != sequence) return;
        // A new user copy wins. Restore only while this transaction still owns the clipboard.
        Clipboard.SetDataObject(saved, true, 5, 20);
        began = false;
    }
    public void Dispose() {
        try { Restore(); } finally { DestroyHandle(); }
    }
}
'@
function Capture-Target {
    $target = [VoiceInput]::Capture()
    [uint32] $owner = 0
    [void] [VoiceInput]::GetWindowThreadProcessId([IntPtr] $target[0], [ref] $owner)
    if ($owner -eq 0) { throw 'target-changed' }
    @{ window = $target[0].ToString(); focus = $target[1].ToString(); pid = $owner }
}
function Assert-Target($target) {
    $current = Capture-Target
    if ($current.window -ne $target.window) { $script:failureCheck = 'foreground-window'; throw 'target-changed' }
    if ($current.pid -ne $target.pid) { $script:failureCheck = 'foreground-process'; throw 'target-changed' }
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    Start-Sleep -Milliseconds 50
    $settled = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $focused -or $null -eq $settled) { throw 'no-input' }
    if ($settled.Current.IsPassword) { throw 'secure-field' }
    if (-not [System.Windows.Automation.Automation]::Compare($focused,$settled)) {
        $script:failureCheck = 'accessible-focus'
        throw 'target-changed'
    }
    if ($null -eq $focused -or $focused.Current.IsPassword) { throw 'secure-field' }
    if ($focused.Current.ControlType -notin @([System.Windows.Automation.ControlType]::Edit,
        [System.Windows.Automation.ControlType]::Document)) { throw 'no-input' }
    $valuePattern = $null
    if ($focused.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$valuePattern) -and
        $valuePattern.Current.IsReadOnly) { throw 'no-input' }
    if ([VoiceInput]::CompositionActive([long]$current.focus)) { throw 'composition-active' }
    $current
}
while ($null -ne ($line = [VoiceCommands]::ReadNext())) {
    $request = $null
    $script:failureCheck = $null
    try {
        if ($line.Length -gt 1600000) { throw 'invalid-request' }
        $request = $line | ConvertFrom-Json
        $value = switch ($request.action) {
            'ready' { @{ ready = $true } }
            'capture' { Capture-Target }
            'settle-window' {
                try {
                    @{ placedBehind = [VoiceInput]::SettleWindowOrder([long]$request.window,[int]$request.owner) }
                } catch { throw 'window-order' }
            }
            'held' { @{ held = [VoiceInput]::KeysHeld([int[]]$request.keys) } }
            'paste' {
                try { [VoiceInput]::WaitForModifiers() } catch { throw 'modifiers-held' }
                $current = Assert-Target $request.target
                $transaction = [TranscriptClipboard]::new()
                $transaction.TargetOwner = [uint32]$request.target.pid
                try {
                    try { $transaction.Begin([string]$request.text) } catch { throw 'clipboard-unavailable' }
                    $current = Assert-Target $request.target
                    if ([VoiceInput]::ModifiersHeld() -or [VoiceInput]::MouseHeld()) { throw 'modifiers-held' }
                    if (-not [VoiceInput]::TargetReady([long]$current.window,[long]$current.focus)) {
                        $script:failureCheck = 'native-focus'
                        throw 'target-changed'
                    }
                    $transaction.PasteStarted()
                    [VoiceInput]::PasteChord()
                    $transaction.PasteFinished()
                    if (-not $transaction.WaitForRead()) { throw 'paste-unconfirmed' }
                    @{ requested = $true; clipboardRead = $true; readerMatched = $transaction.ReaderMatched;
                       readerUnknown = $transaction.ReaderUnknown; renderedBeforePaste = $transaction.RenderedBeforePaste;
                       clipboardHoldMs = $transaction.HoldMilliseconds }
                } finally {
                    try { $transaction.Dispose() } catch { throw 'restore-failed' }
                }
            }
            default { throw 'invalid-request' }
        }
        @{ id = $request.id; ok = $true; value = $value } | ConvertTo-Json -Compress -Depth 5
    } catch {
        $code = $_.Exception.Message
        if ($code -notin @('window-order','target-changed','secure-field','no-input','clipboard-changed','clipboard-unavailable',
            'modifiers-held','composition-active','paste-unconfirmed','restore-failed')) { $code = 'native-error' }
        @{ id = $request.id; ok = $false; code = $code; check = $script:failureCheck } | ConvertTo-Json -Compress
    }
}
