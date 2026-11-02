namespace ViClipboard {
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class ClipboardPreparationException : Exception {
    public readonly string Code;
    public readonly int NativeCode;
    public ClipboardPreparationException(string code, int nativeCode = 0) : base(code) {
        Code = code; NativeCode = nativeCode;
    }
}

public sealed class ClipboardSnapshot : IDisposable {
    [DllImport("user32.dll", SetLastError=true)] public static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] public static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError=true)] public static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetClipboardData(uint format, IntPtr data);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll", SetLastError=true)] static extern uint EnumClipboardFormats(uint previous);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClipboardFormatName(uint format, StringBuilder name, int length);
    [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
    [DllImport("kernel32.dll", SetLastError=true)] static extern UIntPtr GlobalSize(IntPtr data);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint GlobalFlags(IntPtr data);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GlobalLock(IntPtr data);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr data);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr data);
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
    static ClipboardPreparationException Fault(string code) {
        return new ClipboardPreparationException(code, Marshal.GetLastWin32Error());
    }
    static IntPtr GlobalCopy(IntPtr source, int length) {
        if (length == 0) throw new ClipboardPreparationException("clipboard-format");
        IntPtr copy = GlobalAlloc(0x42, new UIntPtr((uint)length));
        if (copy == IntPtr.Zero) throw Fault("clipboard-snapshot-failed");
        IntPtr input = GlobalLock(source);
        if (input == IntPtr.Zero) { var error = Fault("clipboard-snapshot-failed"); GlobalFree(copy); throw error; }
        try {
            IntPtr output = GlobalLock(copy);
            if (output == IntPtr.Zero) { var error = Fault("clipboard-snapshot-failed"); GlobalFree(copy); throw error; }
            try {
                var bytes = new byte[length];
                Marshal.Copy(input, bytes, 0, length); Marshal.Copy(bytes, 0, output, length);
            } finally { GlobalUnlock(copy); }
        } finally { GlobalUnlock(source); }
        return copy;
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
                item.Handle = GlobalCopy(data, (int)length);
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
                    GetClipboardFormatName(format, name, name.Capacity);
                    // OLE ownership/marshalling bookkeeping cannot be transferred to a different owner.
                    if (name.ToString() == "Ole Private Data" || name.ToString() == "DataObject") {
                        previous = format; continue;
                    }
                    if (name.ToString() == "FileContents" || name.ToString() == "FileGroupDescriptor" ||
                        name.ToString() == "FileGroupDescriptorW" || name.ToString() == "Embed Source" ||
                        name.ToString() == "Embedded Object" || name.ToString() == "Link Source") {
                        throw new ClipboardPreparationException("clipboard-format");
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
        try {
            foreach (var item in items) copies.Add(Clone(item.Format, item.Handle));
            if (!EmptyClipboard()) throw Fault("restore-failed");
            changed();
            foreach (var copy in copies) {
                try {
                    if (write(copy.Format, copy.Handle) == IntPtr.Zero) throw Fault("restore-failed");
                    copy.Handle = IntPtr.Zero; copy.Metafile = IntPtr.Zero;
                } finally { changed(); }
            }
        } catch (ClipboardPreparationException) { throw; }
        catch { throw new ClipboardPreparationException("restore-failed"); }
        finally { foreach (var copy in copies) copy.Dispose(); }
    }
    public void Dispose() { foreach (var item in items) item.Dispose(); items.Clear(); }
}
}
