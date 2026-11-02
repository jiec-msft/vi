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
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using ViClipboard;

public sealed class TranscriptClipboard : NativeWindow, IDisposable {
    [DllImport("user32.dll", SetLastError=true)] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll", SetLastError=true)] static extern bool CloseClipboard();
    [DllImport("user32.dll")] static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetClipboardData(uint format, IntPtr data);
    [DllImport("user32.dll", SetLastError=true)] static extern uint EnumClipboardFormats(uint previous);
    [DllImport("user32.dll")] static extern IntPtr GetClipboardOwner();
    [DllImport("user32.dll")] static extern IntPtr GetOpenClipboardWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
    [DllImport("user32.dll")] static extern int CountClipboardFormats();
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern uint RegisterClipboardFormat(string name);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError=true)] static extern UIntPtr GlobalSize(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint GlobalFlags(IntPtr memory);
    [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
    sealed class PublicationItem {
        public uint Format;
        public byte[] Bytes;
    }
    sealed class PublicationProbe {
        public uint RequestedFormat, CanonicalFormat;
        public bool InsideCall, Declined, Uncorrelated;
    }
    readonly List<PublicationItem> publication = new List<PublicationItem>(4);
    static Action<IntPtr> publicationClosed = null;
    static Action<IntPtr> sealBeforeCommit = null;
    static Func<bool> sealClose = CloseClipboard;
    static Func<bool> restoreClose = CloseClipboard;
    static Func<uint, IntPtr> publicationRead = GetClipboardData;
    PublicationProbe activeProbe;
    bool publishing, publicationSealed;
    uint publicationBlockedRenderRequests;
    ClipboardSnapshot saved;
    static TranscriptClipboard deferred;
    bool disposed;
    string text;
    uint sequence;
    bool rendered, renderFailed, began, restoring, restoreMutated;
    bool renderAttempted, renderWriteStarted, renderWriteCompleted;
    uint renderExpectedSequence, renderObservedSequence;
    uint publicationBeforeCloseSequence, publicationAfterCloseSequence;
    bool publicationCloseSucceeded, publicationOwnerObservedAfterClose;
    int publicationCloseNativeError;
    readonly Stopwatch clock = new Stopwatch();
    long renderedAt;
    long pasteAt = -1;
    long holdAt = -1;
    public uint TargetOwner;
    public bool ReaderMatched, ReaderUnknown;
    public bool RenderAttempted { get { return renderAttempted; } }
    public uint RenderExpectedSequence { get { return renderExpectedSequence; } }
    public uint RenderObservedSequence { get { return renderObservedSequence; } }
    public bool RenderWriteStarted { get { return renderWriteStarted; } }
    public bool RenderWriteCompleted { get { return renderWriteCompleted; } }
    public uint PublicationBeforeCloseSequence { get { return publicationBeforeCloseSequence; } }
    public uint PublicationAfterCloseSequence { get { return publicationAfterCloseSequence; } }
    public bool PublicationCloseSucceeded { get { return publicationCloseSucceeded; } }
    public int PublicationCloseNativeError { get { return publicationCloseNativeError; } }
    public bool PublicationOwnerObservedAfterClose { get { return publicationOwnerObservedAfterClose; } }
    public bool PublicationSealed { get { return publicationSealed; } }
    public uint PublicationBlockedRenderRequests { get { return publicationBlockedRenderRequests; } }
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
        if (publishing) { publicationBlockedRenderRequests++; return; }
        if (!began || restoring || restoreMutated || rendered || GetClipboardOwner() != Handle) return;
        renderAttempted = true;
        renderWriteStarted = renderWriteCompleted = false;
        renderExpectedSequence = sequence;
        renderObservedSequence = GetClipboardSequenceNumber();
        if (renderObservedSequence != sequence) { renderFailed = true; return; }
        renderWriteStarted = true;
        SetBytes(13, Encoding.Unicode.GetBytes(text + "\0"));
        renderWriteCompleted = true;
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
            if (publishing && (message.Msg == 0x305 || message.Msg == 0x306)) {
                publicationBlockedRenderRequests++;
                var probe = activeProbe;
                if (probe != null) {
                    bool correlated = probe.InsideCall && message.HWnd == Handle && message.Msg == 0x305 &&
                        probe.CanonicalFormat == 13 && message.WParam.ToInt64() == probe.CanonicalFormat && message.LParam == IntPtr.Zero &&
                        (probe.RequestedFormat == 13 || probe.RequestedFormat == 1 || probe.RequestedFormat == 7);
                    if (!correlated || probe.Declined) probe.Uncorrelated = true;
                    else probe.Declined = true;
                }
                return;
            }
            if (message.Msg == 0x305 && message.WParam.ToInt32() == 13) { Render(); return; }
            if (message.Msg == 0x306 && GetClipboardOwner() == Handle && OpenClipboard(Handle)) {
                try { Render(); } finally { CloseClipboard(); }
                return;
            }
        } catch { renderFailed = true; }
        base.WndProc(ref message);
    }
    static byte[] PublicationBytes(IntPtr memory, uint format) {
        SetLastError(0);
        uint flags = GlobalFlags(memory);
        if (flags == 0x8000 || (flags & 0x4000) != 0)
            throw new ClipboardPreparationException("clipboard-changed", Marshal.GetLastWin32Error(), "publication-state", format);
        SetLastError(0);
        ulong size = GlobalSize(memory).ToUInt64();
        int error = Marshal.GetLastWin32Error();
        if (error != 0) throw new ClipboardPreparationException("clipboard-changed", error, "publication-state", format);
        if (size == 0 || size > 4096)
            throw new ClipboardPreparationException("clipboard-changed", 0, "publication-state", format);
        IntPtr pointer = GlobalLock(memory);
        if (pointer == IntPtr.Zero)
            throw new ClipboardPreparationException("clipboard-changed", Marshal.GetLastWin32Error(), "publication-state", format);
        try {
            var bytes = new byte[(int)size];
            Marshal.Copy(pointer, bytes, 0, bytes.Length);
            return bytes;
        } finally { GlobalUnlock(memory); }
    }
    void PublishMetadata(uint format, byte[] bytes) {
        IntPtr memory = Bytes(bytes);
        bool transferred = false;
        try {
            var item = new PublicationItem { Format = format, Bytes = PublicationBytes(memory, format) };
            if (SetClipboardData(format, memory) == IntPtr.Zero)
                throw new ClipboardPreparationException("clipboard-unavailable", Marshal.GetLastWin32Error(), "publication-write", format);
            transferred = true;
            publication.Add(item);
        } finally { if (!transferred) GlobalFree(memory); }
    }
    void VerifyPublication() {
        uint previous = 0;
        int seen = 0, metadata = 0;
        bool unicode = false;
        for (;;) {
            SetLastError(0);
            uint format = EnumClipboardFormats(previous);
            int error = Marshal.GetLastWin32Error();
            if (format == 0) {
                if (error != 0) throw new ClipboardPreparationException("clipboard-changed", error, "publication-state");
                break;
            }
            if (++seen > publication.Count + 3)
                throw new ClipboardPreparationException("clipboard-changed", 0, "publication-state", format);
            previous = format;
            if (format == 13) { unicode = true; continue; }
            if (format == 1 || format == 7) continue;
            PublicationItem expected = publication.Find(item => item.Format == format);
            if (expected == null) throw new ClipboardPreparationException("clipboard-changed", 0, "publication-state", format);
            SetLastError(0);
            IntPtr memory = GetClipboardData(format);
            if (memory == IntPtr.Zero)
                throw new ClipboardPreparationException("clipboard-changed", Marshal.GetLastWin32Error(), "publication-state", format);
            byte[] actual = PublicationBytes(memory, format);
            if (actual.Length != expected.Bytes.Length)
                throw new ClipboardPreparationException("clipboard-changed", 0, "publication-state", format);
            for (int i = 0; i < actual.Length; i++)
                if (actual[i] != expected.Bytes[i])
                    throw new ClipboardPreparationException("clipboard-changed", 0, "publication-state", format);
            metadata++;
        }
        if (!unicode || metadata != publication.Count)
            throw new ClipboardPreparationException("clipboard-changed", 0, "publication-state");
        // Inspect only nullness, never text bytes. Our renderer stays disabled during sealing.
        foreach (uint format in new uint[] { 13, 1, 7 }) {
            var probe = new PublicationProbe { RequestedFormat = format, CanonicalFormat = 13 };
            IntPtr memory;
            int error;
            activeProbe = probe;
            try {
                probe.InsideCall = true;
                SetLastError(0);
                memory = publicationRead(format);
                error = Marshal.GetLastWin32Error();
            } finally {
                probe.InsideCall = false;
                activeProbe = null;
            }
            if (memory != IntPtr.Zero || !probe.Declined || probe.Uncorrelated)
                throw new ClipboardPreparationException("clipboard-changed", error, "publication-state", format);
        }
    }
    void SealPublication() {
        if (!publicationCloseSucceeded)
            throw new ClipboardPreparationException("clipboard-unavailable", publicationCloseNativeError, "publication-close");
        bool opened = false;
        int error = 0;
        for (int attempt = 0; attempt < 5 && !opened; attempt++) {
            opened = OpenClipboard(Handle);
            if (!opened) { error = Marshal.GetLastWin32Error(); Application.DoEvents(); Thread.Sleep(50); }
        }
        if (!opened) throw new ClipboardPreparationException("clipboard-busy", error, "publication-open");
        Exception validationFailure = null;
        uint candidate = 0;
        try {
            if (GetClipboardOwner() != Handle) {
                began = false;
                throw new ClipboardPreparationException("clipboard-changed", 0, "publication-owner");
            }
            candidate = GetClipboardSequenceNumber();
            if (candidate != publicationAfterCloseSequence)
                throw new ClipboardPreparationException("clipboard-changed", 0, "publication-sequence", 0, publicationAfterCloseSequence, candidate);
            VerifyPublication();
            if (GetClipboardOwner() != Handle || GetClipboardSequenceNumber() != candidate)
                throw new ClipboardPreparationException("clipboard-changed", 0, "publication-sequence");
        } catch (Exception failure) {
            validationFailure = failure;
            throw;
        } finally {
            Exception closeFailure = null;
            try {
                if (!sealClose())
                    closeFailure = new ClipboardPreparationException("clipboard-unavailable", Marshal.GetLastWin32Error(), "publication-close");
            } catch {
                closeFailure = new ClipboardPreparationException("clipboard-unavailable", 0, "publication-close");
            }
            if (closeFailure != null) {
                if (validationFailure != null) throw new AggregateException("Publication validation and close both failed.", validationFailure, closeFailure);
                throw closeFailure;
            }
        }
        if (sealBeforeCommit != null) sealBeforeCommit(Handle);
        if (GetClipboardOwner() != Handle) {
            began = false;
            throw new ClipboardPreparationException("clipboard-changed", 0, "publication-owner");
        }
        if (GetClipboardSequenceNumber() != candidate)
            throw new ClipboardPreparationException("clipboard-changed", 0, "publication-sequence");
        sequence = candidate;
        publicationSealed = true;
        publishing = false;
    }
    public void Begin(string value) {
        if (disposed || began || publication.Count != 0) throw new InvalidOperationException("Clipboard transactions cannot be reused.");
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
            catch (AggregateException) { throw; }
            catch { throw new ClipboardPreparationException("clipboard-snapshot-failed"); }
            if (GetClipboardOwner() != snapshotOwner) throw new ClipboardPreparationException("clipboard-changed");
            uint locale = (uint)(GetKeyboardLayout(0).ToInt64() & 0xffff);
            if (locale == 0) throw new ClipboardPreparationException("clipboard-snapshot-failed");
            if (!EmptyClipboard()) throw new InvalidOperationException("Clipboard unavailable.");
            text = value;
            publishing = true;
            began = true;
            SetClipboardData(13, IntPtr.Zero);
            // Otherwise CloseClipboard may synthesize CF_LOCALE after our sequence sample.
            PublishMetadata(16, BitConverter.GetBytes(locale));
            PublishMetadata(RegisterClipboardFormat("CanIncludeInClipboardHistory"), BitConverter.GetBytes(0));
            PublishMetadata(RegisterClipboardFormat("CanUploadToCloudClipboard"), BitConverter.GetBytes(0));
            PublishMetadata(RegisterClipboardFormat("VI.NativeDelivery.Transaction"), Guid.NewGuid().ToByteArray());
            clock.Start();
        } finally {
            if (began) sequence = GetClipboardSequenceNumber();
            publicationBeforeCloseSequence = GetClipboardSequenceNumber();
            publicationCloseSucceeded = CloseClipboard();
            publicationCloseNativeError = publicationCloseSucceeded ? 0 : Marshal.GetLastWin32Error();
            if (publicationCloseSucceeded && began && publication.Count == 4 && publicationClosed != null)
                publicationClosed(Handle);
            publicationAfterCloseSequence = GetClipboardSequenceNumber();
            publicationOwnerObservedAfterClose = Handle != IntPtr.Zero && GetClipboardOwner() == Handle;
        }
        SealPublication();
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
        bool authorized = false, restored = false, abandoned = false;
        Exception primary = null;
        try {
            // Check ownership under the same lock as restoration so a newer copy cannot be overwritten.
            if (GetClipboardOwner() != Handle) { abandoned = true; return; }
            uint current = GetClipboardSequenceNumber();
            if (current != sequence) throw new ClipboardPreparationException("restore-failed", 0, "restore-sequence", 0, sequence, current);
            authorized = true;
            restoring = true;
            try {
                saved.RestoreWhileOpen(() => {
                    restoreMutated = true;
                    sequence = GetClipboardSequenceNumber();
                });
                restored = true;
            } finally {
                sequence = GetClipboardSequenceNumber();
            }
        } catch (Exception failure) {
            primary = failure;
            throw;
        } finally {
            uint candidate = sequence;
            ClipboardPreparationException cleanup = null;
            try {
                SetLastError(0);
                if (!restoreClose()) throw new ClipboardPreparationException("restore-failed", Marshal.GetLastWin32Error(), "restore-close");
                if (abandoned) began = false;
                else if (authorized) {
                    if (GetClipboardOwner() != Handle) began = false;
                    else {
                        uint current = GetClipboardSequenceNumber();
                        if (current != candidate)
                            throw new ClipboardPreparationException("restore-failed", 0, "restore-sequence", 0, candidate, current);
                        if (restored) began = false;
                    }
                }
            } catch (ClipboardPreparationException failure) { cleanup = failure; }
            catch (Exception failure) {
                cleanup = new ClipboardPreparationException("restore-failed", 0, "restore-close", 0, 0, 0, failure);
            } finally { restoring = false; }
            if (cleanup != null) {
                if (primary != null) throw new AggregateException("Clipboard restore and close both failed.", primary, cleanup);
                throw cleanup;
            }
        }
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
. ([IO.Path]::Combine($PSScriptRoot, 'windows-clipboard-errors.ps1'))
function Set-ClipboardFailureDetail([Exception]$Exception,[switch]$Cleanup){
    $projection=ConvertTo-ClipboardFailure $Exception
    if($Cleanup){$script:clipboardCleanupFailure=$projection}else{$script:clipboardFailure=$projection}
    $first=$projection.causes[0]
    $script:clipboardErrorNumber=$first.errorNumber
    $script:clipboardErrorStage=$first.stage
    $script:clipboardErrorFormat=$first.format
}
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
    $script:clipboardFailure = $null
    $script:clipboardCleanupFailure = $null
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
                        Set-ClipboardFailureDetail $_.Exception
                        throw $script:clipboardFailure.causes[0].code
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
                } catch {
                    if(-not $script:clipboardFailure){Set-ClipboardFailureDetail $_.Exception}
                    throw
                } finally {
                    try { $transaction.Dispose() } catch {
                        Set-ClipboardFailureDetail $_.Exception -Cleanup
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
        if(-not $script:clipboardFailure -and -not $script:clipboardCleanupFailure){
            Set-ClipboardFailureDetail $_.Exception
        }
        if($script:clipboardCleanupFailure){$code='restore-failed'}
        elseif($script:clipboardFailure){$code=$script:clipboardFailure.causes[0].code}
        [ViNativeDiagnostics]::Record([string]$request.action, 'failure', $script:clipboardErrorNumber)
        if ($code -notin @('window-order','target-changed','secure-field','no-input','clipboard-changed','clipboard-unavailable',
            'clipboard-busy','clipboard-format','clipboard-snapshot-failed',
            'modifiers-held','composition-active','paste-unconfirmed','restore-failed')) { $code = 'native-error' }
        $operationCauses=@()
        $cleanupCauses=@()
        if($script:clipboardFailure){$operationCauses=@($script:clipboardFailure.causes)}
        if($script:clipboardCleanupFailure){$cleanupCauses=@($script:clipboardCleanupFailure.causes)}
        @{ id = $request.id; ok = $false; code = $code; errorNumber=$script:clipboardErrorNumber;
            clipboardStage=$script:clipboardErrorStage; clipboardFormat=$script:clipboardErrorFormat;
            clipboardCauses=$operationCauses; clipboardCausesTruncated=($script:clipboardFailure.truncated -eq $true);
            clipboardCleanupCauses=$cleanupCauses; clipboardCleanupCausesTruncated=($script:clipboardCleanupFailure.truncated -eq $true);
            pasteRequested=$script:pasteRequested; check = $script:failureCheck } | ConvertTo-Json -Compress -Depth 6
    }
}
[ViNativeDiagnostics]::Record('native-exit', 'exit', 0)
[ViNativeDiagnostics]::Close()
