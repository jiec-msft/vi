using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;

// Ordinary WinSta0 desktops only. API contracts:
// https://learn.microsoft.com/windows/win32/winstation/thread-connection-to-a-desktop
// https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-createdesktopw
// https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-switchdesktop
// https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-closedesktop
public static partial class ViCiDesktop
{
    const uint DesktopAccess = 0x01C7; // READ/WRITEOBJECTS, CREATEWINDOW/MENU, ENUMERATE, SWITCHDESKTOP
    const uint ReadSwitch = 0x0141;
    const uint SuspendedNoWindow = 0x08000004;
    const uint WaitTimeout = 258;
    const string HeartbeatProtocol = "vi-ci-immutable-heartbeat-v1";

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public uint cb;
        public string reserved, desktop, title;
        public uint x, y, width, height, charsX, charsY, fill, flags;
        public ushort show, reservedBytes;
        public IntPtr reservedPtr, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long processTime, jobTime;
        public uint flags;
        public UIntPtr minWorking, maxWorking;
        public uint activeLimit;
        public UIntPtr affinity;
        public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits basic;
        public IoCounters io;
        public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Accounting
    {
        public long userTime, kernelTime, periodUser, periodKernel;
        public uint faults, total, active, terminated;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct MouseInput
    {
        public int x, y;
        public uint data, flags, time;
        public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct InputEvent { public uint type; public MouseInput mouse; }
    [StructLayout(LayoutKind.Sequential)]
    struct UserFlags { public int inherit, reserved; public uint flags; }
    [StructLayout(LayoutKind.Sequential)]
    struct SidAttributes { public IntPtr sid; public uint attributes; }
    [StructLayout(LayoutKind.Sequential)]
    struct TokenGroups { public uint count; public SidAttributes first; }
    delegate bool EnumWindow(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr mode, uint flags, uint access, IntPtr security);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr OpenDesktopW(string name, uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SwitchDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetThreadDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr GetThreadDesktop(uint tid);
    [DllImport("user32.dll")]
    static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder value, uint bytes, out uint needed);
    [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", SetLastError = true)]
    static extern bool GetUserFlags(IntPtr handle, int index, out UserFlags value, uint bytes, out uint needed);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool EnumDesktopWindows(IntPtr desktop, EnumWindow callback, IntPtr parameter);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)]
    static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint count, InputEvent[] input, int size);
    [DllImport("user32.dll")]
    static extern int GetSystemMetrics(int index);
    [DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity,
        IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory,
        ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting accounting, uint size, IntPtr needed);
    [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)]
    static extern bool QueryJobProcesses(IntPtr job, int infoClass, IntPtr buffer, uint size, IntPtr needed);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int size, out int needed);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    [DllImport("advapi32.dll")] static extern bool EqualSid(IntPtr first, IntPtr second);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessWithTokenW(IntPtr token, uint logonFlags, string application, StringBuilder command,
        uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessAsUserW(IntPtr token, string application, StringBuilder command,
        IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment,
        string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disableCount, IntPtr disabled,
        uint deleteCount, IntPtr deleted, uint restrictCount, IntPtr restricted, out IntPtr result);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool SetTokenInformation(IntPtr token, int kind, IntPtr data, uint size);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSidToSidW(string text, out IntPtr sid);
    [DllImport("advapi32.dll")] static extern uint GetLengthSid(IntPtr sid);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool LookupPrivilegeValueW(string system, string name, out long luid);

    static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
    static void Win32(bool condition, string operation)
    {
        if (!condition) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    static string Name(IntPtr handle)
    {
        Require(handle != IntPtr.Zero, "Missing USER object handle.");
        var value = new StringBuilder(512);
        uint needed;
        Win32(GetUserObjectInformationW(handle, 2, value, 1024, out needed), "Read USER object name");
        return value.ToString();
    }
    static string InputName()
    {
        IntPtr handle = OpenInputDesktop(0, false, ReadSwitch);
        Win32(handle != IntPtr.Zero, "Open input desktop");
        try { return Name(handle); }
        finally { Win32(CloseDesktop(handle), "Close input desktop readback"); }
    }
    static void Guard()
    {
        Require(Environment.GetEnvironmentVariable("GITHUB_ACTIONS") == "true" &&
            Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") == "github-hosted" &&
            Environment.GetEnvironmentVariable("RUNNER_OS") == "Windows" &&
            RuntimeInformation.IsOSPlatform(OSPlatform.Windows) &&
            UInt64.TryParse(Environment.GetEnvironmentVariable("GITHUB_RUN_ID"), out var run) && run > 0 &&
            UInt64.TryParse(Environment.GetEnvironmentVariable("GITHUB_RUN_ATTEMPT"), out var attempt) && attempt > 0 &&
            (RuntimeInformation.ProcessArchitecture == Architecture.X64 || RuntimeInformation.ProcessArchitecture == Architecture.Arm64) &&
            RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant() == Environment.GetEnvironmentVariable("VI_EXPECTED_ARCH"),
            "Native GitHub-hosted Actions Windows job required.");
    }
    static bool Equal(string a, string b) { return String.Equals(a, b, StringComparison.OrdinalIgnoreCase); }
    public static string RestoreDecision(string active, string original, string owned)
    {
        if (Equal(active, original)) return "unchanged";
        return Equal(active, owned) ? "restore" : "refuse";
    }
    static string Quote(string value)
    {
        Require(!value.Contains("\"") && !value.EndsWith("\\"), "Unsupported executable argument.");
        return "\"" + value + "\"";
    }
    static void Write(string directory, string name, object value)
    {
        File.WriteAllText(Path.Combine(directory, name), JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true }));
    }
    static int VisibleWindows(IntPtr desktop, uint target)
    {
        int count = 0;
        Win32(EnumDesktopWindows(desktop, (window, unused) => {
            uint pid;
            GetWindowThreadProcessId(window, out pid);
            if (pid == target && IsWindowVisible(window)) count++;
            return true;
        }, IntPtr.Zero), "Enumerate owned windows");
        return count;
    }
    static IntPtr NewJob(string name = null)
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, name);
        Win32(job != IntPtr.Zero, "Create owned process job");
        try {
            var limits = new ExtendedLimits();
            limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway
            Win32(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()), "Set owned job limits");
            return job;
        } catch {
            Win32(CloseHandle(job), "Close failed job");
            throw;
        }
    }
    static ProcessInfo Start(IntPtr job, string executable, string script, string directory, string desktop, string role, string testCase,
        string entry = "probe", string workingDirectory = null, bool timeoutProbe = false, bool earlyRecovery = false,
        int immutableHeartbeatLimit = 0)
    {
        var startup = new StartupInfo { cb = (uint)Marshal.SizeOf<StartupInfo>(), desktop = "WinSta0\\" + desktop };
        string arguments = entry == "probe"
            ? " --desktop-probe-role=" + role + " --desktop-probe-case=" + testCase +
                " " + Quote("--desktop-probe-output=" + directory) + " --desktop-probe-name=" + desktop
            : " --ci-mode=" + (entry == "overlay" ? "overlay-recovery" : "release-negative") +
                " --ci-owned-desktop=" + desktop + " " + Quote("--ci-desktop-receipt=" + directory) +
                (timeoutProbe ? " --ci-desktop-timeout-probe" : "") +
                (earlyRecovery ? " --ci-startup-recovery-probe" : "");
        Require(immutableHeartbeatLimit == 0 || (entry == "probe" && role == "default" &&
            testCase == "normal" && immutableHeartbeatLimit > 0 && immutableHeartbeatLimit <= 720),
            "Immutable heartbeat is limited to the finite P0 Default fixture.");
        if (immutableHeartbeatLimit > 0) arguments += " --desktop-probe-heartbeat=immutable-v1";
        var command = new StringBuilder(Quote(executable) + " " + Quote(script) + arguments);
        ProcessInfo child;
        Win32(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, false,
            SuspendedNoWindow, IntPtr.Zero, workingDirectory ?? Environment.CurrentDirectory, ref startup, out child), "Create owned suspended child");
        try {
            Win32(AssignProcessToJobObject(job, child.process), "Assign owned child to job");
            if (immutableHeartbeatLimit > 0) {
                Win32(GetProcessTimes(child.process, out long created, out long exited, out long kernel, out long user),
                    "Read suspended Default fixture creation identity");
                Win32(IsProcessInJob(child.process, job, out bool member), "Read suspended Default fixture specific Job");
                Require(member, "Suspended Default fixture is not in its specific Job.");
                using (var file = new FileStream(Path.Combine(directory, "immutable-identity.json"),
                    FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                using (var writer = new StreamWriter(file, new UTF8Encoding(false))) {
                    writer.Write(JsonSerializer.Serialize(new { protocol = HeartbeatProtocol, pid = child.pid,
                        creationFileTime = created.ToString(), generation = 1, frameLimit = immutableHeartbeatLimit,
                        cadenceMilliseconds = 250 }));
                }
            }
            Win32(ResumeThread(child.thread) != UInt32.MaxValue, "Resume owned child");
            Win32(CloseHandle(child.thread), "Close child thread handle");
            child.thread = IntPtr.Zero;
            return child;
        } catch {
            try {
                Win32(TerminateProcess(child.process, 91), "Terminate failed owned child");
                Win32(WaitForSingleObject(child.process, 5000) == 0, "Wait failed owned child");
            } finally {
                try {
                    if (child.thread != IntPtr.Zero) Win32(CloseHandle(child.thread), "Close failed child thread");
                } finally { Win32(CloseHandle(child.process), "Close failed child process"); }
            }
            throw;
        }
    }
    static void WaitReady(ProcessInfo child, string receipt, double seconds, Action observe = null)
    {
        var clock = Stopwatch.StartNew();
        while (!File.Exists(receipt)) {
            if (observe != null) observe();
            uint state = WaitForSingleObject(child.process, 0);
            Require(state == WaitTimeout, "Owned fixture exited before readiness.");
            Require(clock.Elapsed.TotalSeconds < seconds, "Owned fixture readiness timed out.");
            Thread.Sleep(100);
        }
        if (observe != null) observe();
        using (var json = JsonDocument.Parse(ReadPublishedText(receipt))) {
            Require(json.RootElement.GetProperty("pid").GetUInt32() == child.pid, "Fixture readiness PID mismatch.");
        }
    }
    public static FileStream OpenPublishedSnapshot(string file)
    {
        return new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
    }
    static string ReadPublishedText(string file)
    {
        using (var stream = OpenPublishedSnapshot(file))
        using (var reader = new StreamReader(stream, Encoding.UTF8)) { return reader.ReadToEnd(); }
    }
    public static bool IsDefaultHeartbeatFresh(uint pid, uint heartbeatPid, long heartbeatAt, long sampleAt)
    {
        return heartbeatPid == pid && sampleAt - heartbeatAt < 3000;
    }
    sealed class HeartbeatFrame
    {
        public string protocol { get; set; }
        public uint pid { get; set; }
        public string creationFileTime { get; set; }
        public int generation { get; set; }
        public int sequence { get; set; }
        public long time { get; set; }
        public string fileName { get; set; }
        public long fileLastWriteTicks { get; set; }
        public long fileLength { get; set; }
    }
    sealed class ImmutableHeartbeatReader
    {
        public readonly string directory, birth;
        public readonly uint pid;
        public readonly int generation, limit;
        readonly Dictionary<int, HeartbeatFrame> frames = new Dictionary<int, HeartbeatFrame>();
        public int Count { get { return frames.Count; } }
        public ImmutableHeartbeatReader(string directory, uint pid, string birth, int generation, int limit)
        {
            Require(pid > 0 && Regex.IsMatch(birth, "^[1-9][0-9]+$") && generation == 1 && limit > 0 && limit <= 720,
                "Invalid immutable heartbeat reader identity or lifetime bound.");
            this.directory = directory; this.pid = pid; this.birth = birth;
            this.generation = generation; this.limit = limit;
        }
        public string FileName(int sequence)
        {
            return "heartbeat-v1-" + pid + "-" + birth + "-g" + generation + "-s" + sequence.ToString("D6") + ".json";
        }
        public HeartbeatFrame Parse(string text, string fileName)
        {
            using (var json = JsonDocument.Parse(text)) {
                var value = json.RootElement;
                Require(value.ValueKind == JsonValueKind.Object, "Immutable heartbeat is not a complete JSON object.");
                var properties = new HashSet<string>();
                foreach (var property in value.EnumerateObject())
                    Require(properties.Add(property.Name), "Duplicate immutable heartbeat JSON field.");
                Require(properties.Count == 6, "Immutable heartbeat schema is incomplete or has unexpected fields.");
                var frame = new HeartbeatFrame { protocol = value.GetProperty("protocol").GetString(),
                    pid = value.GetProperty("pid").GetUInt32(), creationFileTime = value.GetProperty("creationFileTime").GetString(),
                    generation = value.GetProperty("generation").GetInt32(), sequence = value.GetProperty("sequence").GetInt32(),
                    time = value.GetProperty("time").GetInt64(), fileName = fileName };
                Require(frame.protocol == HeartbeatProtocol && frame.pid == pid && frame.creationFileTime == birth &&
                    frame.generation == generation && frame.sequence > 0 && frame.sequence <= limit &&
                    fileName == FileName(frame.sequence) && frame.time > 0 &&
                    frame.time <= DateTimeOffset.MaxValue.ToUnixTimeMilliseconds() &&
                    frame.time >= new DateTimeOffset(DateTime.FromFileTimeUtc(Int64.Parse(birth))).ToUnixTimeMilliseconds(),
                    "Immutable heartbeat filename/content identity, sequence, protocol or time invalid: " + text);
                return frame;
            }
        }
        public HeartbeatFrame Latest()
        {
            string failure = Path.Combine(directory, "immutable-producer-error.json");
            Require(!File.Exists(failure), "Immutable heartbeat producer failed: " +
                (File.Exists(failure) ? File.ReadAllText(failure) : "failure receipt"));
            string[] files = Directory.GetFiles(directory, "heartbeat-*.json");
            Require(files.Length > 0 && files.Length <= limit, "Immutable heartbeat final frames missing or over lifetime cap.");
            var present = new HashSet<int>();
            int latest = 0;
            foreach (string file in files) {
                string name = Path.GetFileName(file);
                var match = Regex.Match(name, "^heartbeat-v1-[1-9][0-9]*-[1-9][0-9]*-g[1-9][0-9]*-s([0-9]{6})\\.json$");
                Require(match.Success && Int32.TryParse(match.Groups[1].Value, out int sequence) &&
                    sequence > 0 && sequence <= limit && name == FileName(sequence),
                    "Immutable heartbeat final filename/sequence/identity invalid: " + name);
                sequence = Int32.Parse(match.Groups[1].Value);
                Require(present.Add(sequence), "Duplicate immutable heartbeat sequence.");
                var info = new FileInfo(file);
                if (frames.TryGetValue(sequence, out var frame)) {
                    Require(frame.fileLastWriteTicks == info.LastWriteTimeUtc.Ticks && frame.fileLength == info.Length,
                        "A published immutable heartbeat frame changed while its fixture was live.");
                } else {
                    frame = Parse(ReadPublishedText(file), name);
                    frame.fileLastWriteTicks = info.LastWriteTimeUtc.Ticks;
                    frame.fileLength = info.Length;
                    frames.Add(sequence, frame);
                }
                latest = Math.Max(latest, sequence);
            }
            Require(present.Count == latest && present.Count == frames.Count,
                "Immutable heartbeat sequence gap or a published frame removed while live.");
            return frames[latest];
        }
    }
    static HeartbeatFrame FreshHeartbeat(ImmutableHeartbeatReader reader, out long sampleAt)
    {
        var frame = reader.Latest();
        sampleAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Require(IsDefaultHeartbeatFresh(reader.pid, frame.pid, frame.time, sampleAt),
            "Default desktop owned fixture heartbeat is stale: " + JsonSerializer.Serialize(new {
                frame, sampleAt, ageMilliseconds = sampleAt - frame.time, freshnessLimitMilliseconds = 3000 }));
        return frame;
    }
    static Dictionary<string, object> ReadDefaultHeartbeat(ProcessInfo fixture, IntPtr job, IntPtr desktop,
        ImmutableHeartbeatReader reader, string phase, double? rootElapsedSeconds)
    {
        var sample = new Dictionary<string, object> {
            ["phase"] = phase, ["pid"] = fixture.pid, ["role"] = "default-fixture",
            ["generation"] = 1, ["coverage"] = "specific-default-job-process-and-heartbeat-not-thread-desktop",
            ["sampleStartedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["sampleStartedTicks"] = Stopwatch.GetTimestamp().ToString(),
            ["monotonicClock"] = "native-wrapper-Stopwatch-not-fixture-Node-clock",
            ["monotonicFrequency"] = Stopwatch.Frequency.ToString(),
            ["heartbeatClock"] = "fixture-Node-Date.now",
            ["rootElapsedSeconds"] = rootElapsedSeconds, ["freshnessLimitMilliseconds"] = 3000,
            ["protocol"] = HeartbeatProtocol, ["frameLimit"] = reader.limit, ["cadenceMilliseconds"] = 250
        };
        var frame = FreshHeartbeat(reader, out long at);
        sample["heartbeatPid"] = frame.pid;
        sample["heartbeatCreationFileTime"] = frame.creationFileTime;
        sample["heartbeatGeneration"] = frame.generation;
        sample["heartbeatSequence"] = frame.sequence;
        sample["frameCount"] = reader.Count;
        sample["heartbeatFile"] = frame.fileName;
        sample["heartbeatAt"] = frame.time;
        sample["sampleAt"] = at;
        sample["ageMilliseconds"] = at - frame.time;
        sample["heartbeatReadCompletedTicks"] = Stopwatch.GetTimestamp().ToString();
        sample["fileLastWriteAt"] = new DateTimeOffset(new DateTime(frame.fileLastWriteTicks, DateTimeKind.Utc)).ToUnixTimeMilliseconds();
        sample["fileMetadataScope"] = "immutable-final-frame-stat-not-atomic-directory-snapshot";
        sample["heartbeatStatus"] = "read-immutable-frame";
        bool timesRead = GetProcessTimes(fixture.process, out long created, out long exited, out long kernel, out long user);
        int timesError = timesRead ? 0 : Marshal.GetLastWin32Error();
        sample["processTimesRead"] = timesRead;
        sample["processTimesError"] = timesError;
        sample["creationFileTime"] = timesRead ? created.ToString() : null;
        sample["processCreatedAt"] = timesRead
            ? (object)new DateTimeOffset(DateTime.FromFileTimeUtc(created)).ToUnixTimeMilliseconds() : null;
        bool membershipRead = IsProcessInJob(fixture.process, job, out bool member);
        int membershipError = membershipRead ? 0 : Marshal.GetLastWin32Error();
        sample["membershipApi"] = "IsProcessInJob";
        sample["membershipRead"] = membershipRead;
        sample["membershipError"] = membershipError;
        sample["specificDefaultJobMember"] = member;
        sample["visibleWindowCount"] = VisibleWindows(desktop, fixture.pid);
        sample["snapshotCompletedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        uint waitState = WaitForSingleObject(fixture.process, 0);
        int waitError = waitState == UInt32.MaxValue ? Marshal.GetLastWin32Error() : 0;
        sample["liveCheckApi"] = "WaitForSingleObject";
        sample["liveCheckWaitState"] = waitState;
        sample["liveCheckWin32Error"] = waitError;
        sample["liveCheckedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        sample["sampleCompletedTicks"] = Stopwatch.GetTimestamp().ToString();
        Require(timesRead && created.ToString() == reader.birth && membershipRead && member &&
            (waitState == 0 || waitState == WaitTimeout) &&
            (long)sample["liveCheckedAt"] >= (long)sample["snapshotCompletedAt"],
            "Default fixture identity/lifetime observation failed: " + JsonSerializer.Serialize(sample));
        return sample;
    }
    static List<string> VerifyInvalidHeartbeats(string directory, HeartbeatFrame identity, List<object> witnesses)
    {
        var rejected = new List<string>();
        foreach (string label in new[] { "missing", "tmp-only", "malformed", "partial-final", "wrong-pid",
            "wrong-birth", "wrong-generation", "wrong-sequence", "wrong-filename", "sequence-format", "duplicate", "gap",
            "invalid-time", "invalid-time-type", "wrong-protocol", "duplicate-property", "over-cap", "stale-latest" }) {
            string target = Path.Combine(directory, "negative-" + label);
            Directory.CreateDirectory(target);
            var reader = new ImmutableHeartbeatReader(target, identity.pid, identity.creationFileTime, 1, label == "over-cap" ? 1 : 2);
            var data = new Dictionary<string, object> { ["protocol"] = HeartbeatProtocol, ["pid"] = identity.pid,
                ["creationFileTime"] = identity.creationFileTime, ["generation"] = 1, ["sequence"] = 1,
                ["time"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
            if (label == "wrong-pid") data["pid"] = identity.pid + 1;
            if (label == "wrong-birth") data["creationFileTime"] = (Int64.Parse(identity.creationFileTime) + 1).ToString();
            if (label == "wrong-generation") data["generation"] = 2;
            if (label == "wrong-sequence") data["sequence"] = 0;
            if (label == "invalid-time") data["time"] = 0;
            if (label == "invalid-time-type") data["time"] = "invalid";
            if (label == "wrong-protocol") data["protocol"] = "other";
            if (label == "gap") data["sequence"] = 2;
            if (label != "missing") {
                string name = label == "wrong-filename" ? "heartbeat-v1-invalid.json" : reader.FileName(label == "gap" ? 2 : 1);
                if (label == "sequence-format") name = name.Replace("s000001.json", "s1.json");
                if (label == "tmp-only") name = Path.ChangeExtension(name, ".tmp");
                string text = JsonSerializer.Serialize(data);
                if (label == "duplicate-property") text = text.Substring(0, text.Length - 1) + ",\"sequence\":1}";
                File.WriteAllText(Path.Combine(target, name), label == "malformed" || label == "partial-final" ? "{" : text);
            }
            if (label == "duplicate" || label == "over-cap" || label == "stale-latest") {
                data["sequence"] = label == "duplicate" ? 1 : 2;
                if (label == "stale-latest") data["time"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 3000;
                File.WriteAllText(Path.Combine(target, reader.FileName(2)), JsonSerializer.Serialize(data));
            }
            bool failed = false;
            try { FreshHeartbeat(reader, out long at); }
            catch (Exception error) when (error is InvalidOperationException || error is JsonException ||
                error is KeyNotFoundException || error is FormatException || error is OverflowException) {
                failed = true;
                witnesses.Add(new { label, exceptionType = error.GetType().Name, error = error.Message });
            }
            Require(failed, "Invalid immutable heartbeat was accepted: " + label);
            rejected.Add(label);
        }
        return rejected;
    }
    static void HeartbeatProgress(string directory, Stopwatch clock, string phase, object detail = null)
    {
        Write(directory, "progress.json", new { phase, detail, readerPid = Environment.ProcessId,
            at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), ticks = Stopwatch.GetTimestamp().ToString(),
            monotonicFrequency = Stopwatch.Frequency.ToString(), monotonicClock = "native-verification-Stopwatch",
            elapsedSeconds = clock.Elapsed.TotalSeconds, scope = "bounded-verification-progress-not-heartbeat-freshness-proof" });
    }
    public static int VerifyImmutableHeartbeats(string executable, string script, string directory, string workingDirectory)
    {
        Guard();
        var clock = Stopwatch.StartNew();
        var errors = new List<string>();
        var report = new Dictionary<string, object> { ["protocol"] = HeartbeatProtocol,
            ["scope"] = "real-default-fixture-publication-and-immutable-reader-not-old-failure-cause-proof",
            ["readerPid"] = Environment.ProcessId, ["freshnessLimitMilliseconds"] = 3000 };
        IntPtr desktop = IntPtr.Zero, job = IntPtr.Zero, failureJob = IntPtr.Zero;
        ProcessInfo fixture = new ProcessInfo(), failureFixture = new ProcessInfo();
        var overlaps = new List<object>();
        var heldHandles = new List<Microsoft.Win32.SafeHandles.SafeFileHandle>();
        report["overlaps"] = overlaps;
        try {
            HeartbeatProgress(directory, clock, "native-test-started");
            desktop = OpenInputDesktop(0, false, ReadSwitch);
            Win32(desktop != IntPtr.Zero, "Open Default for heartbeat verification");
            Require(Equal(Name(desktop), "Default"), "Heartbeat verification requires the original Default desktop.");
            job = NewJob();
            string target = Path.Combine(directory, "default");
            Directory.CreateDirectory(target);
            fixture = Start(job, executable, script, target, "Default", "default", "normal", workingDirectory: workingDirectory,
                immutableHeartbeatLimit: 120);
            Win32(GetProcessTimes(fixture.process, out long created, out long exited, out long kernel, out long user),
                "Read real heartbeat fixture birth");
            var reader = new ImmutableHeartbeatReader(target, fixture.pid, created.ToString(), 1, 120);
            HeartbeatProgress(directory, clock, "default-spawned", new { pid = fixture.pid, creationFileTime = created.ToString() });
            WaitReady(fixture, Path.Combine(target, "ready.json"), 20);
            HeartbeatProgress(directory, clock, "default-ready", new { pid = fixture.pid, latestSequence = reader.Latest().sequence });
            for (int index = 0; index < 64; index++) {
                var before = FreshHeartbeat(reader, out long openedAt);
                using (var stream = OpenPublishedSnapshot(Path.Combine(target, before.fileName)))
                using (var held = new StreamReader(stream, Encoding.UTF8)) {
                    heldHandles.Add(stream.SafeFileHandle);
                    long handleOpenedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    var atOpen = reader.Latest();
                    HeartbeatProgress(directory, clock, "held-waiting-next", new { iteration = index,
                        handleOpenedAt, oldSequence = before.sequence, knownSequenceAfterOpen = atOpen.sequence });
                    var next = atOpen;
                    do {
                        Require(clock.Elapsed.TotalSeconds < 25, "Immutable heartbeat concurrent verification deadline exceeded.");
                        Require(WaitForSingleObject(fixture.process, 0) == WaitTimeout, "Real heartbeat producer exited during overlap.");
                        Thread.Sleep(10);
                        next = FreshHeartbeat(reader, out long observedAt);
                    } while (next.sequence <= atOpen.sequence);
                    var old = reader.Parse(held.ReadToEnd(), before.fileName);
                    Require(old.pid == before.pid && old.creationFileTime == before.creationFileTime &&
                        old.generation == before.generation && old.sequence == before.sequence && old.time == before.time,
                        "Held immutable frame changed during real next-frame publication.");
                    var sample = ReadDefaultHeartbeat(fixture, job, desktop, reader, "concurrent-next-frame", clock.Elapsed.TotalSeconds);
                    Require((uint)sample["liveCheckWaitState"] == WaitTimeout && (int)sample["visibleWindowCount"] > 0 &&
                        (int)sample["heartbeatSequence"] > before.sequence,
                        "Next real fixture frame lacks its live Default window/Job proof.");
                    overlaps.Add(new { iteration = index, openedAt, handleOpenedAt, knownPublishedSequenceAfterOpen = atOpen.sequence,
                        oldFrame = old, nextFrame = next, nextProof = sample,
                        heldHandle = stream.SafeFileHandle.DangerousGetHandle().ToInt64().ToString(),
                        heldReadCompletedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
                }
                HeartbeatProgress(directory, clock, "held-iteration-complete", new { iteration = index,
                    completedOverlaps = overlaps.Count, latestSequence = reader.Latest().sequence });
            }
            report["producerPid"] = fixture.pid;
            report["producerCreationFileTime"] = created.ToString();
            report["completedOverlaps"] = overlaps.Count;
            report["frameLimit"] = reader.limit;
            report["finalFrameCount"] = reader.Count;
            var final = reader.Latest();
            Require(IsDefaultHeartbeatFresh(fixture.pid, fixture.pid, final.time, final.time + 2999) &&
                !IsDefaultHeartbeatFresh(fixture.pid, fixture.pid, final.time, final.time + 3000) &&
                !IsDefaultHeartbeatFresh(fixture.pid, fixture.pid + 1, final.time, final.time),
                "The immutable protocol lost its actual freshness/PID boundary.");
            report["freshnessBoundary"] = new { at2999 = true, at3000 = false, wrongPid = false };
            var negativeWitnesses = new List<object>();
            HeartbeatProgress(directory, clock, "negative-frame-cases-started", new { completedOverlaps = overlaps.Count });
            report["negativeCases"] = VerifyInvalidHeartbeats(directory, final, negativeWitnesses);
            report["negativeWitnesses"] = negativeWitnesses;
            string readySharing = Path.Combine(directory, "readiness-sharing.json");
            var readyJson = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { pid = Environment.ProcessId }));
            bool oldReaderRejected = false;
            using (var writer = new FileStream(readySharing, FileMode.CreateNew, FileAccess.ReadWrite,
                FileShare.ReadWrite | FileShare.Delete)) {
                writer.Write(readyJson, 0, readyJson.Length);
                writer.Flush();
                try { File.ReadAllText(readySharing); }
                catch (IOException error) when ((error.HResult & 0xffff) == 32) { oldReaderRejected = true; }
                Require(oldReaderRejected, "Controlled readiness publisher did not reproduce old reader sharing violation.");
                using (var json = JsonDocument.Parse(ReadPublishedText(readySharing)))
                    Require(json.RootElement.GetProperty("pid").GetInt32() == Environment.ProcessId,
                        "Compatible production readiness reader lost the completed published PID.");
            }
            report["readinessSharing"] = new { oldReaderRejected, oldReaderWin32Error = 32,
                newReaderVerified = true, scope = "controlled-open-publication-handle-not-unknown-original-holder-proof" };
            HeartbeatProgress(directory, clock, "negative-frame-cases-complete", new { completedOverlaps = overlaps.Count,
                rejectedCases = negativeWitnesses.Count });
            failureJob = NewJob();
            string failureTarget = Path.Combine(directory, "producer-failure");
            Directory.CreateDirectory(failureTarget);
            failureFixture = Start(failureJob, executable, script, failureTarget, "Default", "default", "normal",
                workingDirectory: workingDirectory, immutableHeartbeatLimit: 1);
            HeartbeatProgress(directory, clock, "cap-failure-producer-spawned", new { pid = failureFixture.pid });
            Win32(GetProcessTimes(failureFixture.process, out long failureCreated, out long failureExited,
                out long failureKernel, out long failureUser), "Read intended producer failure birth");
            WaitReady(failureFixture, Path.Combine(failureTarget, "ready.json"), 20);
            HeartbeatProgress(directory, clock, "cap-failure-producer-ready", new { pid = failureFixture.pid });
            uint state;
            do {
                state = WaitForSingleObject(failureFixture.process, 50);
                Require(state == 0 || state == WaitTimeout, "Producer failure child wait API failed.");
                Require(clock.Elapsed.TotalSeconds < 25, "Producer failure verification deadline exceeded.");
            } while (state == WaitTimeout);
            Win32(GetExitCodeProcess(failureFixture.process, out uint code), "Read intended producer failure exit");
            using (var failure = JsonDocument.Parse(File.ReadAllText(Path.Combine(failureTarget, "immutable-producer-error.json")))) {
                Require(code == 1 && failure.RootElement.GetProperty("pid").GetUInt32() == failureFixture.pid &&
                    failure.RootElement.GetProperty("creationFileTime").GetString() == failureCreated.ToString() &&
                    failure.RootElement.GetProperty("generation").GetInt32() == 1 &&
                    failure.RootElement.GetProperty("protocol").GetString() == HeartbeatProtocol &&
                    failure.RootElement.GetProperty("sequence").GetInt32() == 1 &&
                    failure.RootElement.GetProperty("error").GetString() == "Immutable heartbeat lifetime frame cap exceeded." &&
                    Directory.GetFiles(failureTarget, "heartbeat-*.json").Length == 1,
                    "Producer failure was not the exact intended cap/exit witness.");
                report["producerFailure"] = new { pid = failureFixture.pid, childExitCode = code,
                    rawError = failure.RootElement.Clone(), stoppedAfterPublishedFrames = 1 };
            }
            HeartbeatProgress(directory, clock, "cap-failure-witness-complete", report["producerFailure"]);
        } catch (Exception error) { errors.Add(error.ToString()); }
        finally {
            report["cleanupStartedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            bool readersClosed = heldHandles.TrueForAll(handle => handle.IsClosed);
            report["readerHandlesClosed"] = readersClosed;
            if (!readersClosed) errors.Add("An immutable heartbeat reader handle survived verification.");
            CleanupJob(failureJob, errors, report, "producerFailureJobCleanup");
            CleanupJob(job, errors, report, "defaultJobCleanup");
            bool handlesClosed = true;
            foreach (var process in new[] { fixture, failureFixture }) {
                if (process.process == IntPtr.Zero) continue;
                if (WaitForSingleObject(process.process, 5000) != 0) errors.Add("Heartbeat fixture did not signal exit after Job cleanup.");
                if (!CloseHandle(process.process)) {
                    handlesClosed = false;
                    errors.Add("Close heartbeat fixture process handle failed: " + Marshal.GetLastWin32Error());
                }
            }
            report["processHandlesClosed"] = handlesClosed;
            if (desktop != IntPtr.Zero) {
                bool unchanged = Equal(InputName(), "Default");
                report["originalDefaultUnchanged"] = unchanged;
                if (!unchanged) errors.Add("Input desktop changed during heartbeat verification.");
                bool windowsGone = (fixture.pid == 0 || VisibleWindows(desktop, fixture.pid) == 0) &&
                    (failureFixture.pid == 0 || VisibleWindows(desktop, failureFixture.pid) == 0);
                report["fixtureWindowsRemoved"] = windowsGone;
                if (!windowsGone) errors.Add("Real heartbeat fixture window survived cleanup.");
                if (!CloseDesktop(desktop)) errors.Add("Close heartbeat Default desktop handle failed: " + Marshal.GetLastWin32Error());
            }
            report["elapsedSeconds"] = clock.Elapsed.TotalSeconds;
            report["cleanupCompletedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            report["errors"] = errors;
            report["passed"] = errors.Count == 0;
            HeartbeatProgress(directory, clock, "cleanup-complete", new { completedOverlaps = overlaps.Count,
                readerHandlesClosed = readersClosed, processHandlesClosed = handlesClosed, errors });
            Write(directory, "report.json", report);
        }
        return errors.Count == 0 ? 0 : 1;
    }
    sealed class ThreadDesktopQuery
    {
        public uint pid { get; set; }
        public uint tid { get; set; }
        public string api { get; set; }
        public string rawHandle { get; set; }
        public int win32Error { get; set; }
        public string threadDesktop { get; set; }
        public long observedAt { get; set; }
        public string status { get; set; }
    }
    static ThreadDesktopQuery ReadThreadDesktop(uint pid, uint tid, long observedAt)
    {
        IntPtr handle = GetThreadDesktop(tid);
        int error = handle == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
        string api = "GetThreadDesktop", actual = null;
        if (handle != IntPtr.Zero) {
            api = "GetUserObjectInformationW";
            var name = new StringBuilder(512);
            uint needed;
            bool read = GetUserObjectInformationW(handle, 2, name, 1024, out needed);
            error = read ? 0 : Marshal.GetLastWin32Error();
            if (read) actual = name.ToString();
        }
        return new ThreadDesktopQuery { pid = pid, tid = tid, api = api, rawHandle = handle.ToInt64().ToString(),
            win32Error = error, threadDesktop = actual, observedAt = observedAt,
            status = actual == null ? "unobserved-not-desktop-proof" : "observed" };
    }
    static void ValidateHarnessReady(ProcessInfo child, string receipt, string desktop, IntPtr owned,
        List<object> observations, Dictionary<string, object> report)
    {
        using (var json = JsonDocument.Parse(ReadPublishedText(receipt))) {
            var root = json.RootElement;
            Require(root.GetProperty("pid").GetUInt32() == child.pid &&
                Equal(root.GetProperty("desktop").GetString(), desktop), "Harness readiness root/desktop mismatch.");
            long at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            uint callerTid = GetCurrentThreadId();
            var current = ReadThreadDesktop((uint)Environment.ProcessId, callerTid, at);
            bool processTimesRead = GetProcessTimes(child.process, out long created, out long exited, out long kernel, out long user);
            int processTimesError = processTimesRead ? 0 : Marshal.GetLastWin32Error();
            uint waitState = WaitForSingleObject(child.process, 0);
            int waitError = waitState == UInt32.MaxValue ? Marshal.GetLastWin32Error() : 0;
            bool exitCodeRead = GetExitCodeProcess(child.process, out uint exitCode);
            int exitCodeError = exitCodeRead ? 0 : Marshal.GetLastWin32Error();
            var visibleOwnedWindows = new HashSet<long>();
            bool enumerated = EnumDesktopWindows(owned, (window, unused) => {
                uint owner;
                GetWindowThreadProcessId(window, out owner);
                if (owner == child.pid && IsWindowVisible(window)) visibleOwnedWindows.Add(window.ToInt64());
                return true;
            }, IntPtr.Zero);
            int enumerationError = enumerated ? 0 : Marshal.GetLastWin32Error();
            var context = new {
                scope = "window-desktop-association-not-all-root-threads",
                callerPid = Environment.ProcessId, callerTid, station = Name(GetProcessWindowStation()),
                currentThreadQuery = current, inputDesktop = InputName(),
                ownedDesktopHandle = owned.ToInt64().ToString(), ownedDesktopHandleName = Name(owned),
                rootPid = child.pid, rootPrimaryTid = child.tid,
                processTimesRead, processTimesError,
                rootCreationFileTime = processTimesRead ? created.ToString() : null,
                waitState, waitError, exitCodeRead, exitCodeError, rawExitCode = exitCode,
                enumerationApi = "EnumDesktopWindows", enumerated, enumerationError, observedAt = at
            };
            report["rootWindowQueryContext"] = context;
            bool verified = current.threadDesktop != null && Equal(current.threadDesktop, desktop) &&
                processTimesRead && waitState == WaitTimeout && exitCodeRead && enumerated;
            foreach (string key in new[] { "mainWindow", "overlayWindow" }) {
                IntPtr window = new IntPtr(Int64.Parse(root.GetProperty(key).GetString()));
                uint owner;
                uint tid = GetWindowThreadProcessId(window, out owner);
                int identityError = tid == 0 ? Marshal.GetLastWin32Error() : 0;
                bool exists = IsWindow(window), visible = IsWindowVisible(window);
                var query = tid == 0 ? null : ReadThreadDesktop(owner, tid, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                bool enumeratedOnOwnedDesktop = visibleOwnedWindows.Contains(window.ToInt64());
                observations.Add(new { role = key, window = window.ToInt64().ToString(), exists, visible, pid = owner, tid,
                    identityApi = "GetWindowThreadProcessId", identityError, enumeratedOnOwnedDesktop,
                    coverage = "window-desktop-association", rootCreationFileTime = created.ToString(),
                    threadQuery = query, snapshotCompletedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
                verified = verified && exists && visible && owner == child.pid && enumeratedOnOwnedDesktop &&
                    tid != 0;
                if (query?.threadDesktop != null)
                    Require(Equal(query.threadDesktop, desktop), "Connected root window thread is on the wrong desktop.");
            }
            report["rootWindowSnapshotCompletedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            Require(WaitForSingleObject(child.process, 0) == WaitTimeout, "Root exited during window observation.");
            Require(verified, "Owned root window desktop association not verified: " +
                JsonSerializer.Serialize(new { context, windows = observations }));
        }
    }
    sealed class DesktopObservation
    {
        public uint pid { get; set; }
        public string executable { get; set; }
        public string status { get; set; } = "unobserved-not-desktop-proof";
        public int attempts { get; set; }
        public long firstJobObservedAt { get; set; }
        public long observedAt { get; set; }
        public long snapshotCompletedAt { get; set; }
        public long processCreatedAt { get; set; }
        public string processCreationApi { get; set; } = "GetProcessTimes";
        public string processCreationClock { get; set; } = "Win32-FILETIME-not-Node-Date.now";
        public string sourceHead { get; set; } = Environment.GetEnvironmentVariable("VI_PROBE_HEAD");
        public string runId { get; set; } = Environment.GetEnvironmentVariable("GITHUB_RUN_ID");
        public string attempt { get; set; } = Environment.GetEnvironmentVariable("GITHUB_RUN_ATTEMPT");
        public string caseId { get; set; }
        public string creationFileTime { get; set; }
        public bool specificJobMember { get; set; }
        public bool liveAtCompletion { get; set; }
        public long liveCheckedAt { get; set; }
        public string liveCheckApi { get; set; } = "WaitForSingleObject";
        public uint liveCheckWaitState { get; set; }
        public int liveCheckWin32Error { get; set; }
        public string coverage { get; set; } = "specific-job-process-identity-not-thread-desktop";
        public string membershipApi { get; set; } = "IsProcessInJob";
        public object firstUnobserved { get; set; }
        public List<string> threadDesktops { get; set; } = new List<string>();
        public List<object> threadObservations { get; set; } = new List<object>();
    }
    static void ObserveJobDesktops(IntPtr job, string desktop, string directory,
        Dictionary<string, DesktopObservation> observations)
    {
        const int capacity = 256;
        IntPtr buffer = Marshal.AllocHGlobal(8 + capacity * IntPtr.Size);
        try {
            Win32(QueryJobProcesses(job, 3, buffer, (uint)(8 + capacity * IntPtr.Size), IntPtr.Zero), "Read owned job process identities");
            int count = Marshal.ReadInt32(buffer, 4);
            Require(count >= 0 && count <= capacity, "Owned process inventory exceeded its bound.");
            for (int index = 0; index < count; index++) {
                uint pid = (uint)Marshal.ReadIntPtr(buffer, 8 + index * IntPtr.Size).ToInt64();
                Process process = null;
                IntPtr processHandle = IntPtr.Zero;
                try {
                    process = Process.GetProcessById((int)pid);
                    processHandle = OpenProcess(0x00101000, false, pid); // SYNCHRONIZE | QUERY_LIMITED_INFORMATION
                    Win32(processHandle != IntPtr.Zero, "Open owned process identity PID " + pid);
                    Win32(GetProcessTimes(processHandle, out long created, out long exited, out long kernel, out long user),
                        "Read owned process creation identity PID " + pid);
                    string identity = pid + "-" + created;
                    if (!observations.TryGetValue(identity, out var observation)) {
                        observation = new DesktopObservation { pid = pid, creationFileTime = created.ToString(),
                            caseId = desktop,
                            processCreatedAt = new DateTimeOffset(DateTime.FromFileTimeUtc(created)).ToUnixTimeMilliseconds(),
                            firstJobObservedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
                        observations.Add(identity, observation);
                    }
                    if (observation.status == "verified-specific-job-process-identity") continue;
                    observation.attempts++;
                    observation.observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    Win32(IsProcessInJob(processHandle, job, out bool member), "Query specific owned job PID " + pid);
                    Require(member, "Enumerated process is not in the specific owned job PID " + pid);
                    observation.specificJobMember = member;
                    try {
                        ProcessThreadCollection threads = null;
                        string inventoryApi = "Process.ProcessName";
                        try {
                            observation.executable = process.ProcessName;
                            inventoryApi = "Process.Threads";
                            threads = process.Threads;
                        }
                        catch (InvalidOperationException error) {
                            uint exitedWait = WaitForSingleObject(processHandle, 0);
                            int exitedWaitError = exitedWait == UInt32.MaxValue ? Marshal.GetLastWin32Error() : 0;
                            var sample = new { pid, creationFileTime = created.ToString(), api = inventoryApi,
                                exceptionType = error.GetType().Name, error = error.Message,
                                waitState = exitedWait, win32Error = exitedWaitError,
                                checkedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                                status = "exited-process-thread-inventory-not-proof" };
                            Require(exitedWait == 0, "Remote thread inventory failed without a confirmed process exit: " +
                                JsonSerializer.Serialize(sample));
                            observation.firstUnobserved = sample;
                        }
                        if (threads != null) foreach (ProcessThread thread in threads) {
                        uint tid = (uint)thread.Id;
                        var sample = ReadThreadDesktop(pid, tid, observation.observedAt);
                        observation.threadObservations.Add(sample);
                        if (sample.threadDesktop == null) {
                            if (observation.firstUnobserved == null) observation.firstUnobserved = sample;
                            continue;
                        }
                        Require(Equal(sample.threadDesktop, desktop), "Owned job descendant thread escaped its ordinary desktop: " +
                            JsonSerializer.Serialize(sample));
                        if (!observation.threadDesktops.Contains(sample.threadDesktop)) observation.threadDesktops.Add(sample.threadDesktop);
                    } } catch (Win32Exception error) {
                        observation.firstUnobserved = new { pid, api = "Process.Threads",
                            win32Error = error.NativeErrorCode, status = "remote-thread-diagnostic-not-proof" };
                    }
                    observation.snapshotCompletedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    observation.liveCheckWaitState = WaitForSingleObject(processHandle, 0);
                    observation.liveCheckWin32Error = observation.liveCheckWaitState == UInt32.MaxValue
                        ? Marshal.GetLastWin32Error() : 0;
                    observation.liveCheckedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    observation.liveAtCompletion = observation.liveCheckWaitState == WaitTimeout;
                    if (observation.liveCheckWaitState != WaitTimeout && observation.liveCheckWaitState != 0) {
                        observation.status = "process-live-check-failed-not-proof";
                        throw new InvalidOperationException("Owned process lifetime API failed: " +
                            JsonSerializer.Serialize(new { pid, creationFileTime = created.ToString(),
                                api = observation.liveCheckApi, waitState = observation.liveCheckWaitState,
                                win32Error = observation.liveCheckWin32Error, observation.snapshotCompletedAt,
                                observation.liveCheckedAt }));
                    }
                    Require(observation.liveCheckedAt >= observation.snapshotCompletedAt,
                        "Owned process lifetime clock moved backwards after snapshot completion PID " + pid);
                    observation.status = observation.liveAtCompletion
                        ? "verified-specific-job-process-identity" : "exited-before-completed-job-proof";
                    if (observation.liveAtCompletion) {
                        string receipt = "job-" + identity;
                        Write(directory, receipt + ".tmp", observation);
                        File.Move(Path.Combine(directory, receipt + ".tmp"), Path.Combine(directory, receipt + ".json"));
                    }
                } catch (ArgumentException) {
                    observations[pid + "-unknown"] = new DesktopObservation { pid = pid,
                        status = "exited-before-process-identity-observation" };
                } catch (Win32Exception error) {
                    var sample = new { pid, api = "Process.ProcessName/Threads", win32Error = error.NativeErrorCode,
                        observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), status = "process-inventory-error-not-proof" };
                    observations[pid + "-unknown"] = new DesktopObservation { pid = pid,
                        status = "process-inventory-error-not-proof", firstUnobserved = sample };
                    if (error.NativeErrorCode != 6 && error.NativeErrorCode != 87 && error.NativeErrorCode != 1168)
                        throw new InvalidOperationException("Owned process inventory failed: " + JsonSerializer.Serialize(sample), error);
                } finally {
                    if (process != null) process.Dispose();
                    if (processHandle != IntPtr.Zero) Win32(CloseHandle(processHandle), "Close observed process identity handle");
                }
            }
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static void CleanupJob(IntPtr job, List<string> errors, Dictionary<string, object> report, string key)
    {
        if (job == IntPtr.Zero) return;
        try {
            Win32(TerminateJobObject(job, 92), "Terminate owned job");
            var clock = Stopwatch.StartNew();
            Accounting accounting;
            do {
                Win32(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero), "Read owned job accounting");
                if (accounting.active == 0) break;
                Thread.Sleep(50);
            } while (clock.Elapsed.TotalSeconds < 5);
            Require(accounting.active == 0, "Owned job still has active processes.");
            report[key] = new { active = accounting.active, total = accounting.total };
        } catch (Exception error) { errors.Add(error.Message); }
        finally {
            if (!CloseHandle(job)) errors.Add("Close owned job handle failed: " + Marshal.GetLastWin32Error());
        }
    }
    public static int Run(string executable, string script, string directory, string testCase, int timeout)
    {
        Guard();
        Require(testCase == "normal" || testCase == "failure" || testCase == "timeout", "Unknown probe case.");
        Require(timeout >= 1 && timeout <= 90, "Unbounded child timeout.");
        int result = 1;
        Exception unhandled = null;
        var thread = new Thread(() => {
            try { result = RunCore(executable, script, directory, testCase, timeout); }
            catch (Exception error) { unhandled = error; }
        });
        thread.Start();
        thread.Join();
        if (unhandled != null) throw unhandled;
        return result;
    }
    static IntPtr TokenData(IntPtr token, int kind)
    {
        GetTokenInformation(token, kind, IntPtr.Zero, 0, out int needed);
        if (needed <= 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Read owned token metadata class " + kind);
        Require(needed <= 4096, "Owned token metadata bound exceeded.");
        IntPtr data = Marshal.AllocHGlobal(needed);
        try {
            Win32(GetTokenInformation(token, kind, data, needed, out needed), "Read owned token metadata class " + kind);
            return data;
        } catch { Marshal.FreeHGlobal(data); throw; }
    }
    static int TokenIntegrity(IntPtr token)
    {
        IntPtr data = TokenData(token, 25);
        try {
            IntPtr sid = Marshal.ReadIntPtr(data);
            byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
            Require(count > 0, "Owned integrity SID unavailable.");
            return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)count - 1));
        } finally { Marshal.FreeHGlobal(data); }
    }
    static int TokenNumber(IntPtr token, int kind)
    {
        IntPtr data = TokenData(token, kind);
        try { return Marshal.ReadInt32(data); }
        finally { Marshal.FreeHGlobal(data); }
    }
    static List<SidAttributes> Groups(IntPtr data)
    {
        int count = Marshal.ReadInt32(data), offset = Marshal.OffsetOf<TokenGroups>("first").ToInt32();
        Require(count >= 0 && count <= 128, "Owned token group bound exceeded.");
        var groups = new List<SidAttributes>();
        for (int index = 0; index < count; index++)
            groups.Add(Marshal.PtrToStructure<SidAttributes>(IntPtr.Add(data, offset + index * Marshal.SizeOf<SidAttributes>())));
        return groups;
    }
    static Dictionary<long, uint> Privileges(IntPtr token)
    {
        IntPtr data = TokenData(token, 3);
        try {
            int count = Marshal.ReadInt32(data);
            Require(count >= 0 && count <= 128, "Owned token privilege bound exceeded.");
            var result = new Dictionary<long, uint>();
            for (int index = 0; index < count; index++)
                result.Add(Marshal.ReadInt64(data, 4 + index * 12), (uint)Marshal.ReadInt32(data, 12 + index * 12));
            return result;
        } finally { Marshal.FreeHGlobal(data); }
    }
    static IntPtr RestrictedMedium(IntPtr source)
    {
        Require(TokenNumber(source, 8) == 1, "Restricted derivation requires runner's own primary token.");
        IntPtr data = TokenData(source, 2), disabled = IntPtr.Zero, admin = IntPtr.Zero,
            medium = IntPtr.Zero, label = IntPtr.Zero, candidate = IntPtr.Zero;
        try {
            Win32(ConvertStringSidToSidW("S-1-5-32-544", out admin), "Create well-known administrator SID");
            var groups = Groups(data).FindAll(group => (group.attributes & 8) != 0 || EqualSid(group.sid, admin));
            Require(groups.Count > 0, "High runner token has no privileged group to disable.");
            disabled = Marshal.AllocHGlobal(groups.Count * Marshal.SizeOf<SidAttributes>());
            for (int index = 0; index < groups.Count; index++)
                Marshal.StructureToPtr(groups[index], IntPtr.Add(disabled, index * Marshal.SizeOf<SidAttributes>()), false);
            // DISABLE_MAX_PRIVILEGE only: never SANDBOX_INERT, new credentials, or privilege enablement.
            Win32(CreateRestrictedToken(source, 1, (uint)groups.Count, disabled, 0, IntPtr.Zero, 0, IntPtr.Zero, out candidate),
                "Derive restricted token from runner's own primary token");
            Win32(ConvertStringSidToSidW("S-1-16-8192", out medium), "Create well-known medium integrity SID");
            uint sidSize = GetLengthSid(medium);
            Require(sidSize > 0 && sidSize <= 256, "Medium integrity SID bound exceeded.");
            int labelSize = Marshal.SizeOf<SidAttributes>(), total = labelSize + (int)sidSize;
            label = Marshal.AllocHGlobal(total);
            var bytes = new byte[sidSize];
            Marshal.Copy(medium, bytes, 0, bytes.Length);
            Marshal.Copy(bytes, 0, IntPtr.Add(label, labelSize), bytes.Length);
            Marshal.StructureToPtr(new SidAttributes { sid = IntPtr.Add(label, labelSize), attributes = 0x20 }, label, false);
            Win32(SetTokenInformation(candidate, 25, label, (uint)total), "Lower derived token integrity to medium");
            return candidate;
        } catch {
            if (candidate != IntPtr.Zero) CloseHandle(candidate);
            throw;
        } finally {
            Marshal.FreeHGlobal(data);
            if (disabled != IntPtr.Zero) Marshal.FreeHGlobal(disabled);
            if (label != IntPtr.Zero) Marshal.FreeHGlobal(label);
            if (admin != IntPtr.Zero) LocalFree(admin);
            if (medium != IntPtr.Zero) LocalFree(medium);
        }
    }
    static object VerifyCaretToken(IntPtr source, IntPtr candidate, bool derived)
    {
        IntPtr original = TokenData(source, 1), user = IntPtr.Zero, sourceStats = IntPtr.Zero,
            candidateStats = IntPtr.Zero, groupData = IntPtr.Zero, admin = IntPtr.Zero;
        try {
            user = TokenData(candidate, 1);
            Require(EqualSid(Marshal.ReadIntPtr(original), Marshal.ReadIntPtr(user)), "Caret token user differs from runner.");
            sourceStats = TokenData(source, 10); candidateStats = TokenData(candidate, 10);
            Require(Marshal.ReadInt64(sourceStats, 8) == Marshal.ReadInt64(candidateStats, 8),
                "Caret token logon authentication identity changed.");
            Require(TokenNumber(source, 12) == TokenNumber(candidate, 12), "Caret token session changed.");
            Require(TokenNumber(candidate, 8) == 1 && TokenIntegrity(candidate) == 0x2000, "Caret token must be primary and medium.");
            Require(TokenNumber(candidate, 26) == 0 && TokenNumber(candidate, 26) <= TokenNumber(source, 26),
                "Caret token UIAccess was raised.");
            var before = Privileges(source);
            var after = Privileges(candidate);
            foreach (var privilege in after)
                Require(before.TryGetValue(privilege.Key, out uint attributes) &&
                    ((privilege.Value & 2) == 0 || (attributes & 2) != 0), "Caret token added or enabled a privilege.");
            Require(after.Count <= before.Count, "Caret token privilege count increased.");
            groupData = TokenData(candidate, 2);
            Win32(ConvertStringSidToSidW("S-1-5-32-544", out admin), "Create well-known administrator SID for verification");
            bool adminDenied = true;
            foreach (var group in Groups(groupData))
                if (EqualSid(group.sid, admin))
                    adminDenied = adminDenied && (group.attributes & 4) == 0 && (group.attributes & 0x10) != 0;
            Require(adminDenied, "Caret token retains an enabled administrator group.");
            bool filtered = TokenNumber(candidate, 21) != 0;
            Require(!derived || filtered, "Derived caret token has no filtered provenance.");
            return new { primary = true, integrity = 8192, sameUser = true, sameLogon = true, sameSession = true,
                adminDenyOnly = adminDenied, privilegesNotIncreased = true, parentPrivilegeCount = before.Count,
                privilegeCount = after.Count, uiAccess = 0, hasRestrictions = filtered };
        } finally {
            Marshal.FreeHGlobal(original);
            foreach (IntPtr value in new[] { user, sourceStats, candidateStats, groupData })
                if (value != IntPtr.Zero) Marshal.FreeHGlobal(value);
            if (admin != IntPtr.Zero) LocalFree(admin);
        }
    }
    public static int RunCaret(string executable, string script, string directory, string workingDirectory, int timeout,
        bool allowDerivedRestricted = false, bool useOwnRestrictedAsUser = false,
        Func<string, string, IntPtr, IntPtr, object> prepareOwnedLayout = null, bool diagnoseLoop = false)
    {
        Guard();
        Require(timeout == 180 && File.Exists(executable) && File.Exists(script), "Bounded caret executable/entry required.");
        Require(Environment.GetEnvironmentVariable("VI_CARET_TRUSTED_HEAD") == "true" &&
            Environment.GetEnvironmentVariable("GITHUB_REPOSITORY") == "jiec-msft/vi", "Caret exception requires a trusted own-repository CI head.");
        string entry = Path.GetFileName(script);
        Require((entry == "windows-caret-ui.cjs" || entry == "caret-app-root.cjs" || entry == "windows-caret-quiet.cjs") &&
            String.Equals(Path.GetFullPath(script), Path.GetFullPath(Path.Combine(workingDirectory, "scripts", entry)), StringComparison.OrdinalIgnoreCase) &&
            String.Equals(Path.GetFullPath(executable), Path.GetFullPath(Path.Combine(workingDirectory, "node_modules", "electron", "dist", "electron.exe")),
                StringComparison.OrdinalIgnoreCase), "Only the prepared own-head caret App/quiet fixture and Electron binary are allowed.");
        if (!useOwnRestrictedAsUser) Directory.CreateDirectory(directory);
        var clock = Stopwatch.StartNew();
        var errors = new List<string>();
        var report = new Dictionary<string, object> {
            ["sourceHead"] = Environment.GetEnvironmentVariable("VI_PROBE_HEAD"),
            ["runId"] = Environment.GetEnvironmentVariable("GITHUB_RUN_ID"),
            ["attempt"] = Environment.GetEnvironmentVariable("GITHUB_RUN_ATTEMPT"),
            ["scope"] = "same-user-medium-token-owned-job",
            ["callerPid"] = Environment.ProcessId
        };
        IntPtr job = IntPtr.Zero, ownToken = IntPtr.Zero, linked = IntPtr.Zero, childToken = IntPtr.Zero, restricted = IntPtr.Zero;
        ProcessInfo child = new ProcessInfo();
        bool attached = false;
        Dictionary<long, uint> parentPrivileges = null;
        string originalJobName = Environment.GetEnvironmentVariable("VI_CARET_JOB_NAME");
        int result = 1;
        try {
            Require(Name(GetProcessWindowStation()) == "WinSta0" && InputName() == "Default", "Ordinary Default desktop required.");
            using (var own = Process.GetCurrentProcess())
                Win32(OpenProcessToken(own.Handle, allowDerivedRestricted ? 0x8bU : 8U, out ownToken), "Read runner's own token");
            int originalIntegrity = TokenIntegrity(ownToken);
            parentPrivileges = Privileges(ownToken);
            Win32(LookupPrivilegeValueW(null, "SeIncreaseQuotaPrivilege", out long quota), "Read existing parent quota privilege identity");
            report["parentQuotaAlreadyEnabled"] = parentPrivileges.TryGetValue(quota, out uint quotaAttributes) && (quotaAttributes & 2) != 0;
            report["parentQuotaPresent"] = parentPrivileges.ContainsKey(quota);
            report["originalIntegrity"] = originalIntegrity;
            IntPtr launchToken = ownToken;
            report["tokenOrigin"] = "existing-medium";
            if (useOwnRestrictedAsUser) {
                Require(allowDerivedRestricted && originalIntegrity == 0x3000 && prepareOwnedLayout != null,
                    "Explicit AsUser fixture requires the verified own restricted primary and qualified layout.");
                if (!parentPrivileges.ContainsKey(quota)) throw new Win32Exception(1314, "Existing quota privilege is absent.");
                restricted = RestrictedMedium(ownToken);
                launchToken = restricted;
                report["tokenOrigin"] = "derived-restricted-medium";
                report["processApi"] = "CreateProcessAsUserW";
                report["parentQuotaDuringApi"] = "API-managed temporary use of existing privilege may occur; not sampled during call";
                report["parentQuotaWasDisabled"] = (quotaAttributes & 2) == 0;
            } else if (originalIntegrity != 0x2000) {
                Require(originalIntegrity == 0x3000, "Unknown runner integrity; refusing a token transition.");
                try {
                    IntPtr data = TokenData(ownToken, 19);
                    try { linked = Marshal.ReadIntPtr(data); }
                    finally { Marshal.FreeHGlobal(data); }
                    Require(linked != IntPtr.Zero, "Runner has no linked filtered token.");
                    launchToken = linked;
                    report["tokenOrigin"] = "linked-filtered-medium";
                } catch (Win32Exception error) when (error.NativeErrorCode == 1312 && allowDerivedRestricted) {
                    report["linkedTokenUnavailableCode"] = 1312;
                    restricted = RestrictedMedium(ownToken);
                    launchToken = restricted;
                    report["tokenOrigin"] = "derived-restricted-medium";
                }
            }
            report["launchTokenVerification"] = VerifyCaretToken(ownToken, launchToken, restricted != IntPtr.Zero);
            report["launchIntegrity"] = TokenIntegrity(launchToken);
            report["sameUserTokenVerified"] = true;
            report["privilegesEnabledByLauncher"] = false;
            if (useOwnRestrictedAsUser) report["ownedLayoutVerification"] = prepareOwnedLayout(workingDirectory, directory, ownToken, launchToken);
            string jobName = "vi-ci-caret-" + Environment.GetEnvironmentVariable("GITHUB_RUN_ID") + "-" + Guid.NewGuid().ToString("N");
            job = NewJob(jobName);
            Environment.SetEnvironmentVariable("VI_CARET_JOB_NAME", jobName);
            report["specificJobName"] = jobName;
            var startup = new StartupInfo { cb = (uint)Marshal.SizeOf<StartupInfo>(), desktop = @"WinSta0\Default" };
            var command = new StringBuilder(Quote(executable) + " " + Quote(script));
            if (useOwnRestrictedAsUser) {
                string profileDirectory = Path.Combine(workingDirectory, "artifacts-ci", "caret", "profile");
                command.Append(" " + Quote("--user-data-dir=" + profileDirectory));
                report["earlyProfileSwitch"] = true;
                report["entryRole"] = entry == "caret-app-root.cjs" ? "actual-app-root"
                    : entry == "windows-caret-ui.cjs" ? "caret-controller" : "quiet-exit";
                report["workingDirectoryRole"] = "owned-checkout";
                report["runAsNodeEnvironmentPresent"] = Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE") != null;
                report["runAsNodeEnvironmentEnabled"] = !String.IsNullOrEmpty(Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE"));
                if (diagnoseLoop) command.Append(" --ci-caret-loop-diagnostic");
            }
            if (!useOwnRestrictedAsUser && launchToken != ownToken) {
                Win32(LookupPrivilegeValueW(null, "SeImpersonatePrivilege", out long impersonate), "Read required parent privilege identity");
                if (!parentPrivileges.TryGetValue(impersonate, out uint attributes) || (attributes & 2) == 0)
                    throw new Win32Exception(1314, "CreateProcessWithTokenW requires already-enabled parent SeImpersonatePrivilege; no enablement is allowed.");
                report["requiredParentPrivilegeAlreadyEnabled"] = true;
            }
            bool started = useOwnRestrictedAsUser
                ? CreateProcessAsUserW(launchToken, executable, command, IntPtr.Zero, IntPtr.Zero, false,
                    SuspendedNoWindow, IntPtr.Zero, workingDirectory, ref startup, out child)
                : launchToken == ownToken
                ? CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, false, SuspendedNoWindow, IntPtr.Zero,
                    workingDirectory, ref startup, out child)
                : CreateProcessWithTokenW(launchToken, 0, executable, command, SuspendedNoWindow, IntPtr.Zero,
                    workingDirectory, ref startup, out child);
            int startError = started ? 0 : Marshal.GetLastWin32Error();
            if (useOwnRestrictedAsUser) {
                var afterCall = Privileges(ownToken);
                bool restored = afterCall.Count == parentPrivileges.Count;
                foreach (var privilege in afterCall)
                    restored = restored && parentPrivileges.TryGetValue(privilege.Key, out uint attributes) && attributes == privilege.Value;
                report["parentPrivilegeAttributesRestoredAtApiReturn"] = restored;
                Require(restored, "Parent privilege attributes were not restored at API return; root must remain suspended.");
            }
            if (!started) throw new Win32Exception(startError, "Start own medium caret fixture");
            Win32(AssignProcessToJobObject(job, child.process), "Assign suspended caret root to its owned Job");
            attached = true;
            Win32(IsProcessInJob(child.process, job, out bool member), "Verify caret specific Job membership");
            Require(member, "Caret root is not in its owned Job.");
            Win32(OpenProcessToken(child.process, 8, out childToken), "Read suspended caret root token");
            Require(TokenIntegrity(childToken) == 0x2000, "Caret root did not receive medium integrity.");
            report["rootTokenVerification"] = VerifyCaretToken(ownToken, childToken, restricted != IntPtr.Zero);
            IntPtr ownUser = TokenData(ownToken, 1), childUser = IntPtr.Zero;
            try {
                childUser = TokenData(childToken, 1);
                Require(EqualSid(Marshal.ReadIntPtr(ownUser), Marshal.ReadIntPtr(childUser)), "Caret root user differs from runner.");
            } finally {
                Marshal.FreeHGlobal(ownUser);
                if (childUser != IntPtr.Zero) Marshal.FreeHGlobal(childUser);
            }
            Win32(ProcessIdToSessionId((uint)Environment.ProcessId, out uint ownSession), "Read runner session");
            Win32(ProcessIdToSessionId(child.pid, out uint rootSession), "Read suspended caret root session");
            Require(rootSession == ownSession, "Caret root session differs from runner.");
            var image = new StringBuilder(32768);
            uint imageLength = (uint)image.Capacity;
            Win32(QueryFullProcessImageNameW(child.process, 0, image, ref imageLength), "Read suspended caret root binary path");
            Require(String.Equals(Path.GetFullPath(image.ToString()), Path.GetFullPath(executable), StringComparison.OrdinalIgnoreCase),
                "Caret root binary path differs from the prepared Electron binary.");
            Win32(GetProcessTimes(child.process, out long created, out long exited, out long kernel, out long user),
                "Read caret root creation identity");
            report["rootPid"] = child.pid;
            report["rootCreationFileTime"] = created.ToString();
            report["specificJobMember"] = member;
            report["rootIntegrity"] = TokenIntegrity(childToken);
            report["rootSession"] = rootSession;
            report["rootUserVerified"] = true;
            report["exactBinaryPathVerified"] = true;
            report["suspendedAttachBeforeResume"] = true;
            Win32(ResumeThread(child.thread) != UInt32.MaxValue, "Resume owned caret root");
            try { report["ownedProcessObservations"] = CaretProcessObservation(job, child.pid); }
            catch { report["ownedProcessObservationFailure"] = "owned-observer-unavailable"; }
            uint wait;
            if (diagnoseLoop) {
                var samples = new List<object>();
                report["loopDiagnosticSnapshots"] = samples;
                var diagnosticClock = Stopwatch.StartNew();
                do {
                    wait = WaitForSingleObject(child.process, 3000);
                    bool cpuObserved = GetProcessTimes(child.process, out long sampleCreated, out long sampleExited, out long sampleKernel, out long sampleUser);
                    int cpuError = cpuObserved ? 0 : Marshal.GetLastWin32Error();
                    string trace = Path.Combine(workingDirectory, "artifacts-ci", "caret", "bootstrap.jsonl");
                    string lastStage = "unavailable";
                    int heartbeatCount = 0;
                    bool observedTrace = false;
                    try {
                        var info = new FileInfo(trace);
                        if (info.Exists && info.Length <= 65536) {
                            foreach (string line in File.ReadLines(trace)) {
                                using (var json = JsonDocument.Parse(line)) {
                                    var row = json.RootElement;
                                    if (row.GetProperty("pid").GetUInt32() != child.pid) continue;
                                    string stage = row.GetProperty("stage").GetString();
                                    if (stage == "main-loop-heartbeat") heartbeatCount++;
                                    else if (Regex.IsMatch(stage ?? "", "^[a-z-]{1,40}$")) lastStage = stage;
                                }
                            }
                            observedTrace = true;
                        }
                    } catch { lastStage = "owned-trace-unavailable"; }
                    samples.Add(new { elapsedMs = diagnosticClock.ElapsedMilliseconds, pid = child.pid, waitState = wait,
                        processCpuObserved = cpuObserved, processCpuMs = cpuObserved ? (sampleKernel + sampleUser) / 10000 : -1,
                        cpuWin32Error = cpuError, heartbeatCount, lastStage, observedTrace });
                } while (wait == WaitTimeout && diagnosticClock.Elapsed.TotalSeconds < 15);
                report["loopDiagnosticDeadlineSeconds"] = 15;
            } else wait = WaitForSingleObject(child.process, (uint)timeout * 1000);
            Require(wait == 0, wait == WaitTimeout
                ? diagnoseLoop ? "Owned controller liveness diagnostic reached its 15-second deadline." : "Caret App fixture exceeded its 180-second internal watchdog."
                : "Caret root wait failed.");
            Win32(GetExitCodeProcess(child.process, out uint exitCode), "Read caret root raw exit");
            report["rawExitCode"] = exitCode;
            Require(exitCode == 0, "Caret App fixture exited " + exitCode + ".");
            result = 0;
        } catch (Exception error) {
            errors.Add(error.Message);
            report["failure"] = new { type = error.GetType().Name,
                win32Error = error is Win32Exception native ? native.NativeErrorCode : 0 };
        }
        finally {
            if (child.process != IntPtr.Zero && !attached) {
                bool terminated = TerminateProcess(child.process, 92) && WaitForSingleObject(child.process, 5000) == 0;
                report["unattachedRootTerminated"] = terminated;
                if (!terminated) errors.Add("Unattached owned caret root cleanup failed.");
            }
            if (attached && job != IntPtr.Zero) {
                try { report["ownedProcessesBeforeCleanup"] = CaretProcessObservation(job, child.pid); }
                catch { report["ownedProcessObservationFailure"] = "owned-observer-unavailable"; }
            }
            CleanupJob(job, errors, report, "ownedJobCleanup");
            Environment.SetEnvironmentVariable("VI_CARET_JOB_NAME", originalJobName);
            if (parentPrivileges != null && ownToken != IntPtr.Zero) {
                try {
                    var after = Privileges(ownToken);
                    bool unchanged = after.Count == parentPrivileges.Count;
                    foreach (var privilege in after)
                        unchanged = unchanged && parentPrivileges.TryGetValue(privilege.Key, out uint attributes) &&
                            (attributes & 3) == (privilege.Value & 3);
                    report["parentPrivilegesUnchanged"] = unchanged;
                    Require(unchanged, "Caret launch changed parent privilege state.");
                } catch (Exception error) { errors.Add(error.Message); }
            }
            foreach (IntPtr token in new[] { childToken, restricted, linked, ownToken })
                if (token != IntPtr.Zero && !CloseHandle(token)) errors.Add("Owned token handle cleanup failed.");
            if (child.thread != IntPtr.Zero && !CloseHandle(child.thread)) errors.Add("Caret root thread handle cleanup failed.");
            if (child.process != IntPtr.Zero && !CloseHandle(child.process)) errors.Add("Caret root process handle cleanup failed.");
            try {
                report["originalDefaultUnchanged"] = InputName() == "Default";
                Require((bool)report["originalDefaultUnchanged"], "Input desktop changed during caret integration.");
            } catch (Exception error) { errors.Add(error.Message); }
            report["executionSeconds"] = clock.Elapsed.TotalSeconds;
            report["errors"] = errors;
            report["passed"] = result == 0 && errors.Count == 0;
            if (!Directory.Exists(directory)) Directory.CreateDirectory(directory);
            Write(directory, "caret-launch.json", report);
        }
        return result == 0 && errors.Count == 0 ? 0 : 1;
    }
    static object CaretProcessObservation(IntPtr job, uint root)
    {
        const int capacity = 32;
        IntPtr buffer = Marshal.AllocHGlobal(8 + capacity * IntPtr.Size);
        var rows = new List<object>();
        try {
            if (!QueryJobProcesses(job, 3, buffer, (uint)(8 + capacity * IntPtr.Size), IntPtr.Zero))
                return new { observed = false, win32Error = Marshal.GetLastWin32Error(), processes = rows };
            int count = Marshal.ReadInt32(buffer, 4);
            if (count < 0 || count > capacity) return new { observed = false, win32Error = 0, processes = rows };
            for (int index = 0; index < count; index++) {
                uint pid = (uint)Marshal.ReadIntPtr(buffer, 8 + index * IntPtr.Size).ToInt64();
                IntPtr process = OpenProcess(0x1000, false, pid);
                if (process == IntPtr.Zero) { rows.Add(new { pid, observed = false, win32Error = Marshal.GetLastWin32Error() }); continue; }
                try {
                    bool member;
                    long created, exited, kernel, user;
                    var image = new StringBuilder(32768);
                    uint length = (uint)image.Capacity;
                    if (!IsProcessInJob(process, job, out member) || !member ||
                        !GetProcessTimes(process, out created, out exited, out kernel, out user) ||
                        !QueryFullProcessImageNameW(process, 0, image, ref length)) {
                        rows.Add(new { pid, observed = false, win32Error = Marshal.GetLastWin32Error() }); continue;
                    }
                    string name = Path.GetFileName(image.ToString()).ToLowerInvariant();
                    string role = pid == root ? "electron-root" : name == "electron.exe" ? "electron-child"
                        : name == "crashpad_handler.exe" ? "crash-handler" : name == "werfault.exe" ? "error-handler" : "other-owned-child";
                    rows.Add(new { pid, role, creationFileTime = created.ToString(), live = exited == 0, specificJobMember = member });
                } finally { CloseHandle(process); }
            }
            return new { observed = true, win32Error = 0, processes = rows };
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    public static int RunHarness(string executable, string sentinel, string script, string directory,
        string entry, string workingDirectory, int timeout, bool timeoutProbe, bool earlyRecovery)
    {
        Guard();
        Require(entry == "overlay" || entry == "release-negative", "Unsupported integration entry.");
        Require(timeout >= 1 && timeout <= (entry == "overlay" ? 150 : 60), "Integration wall deadline exceeds the existing harness limit.");
        Require(!timeoutProbe || (entry == "overlay" && timeout == 35), "Timeout witness requires the finite overlay entry/deadline.");
        Require(!earlyRecovery || (entry == "overlay" && !timeoutProbe), "Early recovery witness requires the normal overlay entry.");
        int result = 1;
        Exception unhandled = null;
        var thread = new Thread(() => {
            try { result = RunCore(executable, sentinel, directory, "normal", timeout, entry, script, workingDirectory, timeoutProbe, earlyRecovery); }
            catch (Exception error) { unhandled = error; }
        });
        thread.Start(); thread.Join();
        if (unhandled != null) throw unhandled;
        return result;
    }
    static int RunCore(string executable, string script, string directory, string testCase, int timeout,
        string entry = "probe", string harness = null, string workingDirectory = null, bool timeoutProbe = false, bool earlyRecovery = false)
    {
        var clock = Stopwatch.StartNew();
        var errors = new List<string>();
        var report = new Dictionary<string, object> {
            ["case"] = testCase, ["runId"] = Environment.GetEnvironmentVariable("GITHUB_RUN_ID"),
            ["attempt"] = Environment.GetEnvironmentVariable("GITHUB_RUN_ATTEMPT"),
            ["mergeSha"] = Environment.GetEnvironmentVariable("GITHUB_SHA"),
            ["headSha"] = Environment.GetEnvironmentVariable("VI_PROBE_HEAD"),
            ["arch"] = RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(),
            ["windowsVersion"] = Environment.OSVersion.Version.ToString(),
            ["desktopFlags"] = 0, ["desktopAccess"] = DesktopAccess,
            ["inheritHandles"] = false, ["security"] = "inherited-window-station-ACL",
            ["scope"] = "ordinary-hosted-CI-desktop-not-a-security-sandbox",
            ["controllerPid"] = Environment.ProcessId
        };
        IntPtr original = IntPtr.Zero, owned = IntPtr.Zero, defaultJob = IntPtr.Zero, ownedJob = IntPtr.Zero;
        IntPtr initialThread = IntPtr.Zero;
        ProcessInfo background = new ProcessInfo(), child = new ProcessInfo();
        string originalName = null;
        string ownedName = "vi-ci-" + Environment.GetEnvironmentVariable("GITHUB_RUN_ID") + "-" +
            Environment.GetEnvironmentVariable("GITHUB_RUN_ATTEMPT") + "-" + Guid.NewGuid().ToString("N");
        bool restored = false;
        Stopwatch rootClock = null;
        var descendantDesktops = new Dictionary<string, DesktopObservation>();
        var defaultHeartbeatSamples = new List<object>();
        if (entry != "probe") {
            report["defaultHeartbeatSamples"] = defaultHeartbeatSamples;
            report["rootWallLimitSeconds"] = timeout;
        }
        ImmutableHeartbeatReader heartbeatReader = null;
        double lastHeartbeatSampleSeconds = -1;
        try {
            Require(Equal(Name(GetProcessWindowStation()), "WinSta0"), "Only WinSta0 is supported.");
            initialThread = GetThreadDesktop(GetCurrentThreadId());
            original = OpenInputDesktop(0, false, ReadSwitch);
            Win32(original != IntPtr.Zero, "Open original input desktop");
            originalName = Name(original);
            report["originalDesktop"] = originalName;
            report["ownedDesktop"] = ownedName;
            Require(Equal(originalName, "Default") && Equal(Name(initialThread), originalName),
                "Refusing a non-default original input/thread desktop.");
            report["initialControllerThreadDesktop"] = Name(initialThread);
            IntPtr collision = OpenDesktopW(ownedName, 0, false, ReadSwitch);
            if (collision != IntPtr.Zero) {
                Win32(CloseDesktop(collision), "Close colliding desktop");
                throw new InvalidOperationException("Random desktop name already exists.");
            }
            Require(Marshal.GetLastWin32Error() == 2, "Desktop absence could not be verified.");
            owned = CreateDesktopW(ownedName, IntPtr.Zero, IntPtr.Zero, 0, DesktopAccess, IntPtr.Zero);
            Win32(owned != IntPtr.Zero, "Create ordinary owned desktop");
            Require(Equal(Name(owned), ownedName), "Owned desktop identity mismatch.");
            UserFlags actualFlags;
            uint needed;
            Win32(GetUserFlags(owned, 1, out actualFlags, (uint)Marshal.SizeOf<UserFlags>(), out needed), "Read owned desktop flags");
            Require(actualFlags.inherit == 0 && actualFlags.flags == 0, "Owned desktop unexpectedly inheritable or cross-account hooks allowed.");
            report["actualDesktopFlags"] = actualFlags.flags;
            report["actualHandleInheritable"] = actualFlags.inherit != 0;
            report["controllerThreadDesktop"] = Name(GetThreadDesktop(GetCurrentThreadId()));
            report["controllerThreadQuery"] = ReadThreadDesktop((uint)Environment.ProcessId, GetCurrentThreadId(),
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            defaultJob = NewJob();
            string defaultDirectory = Path.Combine(directory, "default");
            Directory.CreateDirectory(defaultDirectory);
            background = Start(defaultJob, executable, script, defaultDirectory, originalName, "default", testCase,
                "probe", workingDirectory, immutableHeartbeatLimit: entry == "probe" ? 0 : (20 + timeout + 10) * 4);
            if (entry != "probe") {
                Win32(GetProcessTimes(background.process, out long created, out long exited, out long kernel, out long user),
                    "Read live Default fixture creation identity");
                heartbeatReader = new ImmutableHeartbeatReader(defaultDirectory, background.pid, created.ToString(), 1,
                    (20 + timeout + 10) * 4);
                report["defaultHeartbeatIdentity"] = new { protocol = HeartbeatProtocol, pid = background.pid,
                    creationFileTime = created.ToString(), generation = 1, frameLimit = heartbeatReader.limit,
                    cadenceMilliseconds = 250,
                    lifetimeBound = "existing-default-ready20-root-inclusive-deadline-and-job-cleanup10" };
            }
            WaitReady(background, Path.Combine(defaultDirectory, "ready.json"), 20);
            Require(VisibleWindows(original, background.pid) > 0, "Owned default fixture has no visible window.");
            if (entry != "probe") defaultHeartbeatSamples.Add(ReadDefaultHeartbeat(background, defaultJob, original,
                heartbeatReader, "before-owned-root", null));
            ownedJob = NewJob();
            Require(entry == "probe" || !File.Exists(Path.Combine(directory, "ready.json")), "Stale harness readiness receipt refused.");
            rootClock = Stopwatch.StartNew();
            child = Start(ownedJob, executable, entry == "probe" ? script : harness, directory, ownedName, "owned", testCase,
                entry, workingDirectory, timeoutProbe, earlyRecovery);
            report["entry"] = entry;
            report["workingDirectory"] = workingDirectory ?? Environment.CurrentDirectory;
            report["ownedPid"] = child.pid;
            report["defaultPid"] = background.pid;
            Require(Equal(InputName(), originalName), "External input desktop changed before switch; refusing.");
            Win32(SwitchDesktop(owned), "Switch to ordinary owned desktop");
            Require(Equal(InputName(), ownedName), "Owned input desktop switch readback failed.");
            if (entry != "probe") {
                Win32(SetThreadDesktop(owned), "Connect the fresh harness observer thread to its ordinary desktop");
                report["harnessObserverThreadDesktop"] = Name(GetThreadDesktop(GetCurrentThreadId()));
                Require(Equal((string)report["harnessObserverThreadDesktop"], ownedName), "Harness observer thread desktop readback failed.");
            }
            double readyBudget = entry == "probe" ? 20 : Math.Min(entry == "overlay" ? 35 : 15, timeout - rootClock.Elapsed.TotalSeconds);
            Require(readyBudget > 0, "Root inclusive wall deadline expired before readiness.");
            Action observe = entry == "probe" ? null : (Action)(() => {
                Require(Equal(InputName(), ownedName), "Input desktop changed during root readiness.");
                if (rootClock.Elapsed.TotalSeconds - lastHeartbeatSampleSeconds >= 1) {
                    Require(defaultHeartbeatSamples.Count < 180, "Default heartbeat diagnostic sample bound exceeded.");
                    lastHeartbeatSampleSeconds = rootClock.Elapsed.TotalSeconds;
                    defaultHeartbeatSamples.Add(ReadDefaultHeartbeat(background, defaultJob, original,
                        heartbeatReader, "owned-root-running", lastHeartbeatSampleSeconds));
                }
                ObserveJobDesktops(ownedJob, ownedName, directory, descendantDesktops);
            });
            WaitReady(child, Path.Combine(directory, "ready.json"), readyBudget, observe);
            if (entry != "probe") {
                Require(rootClock.Elapsed.TotalSeconds < timeout, "Root inclusive wall deadline expired during readiness.");
                var windows = new List<object>();
                report["rootWindowObservations"] = windows;
                ValidateHarnessReady(child, Path.Combine(directory, "ready.json"), ownedName, owned, windows, report);
                report["rootWindowsVerified"] = true;
            }
            Require(VisibleWindows(owned, child.pid) > 0 && VisibleWindows(owned, background.pid) == 0,
                "Owned/default window desktop separation failed.");
            report["windowSeparation"] = true;
            uint state;
            var childClock = entry == "probe" ? Stopwatch.StartNew() : rootClock;
            do {
                Require(Equal(InputName(), ownedName), "External input desktop changed during probe; refusing.");
                if (observe != null) observe();
                state = WaitForSingleObject(child.process, 100);
                Require(state == 0 || state == WaitTimeout, "Child wait failed.");
            } while (state == WaitTimeout && childClock.Elapsed.TotalSeconds < timeout);
            report["rootWallSeconds"] = rootClock.Elapsed.TotalSeconds;
            if (state == WaitTimeout) {
                report["childOutcome"] = "timeout";
                errors.Add("Owned child timed out.");
            } else {
                uint code;
                Win32(GetExitCodeProcess(child.process, out code), "Read owned child exit");
                report["childExitCode"] = code;
                report["childOutcome"] = "exit";
                if (code != 0) errors.Add("Owned child failed with exit code " + code + ".");
            }
            Require(WaitForSingleObject(background.process, 0) == WaitTimeout &&
                VisibleWindows(original, background.pid) > 0, "Owned default fixture did not stay running.");
            report["defaultFixtureStayedAlive"] = true;
            if (entry == "probe") {
                using (var heartbeat = JsonDocument.Parse(File.ReadAllText(Path.Combine(directory, "default", "heartbeat.json")))) {
                    Require(heartbeat.RootElement.GetProperty("pid").GetUInt32() == background.pid &&
                        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - heartbeat.RootElement.GetProperty("time").GetInt64() < 3000,
                        "Default desktop owned fixture heartbeat is stale.");
                }
            } else {
                var finalHeartbeat = ReadDefaultHeartbeat(background, defaultJob, original, heartbeatReader,
                    "root-outcome-freshness-check", rootClock.Elapsed.TotalSeconds);
                report["defaultHeartbeatCheck"] = finalHeartbeat;
                defaultHeartbeatSamples.Add(finalHeartbeat);
                Require((string)finalHeartbeat["heartbeatStatus"] == "read-immutable-frame" &&
                    IsDefaultHeartbeatFresh(background.pid, (uint)finalHeartbeat["heartbeatPid"],
                        (long)finalHeartbeat["heartbeatAt"], (long)finalHeartbeat["sampleAt"]) &&
                    (uint)finalHeartbeat["liveCheckWaitState"] == WaitTimeout &&
                    (int)finalHeartbeat["visibleWindowCount"] > 0,
                    "Default desktop owned fixture heartbeat is stale: " + JsonSerializer.Serialize(finalHeartbeat));
            }
            report["defaultFixtureHeartbeatFresh"] = true;
        } catch (Exception error) { errors.Add(error.Message); }
        finally {
            if (original != IntPtr.Zero && originalName != null) {
                try {
                    string active = InputName();
                    string decision = RestoreDecision(active, originalName, ownedName);
                    report["cleanupInputDesktop"] = active;
                    report["restoreDecision"] = decision;
                    Require(decision != "refuse", "External input desktop changed; refusing to overwrite it during cleanup.");
                    if (decision == "restore") Win32(SwitchDesktop(original), "Restore original input desktop");
                    restored = Equal(InputName(), originalName);
                    Require(restored, "Original input desktop restore readback failed.");
                    if (entry != "probe" && background.process != IntPtr.Zero && heartbeatReader != null)
                        defaultHeartbeatSamples.Add(ReadDefaultHeartbeat(background, defaultJob, original, heartbeatReader,
                            "after-original-restore-before-job-cleanup", rootClock?.Elapsed.TotalSeconds));
                } catch (Exception error) { errors.Add(error.Message); }
            }
            CleanupJob(ownedJob, errors, report, "ownedJobCleanup");
            CleanupJob(defaultJob, errors, report, "defaultJobCleanup");
            bool processHandlesClosed = true;
            foreach (var process in new[] { child, background }) {
                if (process.process != IntPtr.Zero) {
                    if (WaitForSingleObject(process.process, 5000) != 0)
                        errors.Add("Owned process did not signal exit after job cleanup.");
                    if (entry != "probe" && process.pid == background.pid) {
                        bool read = GetProcessTimes(process.process, out long created, out long exited, out long kernel, out long user);
                        int error = read ? 0 : Marshal.GetLastWin32Error();
                        report["defaultFixtureExit"] = new { pid = process.pid, processTimesRead = read,
                            processTimesError = error, creationFileTime = read ? created.ToString() : null,
                            exitFileTime = read ? exited.ToString() : null,
                            exitedAt = read && exited > 0
                                ? (object)new DateTimeOffset(DateTime.FromFileTimeUtc(exited)).ToUnixTimeMilliseconds() : null,
                            observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
                        if (!read || exited == 0) errors.Add("Default fixture actual exit-time readback failed: " + error);
                    }
                    if (!CloseHandle(process.process)) {
                        processHandlesClosed = false;
                        errors.Add("Close owned process handle failed: " + Marshal.GetLastWin32Error());
                    }
                }
            }
            report["processHandlesClosed"] = processHandlesClosed;
            // GetThreadDesktop is borrowed; detach the fresh controller thread before closing created handles.
            if (initialThread != IntPtr.Zero && !SetThreadDesktop(initialThread))
                errors.Add("Restore controller thread desktop failed: " + Marshal.GetLastWin32Error());
            if (entry != "probe") {
                var query = ReadThreadDesktop((uint)Environment.ProcessId, GetCurrentThreadId(),
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                report["restoredControllerThreadQuery"] = query;
                if (query.status != "observed" || !Equal(query.threadDesktop, originalName))
                    errors.Add("Restored controller executing-thread desktop readback failed.");
            }
            bool handlesClosed = true;
            foreach (IntPtr desktop in new[] { owned, original }) {
                if (desktop != IntPtr.Zero && !CloseDesktop(desktop)) {
                    handlesClosed = false;
                    errors.Add("Close desktop handle failed: " + Marshal.GetLastWin32Error());
                }
            }
            report["desktopHandlesClosed"] = handlesClosed;
            if (owned != IntPtr.Zero && handlesClosed) {
                // USER window teardown can outlast job accounting and process exit.
                var removalClock = Stopwatch.StartNew();
                bool removed = false;
                do {
                    IntPtr remaining = OpenDesktopW(ownedName, 0, false, ReadSwitch);
                    int lastError = Marshal.GetLastWin32Error();
                    if (remaining == IntPtr.Zero) {
                        if (lastError == 2) removed = true;
                        else errors.Add("Owned desktop disappearance readback failed: " + lastError);
                        break;
                    }
                    if (!CloseDesktop(remaining)) {
                        errors.Add("Close remaining desktop readback failed.");
                        break;
                    }
                    Thread.Sleep(100);
                } while (removalClock.Elapsed.TotalSeconds < 5);
                report["ownedDesktopRemovalSeconds"] = removalClock.Elapsed.TotalSeconds;
                report["ownedDesktopRemoved"] = removed;
                if (!removed) errors.Add("Owned desktop still exists after bounded cleanup readback.");
            }
            report["originalRestored"] = restored;
            report["descendantDesktopObservations"] = descendantDesktops.Values;
            if (entry != "probe" && report.TryGetValue("childOutcome", out var outcome) && (string)outcome == "timeout")
                report["heldInputCleanupScope"] = "root did not complete; held authority/release unknown, not a successful gesture-cleanup proof";
            report["elapsedSeconds"] = clock.Elapsed.TotalSeconds;
            report["errors"] = errors;
            report["passed"] = errors.Count == 0;
            Write(directory, "report.json", report);
        }
        return errors.Count == 0 ? 0 : 1;
    }
    public static void Input(string desktop, uint target, int x, int y, string directory)
    {
        Guard();
        Require(desktop != null && desktop.StartsWith("vi-ci-", StringComparison.Ordinal) && target > 0, "Owned desktop/PID required.");
        string station = Name(GetProcessWindowStation());
        string thread = Name(GetThreadDesktop(GetCurrentThreadId()));
        string active = InputName();
        Write(directory, "input-before.json", new { station, threadDesktop = thread, inputDesktop = active, pid = Environment.ProcessId, target });
        Require(Equal(station, "WinSta0") && Equal(thread, desktop) && Equal(active, desktop),
            "Native mouse child did not inherit the active owned desktop.");
        Require(VisibleWindows(GetThreadDesktop(GetCurrentThreadId()), target) > 0, "Target owned window is not visible.");
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
        int width = GetSystemMetrics(78), height = GetSystemMetrics(79);
        Require(width > 1 && height > 1 && x >= left && x < left + width && y >= top && y < top + height,
            "Mouse point outside virtual screen.");
        var move = new InputEvent { mouse = new MouseInput {
            x = (int)Math.Round((x - left) * 65535.0 / (width - 1)),
            y = (int)Math.Round((y - top) * 65535.0 / (height - 1)), flags = 0xC001 } };
        Require(Equal(InputName(), desktop), "Input desktop changed before mouse movement.");
        Win32(SendInput(1, new[] { move }, Marshal.SizeOf<InputEvent>()) == 1, "SendInput absolute mouse move");
        Thread.Sleep(100);
        Require(Equal(InputName(), desktop), "Input desktop changed before mouse click.");
        var click = new[] {
            new InputEvent { mouse = new MouseInput { flags = 0x0002 } },
            new InputEvent { mouse = new MouseInput { flags = 0x0004 } }
        };
        Win32(SendInput(2, click, Marshal.SizeOf<InputEvent>()) == 2, "SendInput mouse click");
        Thread.Sleep(150);
        uint foreground;
        GetWindowThreadProcessId(GetForegroundWindow(), out foreground);
        Require(foreground == target && Equal(InputName(), desktop), "Real mouse did not foreground the owned target.");
        Write(directory, "input-after.json", new { station, threadDesktop = thread, inputDesktop = InputName(),
            pid = Environment.ProcessId, target, foregroundPid = foreground, sentInputEvents = 3 });
    }
}
