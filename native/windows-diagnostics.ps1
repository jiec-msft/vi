Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class ViNativeDiagnostics {
    static readonly Stopwatch clock = Stopwatch.StartNew();
    static string directory, role, run;
    static int generation, parent;
    static long request, lastPulse, lastCheck, lastGapNotice;
    static bool enabled, fileFailed, gap;
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder value, uint bytes, out uint needed);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("wtsapi32.dll", CharSet=CharSet.Unicode)] static extern bool WTSQuerySessionInformationW(IntPtr server, uint session, int kind, out IntPtr data, out uint bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr data);
    static string Name(IntPtr handle, bool station) {
        var value = new StringBuilder(256); uint needed;
        if (handle == IntPtr.Zero || !GetUserObjectInformationW(handle, 2, value, 512, out needed)) return "unavailable";
        string name = value.ToString();
        return station ? name == "WinSta0" ? name : "other"
            : name == "Default" || name == "Winlogon" ? name : "other";
    }
    static string Context() {
        IntPtr input = OpenInputDesktop(0, false, 1);
        int error = input == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
        string desktop = Name(input, false);
        if (input != IntPtr.Zero) CloseDesktop(input);
        uint session; ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id, out session);
        int state = 9; IntPtr data; uint bytes;
        if (WTSQuerySessionInformationW(IntPtr.Zero, session, 8, out data, out bytes)) {
            try { state = Marshal.ReadInt32(data); } finally { WTSFreeMemory(data); }
        }
        return ",\"inputDesktop\":\"" + desktop + "\",\"threadDesktop\":\"" + Name(GetThreadDesktop(GetCurrentThreadId()), false) +
            "\",\"station\":\"" + Name(GetProcessWindowStation(), true) + "\",\"win32Error\":" + error +
            ",\"sessionId\":" + session + ",\"wtsState\":" + state;
    }
    public static void Configure(string folder, string identifier, string component, int epoch, int owner, bool pulse) {
        Guid parsed;
        enabled = !String.IsNullOrEmpty(folder) && Guid.TryParse(identifier, out parsed) &&
            (component == "pointer" || component == "delivery") && epoch > 0 && owner > 0;
        if (!enabled) return;
        directory = folder; run = identifier; role = component; generation = epoch; parent = owner;
        lastPulse = clock.ElapsedMilliseconds;
        if (pulse) {
            var reader = new Thread(() => {
                try {
                    string line;
                    while ((line = Console.ReadLine()) != null) if (line == "pulse") Interlocked.Exchange(ref lastPulse, clock.ElapsedMilliseconds);
                } catch (IOException) { Record("host-pulse", "failure", 0); }
            });
            reader.IsBackground = true; reader.Start();
        }
        Record("native-start", "native-start", 0);
    }
    public static void Request(long id) { request = id; }
    public static void Sample() {
        if (!enabled || clock.ElapsedMilliseconds - lastCheck < 1000) return;
        lastCheck = clock.ElapsedMilliseconds;
        long elapsed = lastCheck - Interlocked.Read(ref lastPulse);
        if (elapsed >= 5000) {
            if (!gap || lastCheck - lastGapNotice >= 30000) { gap = true; lastGapNotice = lastCheck; Record("host-pulse", "host-gap", 0); }
        } else if (gap) { gap = false; Record("host-pulse", "host-resumed", 0); }
    }
    public static void Record(string kind, string state, int code) {
        if (!enabled) return;
        string api = kind == "SetWindowPos" || kind == "GetCursorPos" || kind == "host-pulse" || kind == "compile" ? kind : "";
        string action = kind == "ready" || kind == "capture" || kind == "held" || kind == "paste" || kind == "settle-window" ? kind : "";
        if (api.Length == 0 && action.Length == 0 && kind != "native-start" && kind != "compile" && kind != "native-exit") return;
        if (state != "begin" && state != "end" && state != "failure" && state != "ready" && state != "suspended" &&
            state != "resumed" && state != "host-gap" && state != "host-resumed" && state != "native-start" && state != "exit") return;
        var self = Process.GetCurrentProcess();
        string line = "{\"run\":\"" + run + "\",\"component\":\"" + role + "\",\"clock\":\"helper-stopwatch\",\"pid\":" + self.Id + ",\"parentPid\":" + parent +
            ",\"generation\":" + generation + ",\"birthFileTime\":\"" + self.StartTime.ToFileTimeUtc() +
            "\",\"time\":\"" + DateTime.UtcNow.ToString("o") + "\",\"monoMs\":" + clock.ElapsedMilliseconds +
            ",\"state\":\"" + state + "\",\"api\":\"" + api + "\",\"action\":\"" + action +
            "\",\"requestId\":" + request + ",\"errorNumber\":" + code;
        if (state == "ready" || state == "suspended" || state == "resumed") line += Context();
        if (state == "host-gap" || state == "host-resumed") line += ",\"hostGapMs\":" + (clock.ElapsedMilliseconds - Interlocked.Read(ref lastPulse));
        line += "}";
        if (!fileFailed) try {
            Directory.CreateDirectory(directory);
            string file = Path.Combine(directory, "native-" + role + ".jsonl");
            if (File.Exists(file) && new FileInfo(file).Length + Encoding.UTF8.GetByteCount(line) + 1 > 131072) {
                if (File.Exists(file + ".2")) File.Delete(file + ".2");
                if (File.Exists(file + ".1")) File.Move(file + ".1", file + ".2");
                File.Move(file, file + ".1");
            }
            File.AppendAllText(file, line + "\n", new UTF8Encoding(false));
        } catch (IOException) { fileFailed = true; Console.Error.WriteLine("VI_DIAGNOSTIC_FAILURE"); }
        catch (UnauthorizedAccessException) { fileFailed = true; Console.Error.WriteLine("VI_DIAGNOSTIC_FAILURE"); }
        Console.Error.WriteLine("VI_DIAG " + line);
    }
}
'@
