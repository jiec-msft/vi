param([string] $DiagnosticsDirectory = '', [string] $DiagnosticRun = '', [int] $DiagnosticGeneration = 0, [int] $DiagnosticParent = 0)
$ErrorActionPreference = 'Stop'
. ([IO.Path]::Combine($PSScriptRoot, 'windows-diagnostics.ps1'))
[ViNativeDiagnostics]::Configure($DiagnosticsDirectory, $DiagnosticRun, 'delivery', $DiagnosticGeneration, $DiagnosticParent, $false)
[ViNativeDiagnostics]::Record('compile', 'begin', 0)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Write-ViStartup 'input-begin'
& (Join-Path $PSScriptRoot 'windows-input.ps1') -Action load
Write-ViStartup 'input-ready'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes
Write-ViStartup 'forms-ready'
$clipboardSource=@'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using ViClipboard;

public sealed class TranscriptClipboard : NativeWindow, IDisposable {
    [DllImport("user32.dll", SetLastError=true)] static extern bool OpenClipboard(IntPtr owner);
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
    ClipboardSnapshot saved;
    static TranscriptClipboard deferred;
    bool disposed;
    string text;
    uint sequence;
    bool rendered, renderFailed, began, restoring, restoreMutated;
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
    void Render() {
        if (!began || restoring || restoreMutated || rendered || GetClipboardOwner() != Handle) return;
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
    public void Begin(string value) {
        RecoverPending();
        if (value == null || value.Length == 0 || value.Length > 262144 || value.IndexOf('\0') >= 0)
            throw new ArgumentException("Invalid transcript.");
        uint before = GetClipboardSequenceNumber();
        bool opened = false;
        int openError = 0;
        for (int attempt = 0; attempt < 5 && !opened; attempt++) {
            opened = OpenClipboard(Handle);
            if (!opened) { openError = Marshal.GetLastWin32Error(); Application.DoEvents(); Thread.Sleep(50); }
        }
        if (!opened) throw new ClipboardPreparationException("clipboard-busy", openError);
        try {
            if (GetClipboardSequenceNumber() != before) throw new ClipboardPreparationException("clipboard-changed");
            IntPtr snapshotOwner = GetClipboardOwner();
            try { saved = ClipboardSnapshot.Capture(); }
            catch (ClipboardPreparationException) { throw; }
            catch { throw new ClipboardPreparationException("clipboard-snapshot-failed"); }
            if (GetClipboardOwner() != snapshotOwner) throw new ClipboardPreparationException("clipboard-changed");
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
        bool opened = false;
        int openError = 0;
        for (int attempt = 0; attempt < 5 && !opened; attempt++) {
            opened = OpenClipboard(Handle);
            if (!opened) { openError = Marshal.GetLastWin32Error(); Application.DoEvents(); Thread.Sleep(20); }
        }
        if (!opened) throw new ClipboardPreparationException("restore-failed", openError, "restore-open");
        try {
            // Check ownership under the same lock as restoration so a newer copy cannot be overwritten.
            if (GetClipboardOwner() != Handle) { began = false; return; }
            if (GetClipboardSequenceNumber() != sequence) throw new ClipboardPreparationException("restore-failed", 0, "restore-sequence");
            restoring = true;
            try {
                saved.RestoreWhileOpen(() => {
                    restoreMutated = true;
                    sequence = GetClipboardSequenceNumber();
                });
                began = false;
            } finally {
                sequence = GetClipboardSequenceNumber();
                restoring = false;
            }
        } finally { CloseClipboard(); }
    }
    public void Dispose() {
        if (disposed) return;
        try { Restore(); }
        catch { deferred = this; throw; }
        if (deferred == this) deferred = null;
        disposed = true;
        if (saved != null) saved.Dispose();
        DestroyHandle();
    }
    public static void RecoverPending() {
        var previous = deferred;
        if (previous == null) return;
        previous.Restore();
        previous.Dispose();
    }
}
'@
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition ($clipboardSource + [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'windows-clipboard-snapshot.cs')))
Write-ViStartup 'clipboard-ready'
[ViNativeDiagnostics]::Record('compile', 'end', 0)
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
Write-ViStartup 'protocol-ready'
while ($null -ne ($line = [VoiceCommands]::ReadNext())) {
    $request = $null
    $script:failureCheck = $null
    $script:clipboardErrorStage = 'unspecified'
    $script:clipboardErrorFormat = 0
    $script:clipboardErrorNumber = 0
    $script:pasteRequested = $false
    try {
        if ($line.Length -gt 1600000) { throw 'invalid-request' }
        $request = $line | ConvertFrom-Json
        [ViNativeDiagnostics]::Request([long]$request.id)
        if ($request.action -ne 'held') { [ViNativeDiagnostics]::Record([string]$request.action, 'begin', 0) }
        [TranscriptClipboard]::RecoverPending()
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
                    try { $transaction.Begin([string]$request.text) } catch {
                        $fault=$_.Exception
                        while($fault.InnerException){$fault=$fault.InnerException}
                        if($fault -is [ViClipboard.ClipboardPreparationException]){
                            $script:clipboardErrorNumber=$fault.NativeCode
                            $script:clipboardErrorStage=$fault.Stage
                            $script:clipboardErrorFormat=$fault.Format
                            throw $fault.Code
                        }
                        throw 'native-error'
                    }
                    $current = Assert-Target $request.target
                    if ([VoiceInput]::ModifiersHeld() -or [VoiceInput]::MouseHeld()) { throw 'modifiers-held' }
                    if (-not [VoiceInput]::TargetReady([long]$current.window,[long]$current.focus)) {
                        $script:failureCheck = 'native-focus'
                        throw 'target-changed'
                    }
                    $transaction.PasteStarted()
                    $script:pasteRequested = $true
                    [VoiceInput]::PasteChord()
                    $transaction.PasteFinished()
                    if (-not $transaction.WaitForRead()) { throw 'paste-unconfirmed' }
                    @{ requested = $true; clipboardRead = $true; readerMatched = $transaction.ReaderMatched;
                       readerUnknown = $transaction.ReaderUnknown; renderedBeforePaste = $transaction.RenderedBeforePaste;
                       clipboardHoldMs = $transaction.HoldMilliseconds }
                } finally {
                    try { $transaction.Dispose() } catch {
                        $fault=$_.Exception
                        while($fault.InnerException){$fault=$fault.InnerException}
                        if($fault -is [ViClipboard.ClipboardPreparationException]){
                            $script:clipboardErrorNumber=$fault.NativeCode
                            $script:clipboardErrorStage=$fault.Stage
                            $script:clipboardErrorFormat=$fault.Format
                        }
                        throw 'restore-failed'
                    }
                }
            }
            default { throw 'invalid-request' }
        }
        if ($request.action -ne 'held') { [ViNativeDiagnostics]::Record([string]$request.action, 'end', 0) }
        @{ id = $request.id; ok = $true; value = $value } | ConvertTo-Json -Compress -Depth 5
    } catch {
        $code = $_.Exception.Message
        $fault=$_.Exception
        while($fault.InnerException){$fault=$fault.InnerException}
        if($fault -is [ViClipboard.ClipboardPreparationException]){
            $code=$fault.Code
            $script:clipboardErrorNumber=$fault.NativeCode
            $script:clipboardErrorStage=$fault.Stage
            $script:clipboardErrorFormat=$fault.Format
        }
        [ViNativeDiagnostics]::Record([string]$request.action, 'failure', $script:clipboardErrorNumber)
        if ($code -notin @('window-order','target-changed','secure-field','no-input','clipboard-changed','clipboard-unavailable',
            'clipboard-busy','clipboard-format','clipboard-snapshot-failed',
            'modifiers-held','composition-active','paste-unconfirmed','restore-failed')) { $code = 'native-error' }
        @{ id = $request.id; ok = $false; code = $code; errorNumber=$script:clipboardErrorNumber;
            clipboardStage=$script:clipboardErrorStage; clipboardFormat=$script:clipboardErrorFormat;
            pasteRequested=$script:pasteRequested; check = $script:failureCheck } | ConvertTo-Json -Compress
    }
}
[ViNativeDiagnostics]::Record('native-exit', 'exit', 0)
[ViNativeDiagnostics]::Close()
