namespace ViClipboard {
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class ClipboardPreparationException : Exception {
    public readonly string Code;
    public readonly int NativeCode;
    public readonly string Stage;
    public readonly uint Format;
    public readonly uint ExpectedSequence, CurrentSequence;
    public ClipboardPreparationException(string code, int nativeCode = 0, string stage = "unspecified", uint format = 0,
        uint expectedSequence = 0, uint currentSequence = 0, Exception inner = null) : base(code, inner) {
        Code = code; NativeCode = nativeCode; Stage = stage; Format = format;
        ExpectedSequence = expectedSequence; CurrentSequence = currentSequence;
    }
}

public sealed class ClipboardSnapshot : IDisposable {
    [DllImport("user32.dll", SetLastError=true)] public static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] public static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError=true)] public static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetClipboardData(uint format, IntPtr data);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll", SetLastError=true)] static extern uint EnumClipboardFormats(uint previous);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern int GetClipboardFormatName(uint format, StringBuilder name, int length);
    [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
    [DllImport("kernel32.dll", SetLastError=true)] static extern UIntPtr GlobalSize(IntPtr data);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint GlobalFlags(IntPtr data);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GlobalLock(IntPtr data);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr data);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GlobalFree(IntPtr data);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr CopyImage(IntPtr image, uint type, int x, int y, uint flags);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr image);
    [DllImport("gdi32.dll", SetLastError=true)] static extern int GetObject(IntPtr image, int size, out BitmapInfo data);
    [DllImport("gdi32.dll")] static extern uint GetEnhMetaFileBits(IntPtr image, uint size, byte[] data);
    [DllImport("gdi32.dll")] static extern uint GetMetaFileBitsEx(IntPtr image, uint size, byte[] data);
    [DllImport("gdi32.dll", SetLastError=true)] static extern IntPtr CopyEnhMetaFile(IntPtr image, string file);
    [DllImport("gdi32.dll")] static extern bool DeleteEnhMetaFile(IntPtr image);
    [DllImport("gdi32.dll", SetLastError=true)] static extern IntPtr CopyMetaFile(IntPtr image, string file);
    [DllImport("gdi32.dll")] static extern bool DeleteMetaFile(IntPtr image);
    [DllImport("gdi32.dll", SetLastError=true)] static extern uint GetPaletteEntries(IntPtr palette, uint start, uint count, byte[] entries);
    [DllImport("gdi32.dll", SetLastError=true)] static extern IntPtr CreatePalette(byte[] data);
    [StructLayout(LayoutKind.Sequential)] struct MetaPicture { public int mode, x, y; public IntPtr metafile; }
    [StructLayout(LayoutKind.Sequential)] struct BitmapInfo {
        public int type, width, height, stride; public ushort planes, depth; public IntPtr bits;
    }

    sealed class Item : IDisposable {
        public uint Format;
        public int Kind;
        public ulong Bytes;
        public IntPtr Handle, Metafile;
        public void Dispose() {
            if (Handle == IntPtr.Zero) return;
            if (Kind == 1 || Kind == 4) DeleteObject(Handle);
            else if (Kind == 2) DeleteEnhMetaFile(Handle);
            else {
                if (Metafile != IntPtr.Zero) DeleteMetaFile(Metafile);
                GlobalFree(Handle);
            }
            Handle = IntPtr.Zero; Metafile = IntPtr.Zero;
        }
    }
    readonly List<Item> items = new List<Item>();
    static Func<uint, IntPtr, IntPtr> write = SetClipboardData;
    static Func<uint, IntPtr, IntPtr> completeTextWrite = SetClipboardData;
    static Action<IntPtr, int> copyCheckpoint = null;
    static Func<IntPtr, IntPtr> releaseCopy = GlobalFree;
    static Func<uint, StringBuilder, int, int> readFormatName = GetClipboardFormatName;
    static ClipboardPreparationException Fault(string code) {
        return new ClipboardPreparationException(code, Marshal.GetLastWin32Error());
    }
    static int ClassifyRegisteredName(string name) {
        if (String.Equals(name, "Ole Private Data", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(name, "DataObject", StringComparison.OrdinalIgnoreCase)) return 1;
        if (String.Equals(name, "FileContents", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(name, "FileGroupDescriptor", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(name, "FileGroupDescriptorW", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(name, "Embed Source", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(name, "Embedded Object", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(name, "Link Source", StringComparison.OrdinalIgnoreCase)) return 2;
        return 0;
    }
    static IntPtr GlobalCopy(uint format, IntPtr source, int length) {
        if (length == 0) throw new ClipboardPreparationException("clipboard-format");
        IntPtr copy = GlobalAlloc(0x42, new UIntPtr((uint)length));
        if (copy == IntPtr.Zero)
            throw new ClipboardPreparationException("clipboard-snapshot-failed", Marshal.GetLastWin32Error(), "snapshot-copy", format);
        bool transferred = false;
        ClipboardPreparationException primary = null;
        try {
            if (copyCheckpoint != null) copyCheckpoint(copy, 0);
            IntPtr input = GlobalLock(source);
            if (input == IntPtr.Zero) throw Fault("clipboard-snapshot-failed");
            try {
                IntPtr output = GlobalLock(copy);
                if (output == IntPtr.Zero) throw Fault("clipboard-snapshot-failed");
                try {
                    if (copyCheckpoint != null) copyCheckpoint(copy, 1);
                    var bytes = new byte[length];
                    Marshal.Copy(input, bytes, 0, length); Marshal.Copy(bytes, 0, output, length);
                } finally { GlobalUnlock(copy); }
            } finally { GlobalUnlock(source); }
            transferred = true;
            return copy;
        } catch (Exception failure) {
            var native = failure as ClipboardPreparationException;
            primary = new ClipboardPreparationException("clipboard-snapshot-failed", native == null ? 0 : native.NativeCode,
                "snapshot-copy", format, 0, 0, failure);
            throw primary;
        } finally {
            if (!transferred) {
                ClipboardPreparationException cleanup = null;
                try {
                    SetLastError(0);
                    IntPtr remaining = releaseCopy(copy);
                    int error = Marshal.GetLastWin32Error();
                    if (remaining != IntPtr.Zero)
                        cleanup = new ClipboardPreparationException("clipboard-snapshot-failed", error, "snapshot-release", format);
                } catch (Exception failure) {
                    cleanup = new ClipboardPreparationException("clipboard-snapshot-failed", 0, "snapshot-release", format, 0, 0, failure);
                }
                if (cleanup != null) {
                    if (primary != null) throw new AggregateException("Clipboard copy and release both failed.", primary, cleanup);
                    throw cleanup;
                }
            }
        }
    }
    static Item Clone(uint format, IntPtr data) {
        var item = new Item { Format = format };
        try {
            if (format == 2 || format == 130) {
                item.Kind = 1;
                BitmapInfo info;
                if (GetObject(data, Marshal.SizeOf(typeof(BitmapInfo)), out info) == 0) throw Fault("clipboard-snapshot-failed");
                item.Bytes = (ulong)(Math.Abs((long)info.height) * Math.Abs((long)info.stride));
                if (item.Bytes > 67108864) throw new ClipboardPreparationException("clipboard-format");
                item.Handle = CopyImage(data, 0, 0, 0, 0x2000);
            } else if (format == 14 || format == 142) {
                item.Kind = 2; item.Bytes = GetEnhMetaFileBits(data, 0, null);
                if (item.Bytes == 0 || item.Bytes > 67108864) throw new ClipboardPreparationException("clipboard-format");
                item.Handle = CopyEnhMetaFile(data, null);
            }
            else if (format == 9) {
                item.Kind = 4;
                uint count = GetPaletteEntries(data, 0, 0, null);
                if (count == 0 || count > 256) throw new ClipboardPreparationException("clipboard-format");
                var palette = new byte[4 + count * 4]; palette[1] = 3;
                item.Bytes = (ulong)palette.Length;
                palette[2] = (byte)count; palette[3] = (byte)(count >> 8);
                var entries = new byte[count * 4];
                if (GetPaletteEntries(data, 0, count, entries) != count) throw Fault("clipboard-snapshot-failed");
                Buffer.BlockCopy(entries, 0, palette, 4, entries.Length); item.Handle = CreatePalette(palette);
            } else if (format == 3 || format == 131) {
                item.Kind = 3;
                if (GlobalSize(data).ToUInt64() < (ulong)Marshal.SizeOf(typeof(MetaPicture))) {
                    throw new ClipboardPreparationException("clipboard-format");
                }
                IntPtr pointer = GlobalLock(data);
                if (pointer == IntPtr.Zero) throw Fault("clipboard-snapshot-failed");
                MetaPicture picture;
                try { picture = (MetaPicture)Marshal.PtrToStructure(pointer, typeof(MetaPicture)); }
                finally { GlobalUnlock(data); }
                item.Bytes = GetMetaFileBitsEx(picture.metafile, 0, null);
                if (item.Bytes == 0 || item.Bytes > 67108864) throw new ClipboardPreparationException("clipboard-format");
                item.Metafile = CopyMetaFile(picture.metafile, null);
                if (item.Metafile == IntPtr.Zero) throw Fault("clipboard-snapshot-failed");
                picture.metafile = item.Metafile;
                item.Handle = GlobalAlloc(0x42, new UIntPtr((uint)Marshal.SizeOf(typeof(MetaPicture))));
                if (item.Handle == IntPtr.Zero) { var error = Fault("clipboard-snapshot-failed"); DeleteMetaFile(item.Metafile); item.Metafile = IntPtr.Zero; throw error; }
                pointer = GlobalLock(item.Handle);
                if (pointer == IntPtr.Zero) throw Fault("clipboard-snapshot-failed");
                try { Marshal.StructureToPtr(picture, pointer, false); } finally { GlobalUnlock(item.Handle); }
            } else {
                if (!(format == 1 || format >= 4 && format <= 17 || format == 129 || format >= 0xc000)) {
                    throw new ClipboardPreparationException("clipboard-format");
                }
                SetLastError(0);
                uint flags = GlobalFlags(data);
                if (flags == 0x8000 || (flags & 0x4000) != 0) throw new ClipboardPreparationException("clipboard-format");
                SetLastError(0);
                ulong length = GlobalSize(data).ToUInt64();
                int error = Marshal.GetLastWin32Error();
                if (error != 0) throw new ClipboardPreparationException("clipboard-snapshot-failed", error);
                if (length == 0 || length > 67108864) throw new ClipboardPreparationException("clipboard-format");
                item.Bytes = length;
                item.Handle = GlobalCopy(format, data, (int)length);
            }
            if (item.Handle == IntPtr.Zero) throw Fault("clipboard-snapshot-failed");
            return item;
        } catch { item.Dispose(); throw; }
    }
    public static ClipboardSnapshot Capture() {
        var snapshot = new ClipboardSnapshot();
        try {
            uint previous = 0;
            int seen = 0;
            var formats = new List<uint>();
            for (;;) {
                SetLastError(0);
                uint format = EnumClipboardFormats(previous);
                int error = Marshal.GetLastWin32Error();
                if (format == 0) {
                    if (error != 0) throw new ClipboardPreparationException("clipboard-snapshot-failed", error);
                    break;
                }
                if (++seen > 256) throw new ClipboardPreparationException("clipboard-format");
                if (format >= 0xc000) {
                    var name = new StringBuilder(256);
                    SetLastError(0);
                    int count = readFormatName(format, name, name.Capacity);
                    int nameError = Marshal.GetLastWin32Error();
                    if (count <= 0)
                        throw new ClipboardPreparationException("clipboard-snapshot-failed", nameError, "snapshot-format-name", format);
                    int classification = ClassifyRegisteredName(name.ToString());
                    // OLE ownership/marshalling bookkeeping cannot be transferred to a different owner.
                    if (classification == 1) {
                        previous = format; continue;
                    }
                    if (classification == 2) {
                        throw new ClipboardPreparationException("clipboard-format", 0, "snapshot-format", format);
                    }
                }
                if (!(format >= 1 && format <= 17 || format == 129 || format == 130 ||
                    format == 131 || format == 142 || format >= 0xc000)) {
                    throw new ClipboardPreparationException("clipboard-format");
                }
                formats.Add(format); previous = format;
            }
            if (seen > 0 && formats.Count == 0) throw new ClipboardPreparationException("clipboard-format");
            ulong totalBytes = 0;
            foreach (uint format in formats) {
                SetLastError(0);
                IntPtr data = GetClipboardData(format);
                if (data == IntPtr.Zero) throw Fault("clipboard-format");
                var item = Clone(format, data);
                snapshot.items.Add(item);
                totalBytes += item.Bytes;
                if (totalBytes > 268435456) throw new ClipboardPreparationException("clipboard-format");
            }
            return snapshot;
        } catch { snapshot.Dispose(); throw; }
    }
    public void RestoreWhileOpen(Action changed) {
        var copies = new List<Item>();
        string stage = "restore-copy";
        uint format = 0;
        try {
            foreach (var item in items) {
                format = item.Format;
                var copy = Clone(item.Format, item.Handle);
                // Publish saved locale before text, including when a later setter fails.
                if (item.Format == 16) copies.Insert(0, copy); else copies.Add(copy);
            }
            format = 0;
            stage = "restore-empty";
            if (!EmptyClipboard()) throw new ClipboardPreparationException("restore-failed", Marshal.GetLastWin32Error(), stage);
            changed();
            stage = "restore-write";
            bool wroteText = false;
            try {
                foreach (var copy in copies) {
                    format = copy.Format;
                    try {
                        if (write(copy.Format, copy.Handle) == IntPtr.Zero)
                            throw new ClipboardPreparationException("restore-failed", Marshal.GetLastWin32Error(), stage, format);
                        copy.Handle = IntPtr.Zero; copy.Metafile = IntPtr.Zero;
                        if (format == 1 || format == 7 || format == 13) wroteText = true;
                    } finally { changed(); }
                }
            } catch (Exception failure) {
                try {
                    // Finish only already-backed text representations before releasing this lock.
                    if (wroteText) foreach (var copy in copies) {
                        if (copy.Handle == IntPtr.Zero || !(copy.Format == 1 || copy.Format == 7 || copy.Format == 13)) continue;
                        try {
                            SetLastError(0);
                            if (completeTextWrite(copy.Format, copy.Handle) == IntPtr.Zero)
                                throw new ClipboardPreparationException("restore-failed", Marshal.GetLastWin32Error(), "restore-text", copy.Format);
                            copy.Handle = IntPtr.Zero; copy.Metafile = IntPtr.Zero;
                        } finally { changed(); }
                    }
                } catch (Exception cleanup) {
                    var original = failure as ClipboardPreparationException;
                    var completion = cleanup as ClipboardPreparationException;
                    throw new AggregateException("Clipboard restore and text publication both failed.",
                        original ?? new ClipboardPreparationException("restore-failed", 0, stage, format, 0, 0, failure),
                        completion ?? new ClipboardPreparationException("restore-failed", 0, "restore-text", 0, 0, 0, cleanup));
                }
                throw;
            }
        } catch (AggregateException failure) {
            var causes = new List<Exception>();
            foreach (var cause in failure.InnerExceptions) {
                var preparation = cause as ClipboardPreparationException;
                if (preparation != null && preparation.Code == "restore-failed") { causes.Add(preparation); continue; }
                causes.Add(new ClipboardPreparationException("restore-failed", preparation == null ? 0 : preparation.NativeCode,
                    preparation != null && preparation.Stage == "snapshot-release" ? "snapshot-release" : stage, format, 0, 0, cause));
            }
            throw new AggregateException("Clipboard restore copy and release both failed.", causes);
        } catch (ClipboardPreparationException error) {
            if (error.Code == "restore-failed") throw;
            throw new ClipboardPreparationException("restore-failed", error.NativeCode, stage, format);
        }
        catch { throw new ClipboardPreparationException("restore-failed", 0, stage, format); }
        finally { foreach (var copy in copies) copy.Dispose(); }
    }
    public void Dispose() { foreach (var item in items) item.Dispose(); items.Clear(); }
}
}
