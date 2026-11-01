param(
    [Parameter(Mandatory = $true)][string] $DesktopName,
    [Parameter(Mandatory = $true)][string] $Output,
    [Parameter(Mandatory = $true)][string] $JobOutput,
    [Parameter(Mandatory = $true)][ValidateRange(1, 4)][int] $Generation,
    [ValidateSet('overlay-pointer', 'desktop-delivery')][string] $Role
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $DesktopName -notmatch '^vi-ci-[0-9]+-[0-9]+-[a-f0-9]{32}$') {
    throw 'Desktop attestation requires the current isolated owned CI desktop.'
}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Diagnostics;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
public static class OverlayDesktopAttestor {
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint bytes, out uint needed);
    static string Name(IntPtr handle) {
        var value = new StringBuilder(512);
        uint needed;
        if (handle == IntPtr.Zero || !GetUserObjectInformation(handle, 2, value, 1024, out needed))
            throw new InvalidOperationException("Self desktop identity unavailable PID/TID " +
                Process.GetCurrentProcess().Id + "/" + GetCurrentThreadId() + " error " + Marshal.GetLastWin32Error());
        return value.ToString();
    }
    static string expected, output, role, spawnRequest;
    static int requestSequence;
    static uint initialThread;
    static int generation, readySequence;
    static long readyWriteStartedAt, readyWriteStartedTicks;
    static string readyMessage;
    static bool recorded;
    public static Dictionary<string, object> Read() {
        long startedTicks = Stopwatch.GetTimestamp();
        long started = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        uint thread = GetCurrentThreadId();
        IntPtr input = OpenInputDesktop(0, false, 0x0141);
        string station, desktop, active;
        try { station = Name(GetProcessWindowStation()); desktop = Name(GetThreadDesktop(thread)); active = Name(input); }
        finally { if (input != IntPtr.Zero && !CloseDesktop(input)) throw new InvalidOperationException("Input desktop handle cleanup failed."); }
        using (var process = Process.GetCurrentProcess()) {
            string birth = process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();
            long completed = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            long completedTicks = Stopwatch.GetTimestamp();
            return new Dictionary<string, object> { { "pid", process.Id }, { "thread", thread },
                { "creationFileTime", birth },
                { "station", station }, { "threadDesktop", desktop }, { "inputDesktop", active },
                { "selfQueryComplete", true }, { "queryStartedAt", started },
                { "queryCompletedAt", completed }, { "queryStartedTicks", startedTicks.ToString() },
                { "queryCompletedTicks", completedTicks.ToString() } };
        }
    }
    public static void Configure(string desktop, string file, string kind, uint thread, int sequence,
        string request, int requestNumber) {
        if (requestNumber <= 0 || !Regex.IsMatch(request, "^[1-9][0-9]*-" + requestNumber + "-" + kind + "-" + sequence + "$"))
            throw new InvalidOperationException("Native spawn request identity unavailable.");
        expected = desktop; output = file; role = kind; initialThread = thread; generation = sequence;
        spawnRequest = request; requestSequence = requestNumber;
    }
    // Called inside the generated sampler, or immediately before the delivery protocol on its execution thread.
    public static void ConfirmExecution() {
        if (GetCurrentThreadId() != initialThread) throw new InvalidOperationException("Native execution thread changed.");
        if (recorded) return;
        var sample = Read();
        if ((string)sample["station"] != "WinSta0" || (string)sample["threadDesktop"] != expected ||
            (string)sample["inputDesktop"] != expected) throw new InvalidOperationException("Native execution desktop changed.");
        string json = "{\"pid\":" + sample["pid"] + ",\"thread\":" + sample["thread"] +
            ",\"executionThread\":" + GetCurrentThreadId() + ",\"role\":\"" + role +
            "\",\"generation\":" + generation +
            ",\"requestId\":\"" + spawnRequest + "\",\"requestSequence\":" + requestSequence +
            ",\"creationFileTime\":\"" + sample["creationFileTime"] +
            "\",\"station\":\"WinSta0\",\"threadDesktop\":\"" + expected + "\",\"inputDesktop\":\"" + expected +
            "\",\"coverage\":\"self-execution-thread-not-all-process-threads\",\"selfQueryComplete\":true," +
            "\"queryStartedAt\":" + sample["queryStartedAt"] + ",\"queryCompletedAt\":" + sample["queryCompletedAt"] +
            ",\"queryStartedTicks\":\"" + sample["queryStartedTicks"] + "\",\"queryCompletedTicks\":\"" + sample["queryCompletedTicks"] +
            "\",\"monotonicFrequency\":\"" + Stopwatch.Frequency + "\",\"monotonicClock\":\"native-process-Stopwatch\"}";
        File.WriteAllText(output, json, new UTF8Encoding(false));
        recorded = true;
    }
    public static void BeginReadyWrite(string message) {
        if (!recorded || role != "overlay-pointer" || GetCurrentThreadId() != initialThread ||
            message != "{\"type\":\"ready\"}" || readyMessage != null || readySequence >= 64)
            throw new InvalidOperationException("Native READY write identity unavailable or inconsistent.");
        readyMessage = message;
        readySequence++;
        readyWriteStartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        readyWriteStartedTicks = Stopwatch.GetTimestamp();
    }
    public static void EndReadyWrite(string message) {
        long completedTicks = Stopwatch.GetTimestamp();
        long completedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        uint thread = GetCurrentThreadId();
        if (thread != initialThread || message != readyMessage)
            throw new InvalidOperationException("Native READY write execution identity changed.");
        using (var process = Process.GetCurrentProcess()) {
            string json = "{\"pid\":" + process.Id + ",\"creationFileTime\":\"" +
                process.StartTime.ToUniversalTime().ToFileTimeUtc() + "\",\"role\":\"" + role +
                "\",\"generation\":" + generation + ",\"executionThread\":" + thread +
                ",\"requestId\":\"" + spawnRequest + "\",\"requestSequence\":" + requestSequence +
                ",\"readySequence\":" + readySequence + ",\"messageBase64\":\"" +
                Convert.ToBase64String(Encoding.UTF8.GetBytes(message)) + "\",\"writeApi\":\"Console.WriteLine\"" +
                ",\"writeComplete\":true,\"writeStartedAt\":" + readyWriteStartedAt + ",\"writeCompletedAt\":" + completedAt +
                ",\"writeStartedTicks\":\"" + readyWriteStartedTicks + "\",\"writeCompletedTicks\":\"" + completedTicks +
                "\",\"monotonicFrequency\":\"" + Stopwatch.Frequency + "\",\"monotonicClock\":\"native-process-Stopwatch\"}";
            string file = Path.Combine(Path.GetDirectoryName(output),
                "desktop-ready-" + role + "-" + process.Id + "-" + readySequence);
            File.WriteAllText(file + ".tmp", json, new UTF8Encoding(false));
            File.Move(file + ".tmp", file + ".json");
        }
        readyMessage = null;
    }
}
'@
$sample = [OverlayDesktopAttestor]::Read()
if ($sample.station -ne 'WinSta0' -or $sample.threadDesktop -ne $DesktopName -or $sample.inputDesktop -ne $DesktopName) {
    throw 'Owned PS5 helper did not inherit the active ordinary desktop.'
}
$jobPath = Join-Path $JobOutput "job-$PID-$($sample.creationFileTime).json"
$deadline = [DateTime]::UtcNow.AddSeconds(2)
while (!(Test-Path -LiteralPath $jobPath) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 25 }
if (!(Test-Path -LiteralPath $jobPath)) { throw "External specific Job proof missing for native PID $PID." }
$job = [IO.File]::ReadAllText($jobPath) | ConvertFrom-Json
if ($job.pid -ne $PID -or $job.creationFileTime -ne $sample.creationFileTime -or !$job.specificJobMember -or
    !$job.liveAtCompletion -or $job.status -ne 'verified-specific-job-process-identity' -or
    $job.liveCheckApi -ne 'WaitForSingleObject' -or $job.liveCheckWaitState -ne 258 -or
    $job.liveCheckWin32Error -ne 0 -or !$job.snapshotCompletedAt -or
    $job.liveCheckedAt -lt $job.snapshotCompletedAt) {
    throw "External native process generation/Job proof mismatch for PID $PID."
}
[OverlayDesktopAttestor]::Configure($DesktopName, (Join-Path $Output "desktop-$Role-$PID.json"), $Role, $sample.thread, $Generation,
    $env:VI_CI_NATIVE_SPAWN_REQUEST, [int]$env:VI_CI_NATIVE_REQUEST_SEQUENCE)
