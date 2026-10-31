using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;

// Ordinary WinSta0 desktops only. API contracts:
// https://learn.microsoft.com/windows/win32/winstation/thread-connection-to-a-desktop
// https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-createdesktopw
// https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-switchdesktop
// https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-closedesktop
public static class ViCiDesktop
{
    const uint DesktopAccess = 0x01C7; // READ/WRITEOBJECTS, CREATEWINDOW/MENU, ENUMERATE, SWITCHDESKTOP
    const uint ReadSwitch = 0x0141;
    const uint SuspendedNoWindow = 0x08000004;
    const uint WaitTimeout = 258;

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
    static IntPtr NewJob()
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
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
        string entry = "probe", string workingDirectory = null, bool timeoutProbe = false, bool earlyRecovery = false)
    {
        var startup = new StartupInfo { cb = (uint)Marshal.SizeOf<StartupInfo>(), desktop = "WinSta0\\" + desktop };
        string arguments = entry == "probe"
            ? " --desktop-probe-role=" + role + " --desktop-probe-case=" + testCase +
                " " + Quote("--desktop-probe-output=" + directory) + " --desktop-probe-name=" + desktop
            : " --ci-mode=" + (entry == "overlay" ? "overlay-recovery" : "release-negative") +
                " --ci-owned-desktop=" + desktop + " " + Quote("--ci-desktop-receipt=" + directory) +
                (timeoutProbe ? " --ci-desktop-timeout-probe" : "") +
                (earlyRecovery ? " --ci-startup-recovery-probe" : "");
        var command = new StringBuilder(Quote(executable) + " " + Quote(script) + arguments);
        ProcessInfo child;
        Win32(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, false,
            SuspendedNoWindow, IntPtr.Zero, workingDirectory ?? Environment.CurrentDirectory, ref startup, out child), "Create owned suspended child");
        try {
            Win32(AssignProcessToJobObject(job, child.process), "Assign owned child to job");
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
        using (var json = JsonDocument.Parse(File.ReadAllText(receipt))) {
            Require(json.RootElement.GetProperty("pid").GetUInt32() == child.pid, "Fixture readiness PID mismatch.");
        }
    }
    static Dictionary<string, object> ReadDefaultHeartbeat(ProcessInfo fixture, IntPtr job, IntPtr desktop,
        string directory, string phase, double? rootElapsedSeconds)
    {
        var sample = new Dictionary<string, object> {
            ["phase"] = phase, ["pid"] = fixture.pid, ["role"] = "default-fixture",
            ["generation"] = 1, ["coverage"] = "specific-default-job-process-and-heartbeat-not-thread-desktop",
            ["sampleStartedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["sampleStartedTicks"] = Stopwatch.GetTimestamp().ToString(),
            ["monotonicClock"] = "native-wrapper-Stopwatch-not-fixture-Node-clock",
            ["monotonicFrequency"] = Stopwatch.Frequency.ToString(),
            ["heartbeatClock"] = "fixture-Node-Date.now",
            ["rootElapsedSeconds"] = rootElapsedSeconds, ["freshnessLimitMilliseconds"] = 3000
        };
        string file = Path.Combine(directory, "default", "heartbeat.json");
        if (File.Exists(file)) {
            using (var heartbeat = JsonDocument.Parse(File.ReadAllText(file))) {
                long at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                long heartbeatAt = heartbeat.RootElement.GetProperty("time").GetInt64();
                sample["heartbeatPid"] = heartbeat.RootElement.GetProperty("pid").GetUInt32();
                sample["heartbeatAt"] = heartbeatAt;
                sample["sampleAt"] = at;
                sample["ageMilliseconds"] = at - heartbeatAt;
                sample["heartbeatReadCompletedTicks"] = Stopwatch.GetTimestamp().ToString();
                sample["fileLastWriteAt"] = new DateTimeOffset(File.GetLastWriteTimeUtc(file)).ToUnixTimeMilliseconds();
                sample["fileMetadataScope"] = "stat-after-read-may-observe-a-newer-atomic-replacement";
                sample["heartbeatStatus"] = "read";
            }
        } else sample["heartbeatStatus"] = "missing-not-freshness-proof";
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
        Require(timesRead && membershipRead && member &&
            (waitState == 0 || waitState == WaitTimeout) &&
            (long)sample["liveCheckedAt"] >= (long)sample["snapshotCompletedAt"],
            "Default fixture identity/lifetime observation failed: " + JsonSerializer.Serialize(sample));
        return sample;
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
        using (var json = JsonDocument.Parse(File.ReadAllText(receipt))) {
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
                            processCreatedAt = new DateTimeOffset(DateTime.FromFileTimeUtc(created)).ToUnixTimeMilliseconds(),
                            firstJobObservedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
                        observations.Add(identity, observation);
                    }
                    if (observation.status == "verified-specific-job-process-identity") continue;
                    observation.attempts++;
                    observation.observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    observation.executable = process.ProcessName;
                    Win32(IsProcessInJob(processHandle, job, out bool member), "Query specific owned job PID " + pid);
                    Require(member, "Enumerated process is not in the specific owned job PID " + pid);
                    observation.specificJobMember = member;
                    try { foreach (ProcessThread thread in process.Threads) {
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
        if (entry != "probe") report["defaultHeartbeatSamples"] = defaultHeartbeatSamples;
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
                "probe", workingDirectory);
            WaitReady(background, Path.Combine(defaultDirectory, "ready.json"), 20);
            Require(VisibleWindows(original, background.pid) > 0, "Owned default fixture has no visible window.");
            if (entry != "probe") defaultHeartbeatSamples.Add(ReadDefaultHeartbeat(background, defaultJob, original,
                directory, "before-owned-root", null));
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
                        directory, "owned-root-running", lastHeartbeatSampleSeconds));
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
                var finalHeartbeat = ReadDefaultHeartbeat(background, defaultJob, original, directory,
                    "root-outcome-freshness-check", rootClock.Elapsed.TotalSeconds);
                report["defaultHeartbeatCheck"] = finalHeartbeat;
                defaultHeartbeatSamples.Add(finalHeartbeat);
                Require((string)finalHeartbeat["heartbeatStatus"] == "read" &&
                    (uint)finalHeartbeat["heartbeatPid"] == background.pid &&
                    (long)finalHeartbeat["ageMilliseconds"] < 3000 &&
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
                    if (entry != "probe" && background.process != IntPtr.Zero)
                        defaultHeartbeatSamples.Add(ReadDefaultHeartbeat(background, defaultJob, original, directory,
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
