param(
    [Parameter(Mandatory = $true)][string] $DesktopName,
    [Parameter(Mandatory = $true)][string] $Output,
    [Parameter(Mandatory = $true)][string] $JobOutput,
    [Parameter(Mandatory = $true)][ValidateRange(1, 256)][int] $Generation,
    [ValidateSet('overlay-pointer', 'desktop-delivery', 'os-mouse-driver')][string] $Role
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $DesktopName -notmatch '^vi-ci-[0-9]+-[0-9]+-[a-f0-9]{32}$') {
    throw 'Desktop attestation requires the current isolated owned CI desktop.'
}
if ($Role -ne 'os-mouse-driver' -and $Generation -gt 4) { throw 'Native helper lifetime generation cap exceeded.' }
Add-Type -ReferencedAssemblies 'System', 'System.Runtime.Serialization', 'System.Core' -TypeDefinition @'
using System;
using System.Text;
using System.Diagnostics;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
[DataContract] public sealed class OverlayJobReceipt {
    [DataMember] public int pid;
    [DataMember] public string creationFileTime, status, membershipApi, liveCheckApi, sourceHead, runId, attempt, caseId;
    [DataMember] public bool specificJobMember, liveAtCompletion;
    [DataMember] public long snapshotCompletedAt, liveCheckedAt, processCreatedAt;
    [DataMember] public uint liveCheckWaitState;
    [DataMember] public int liveCheckWin32Error;
}
public static class OverlayDesktopAttestor {
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError=true)] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint bytes, out uint needed);
    static string expected, output, role, request, nonce, head, run, attempt;
    static int generation, requestSequence, caller, readySequence;
    static uint executionThread;
    static Dictionary<string, object> consumed, self, authorityReceipt;
    static string readyMessage;
    static long readyStartedAt, readyStartedTicks;
    static void Require(bool condition, string error) { if (!condition) throw new InvalidOperationException(error); }
    static string Name(IntPtr handle) {
        var value = new StringBuilder(512); uint needed;
        Require(handle != IntPtr.Zero && GetUserObjectInformation(handle, 2, value, 1024, out needed),
            "Self desktop identity unavailable error " + Marshal.GetLastWin32Error());
        return value.ToString();
    }
    public static string Json(Dictionary<string, object> value) {
        var serializer = new DataContractJsonSerializer(typeof(Dictionary<string, object>),
            new DataContractJsonSerializerSettings { UseSimpleDictionaryFormat = true,
                KnownTypes = new [] { typeof(Dictionary<string, object>) } });
        using (var stream = new MemoryStream()) {
            serializer.WriteObject(stream, value);
            return Encoding.UTF8.GetString(stream.ToArray());
        }
    }
    public static string Hash(byte[] bytes) {
        using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
    }
    static byte[] Bytes(string file) {
        using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        using (var memory = new MemoryStream()) { stream.CopyTo(memory); return memory.ToArray(); }
    }
    static Dictionary<string, object> Context() {
        return new Dictionary<string, object> { {"sourceHead",head}, {"runId",run}, {"attempt",attempt}, {"caseId",expected},
            {"requestId",request}, {"requestNonce",nonce}, {"requestSequence",requestSequence}, {"callerPid",caller},
            {"pid",Process.GetCurrentProcess().Id}, {"role",role}, {"generation",generation},
            {"executionThread",executionThread}, {"monotonicClock","native-process-Stopwatch"},
            {"monotonicFrequency",Stopwatch.Frequency.ToString()} };
    }
    public static void Configure(string desktop, string directory, string jobDirectory, string kind, int sequence) {
        expected = desktop; output = directory; role = kind; generation = sequence;
        executionThread = GetCurrentThreadId();
        request = Environment.GetEnvironmentVariable("VI_CI_NATIVE_SPAWN_REQUEST");
        nonce = Environment.GetEnvironmentVariable("VI_CI_NATIVE_REQUEST_NONCE");
        head = Environment.GetEnvironmentVariable("VI_PROBE_HEAD");
        run = Environment.GetEnvironmentVariable("GITHUB_RUN_ID"); attempt = Environment.GetEnvironmentVariable("GITHUB_RUN_ATTEMPT");
        Require(Int32.TryParse(Environment.GetEnvironmentVariable("VI_CI_NATIVE_REQUEST_SEQUENCE"),out requestSequence) &&
            Int32.TryParse(Environment.GetEnvironmentVariable("VI_CI_NATIVE_CALLER_PID"),out caller) && caller > 0 &&
            requestSequence > 0 && generation > 0 && generation <= 256 &&
            Regex.IsMatch(nonce ?? "", "^[a-f0-9-]{36}$") &&
            request == caller + "-" + requestSequence + "-" + role + "-" + generation,
            "Native request identity unavailable.");
        string birth;
        using (var process = Process.GetCurrentProcess()) birth = process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();
        string name = "job-" + Process.GetCurrentProcess().Id + "-" + birth + ".json";
        var deadline = Stopwatch.StartNew();
        string file = Path.Combine(jobDirectory, name);
        while (!File.Exists(file) && deadline.Elapsed.TotalSeconds < 2) System.Threading.Thread.Sleep(25);
        Require(File.Exists(file), "External committed Job receipt missing.");
        byte[] bytes = Bytes(file);
        OverlayJobReceipt job;
        using (var memory = new MemoryStream(bytes))
            job = (OverlayJobReceipt)new DataContractJsonSerializer(typeof(OverlayJobReceipt)).ReadObject(memory);
        Require(job.pid == Process.GetCurrentProcess().Id && job.creationFileTime == birth &&
            job.sourceHead == head && job.runId == run && job.attempt == attempt && job.caseId == expected &&
            job.status == "verified-specific-job-process-identity" && job.membershipApi == "IsProcessInJob" &&
            job.specificJobMember && job.liveAtCompletion && job.liveCheckApi == "WaitForSingleObject" &&
            job.liveCheckWaitState == 258 && job.liveCheckWin32Error == 0 &&
            job.snapshotCompletedAt > 0 && job.liveCheckedAt >= job.snapshotCompletedAt,
            "Consumed independent Job receipt identity/lifetime mismatch.");
        consumed = new Dictionary<string, object> { {"fileName",name}, {"sha256",Hash(bytes)}, {"pid",job.pid},
            {"creationFileTime",birth}, {"snapshotCompletedAt",job.snapshotCompletedAt}, {"liveCheckedAt",job.liveCheckedAt},
            {"consumptionThread",GetCurrentThreadId()}, {"consumptionComplete",true},
            {"consumedAt",DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}, {"consumedTicks",Stopwatch.GetTimestamp().ToString()} };
        Require(GetCurrentThreadId() == executionThread, "Job receipt consumption thread changed.");
    }
    public static void ConfirmExecution() {
        Require(consumed != null && GetCurrentThreadId() == executionThread, "Execution/receipt thread changed.");
        if (self != null) return;
        long startedTicks = Stopwatch.GetTimestamp(), startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        IntPtr input = OpenInputDesktop(0,false,0x0141);
        string station, thread, active;
        try { station = Name(GetProcessWindowStation()); thread = Name(GetThreadDesktop(executionThread)); active = Name(input); }
        finally { if (input != IntPtr.Zero) Require(CloseDesktop(input), "Input desktop handle cleanup failed."); }
        Require(station == "WinSta0" && thread == expected && active == expected, "Native execution desktop changed.");
        using (var process = Process.GetCurrentProcess()) {
            string birth = process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();
            long completeAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), completeTicks = Stopwatch.GetTimestamp();
            uint state = WaitForSingleObject(process.Handle,0);
            int error = state == UInt32.MaxValue ? Marshal.GetLastWin32Error() : 0;
            long liveAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), liveTicks = Stopwatch.GetTimestamp();
            Require(state == 258 && error == 0 && liveAt >= completeAt && liveTicks >= completeTicks,
                "Native post-query stable-handle live check failed: " + state + "/" + error);
            self = Context();
            self["creationFileTime"] = birth; self["thread"] = executionThread;
            self["station"] = station; self["threadDesktop"] = thread; self["inputDesktop"] = active;
            self["coverage"] = "self-execution-thread-not-all-process-threads"; self["selfQueryComplete"] = true;
            self["jobReceipt"] = consumed; self["queryStartedAt"] = startedAt; self["queryCompletedAt"] = completeAt;
            self["nativeQueryStartedAt"] = startedAt; self["nativeQueryCompletedAt"] = completeAt;
            self["queryStartedTicks"] = startedTicks.ToString(); self["queryCompletedTicks"] = completeTicks.ToString();
            self["selfLiveCheckedAt"] = liveAt; self["selfLiveCheckedTicks"] = liveTicks.ToString();
            self["selfLiveWaitState"] = state; self["selfLiveWin32Error"] = error;
            self["selfLiveApi"] = "WaitForSingleObject";
            Publish(self, "desktop-" + role + "-" + process.Id);
        }
    }
    public static Dictionary<string, object> Self() { ConfirmExecution(); return new Dictionary<string, object>(self); }
    public static long Ticks() { Require(GetCurrentThreadId() == executionThread, "Native response thread changed."); return Stopwatch.GetTimestamp(); }
    static void Publish(Dictionary<string, object> value, string stem) {
        byte[] bytes = Encoding.UTF8.GetBytes(Json(value));
        string file = Path.Combine(output,stem);
        File.WriteAllBytes(file + ".tmp",bytes);
        File.Move(file + ".tmp",file + ".json");
        long committedTicks = Stopwatch.GetTimestamp(), committedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var commit = Context();
        commit["creationFileTime"] = value["creationFileTime"]; commit["fileName"] = stem + ".json";
        commit["sha256"] = Hash(bytes); commit["commitComplete"] = true; commit["committedAt"] = committedAt;
        commit["committedTicks"] = committedTicks.ToString();
        if (value.ContainsKey("readySequence")) commit["readySequence"] = value["readySequence"];
        File.WriteAllText(file + ".commit.tmp",Json(commit),new UTF8Encoding(false));
        File.Move(file + ".commit.tmp",file + ".commit.json");
    }
    public static void BeginReadyWrite(string message) {
        ConfirmExecution();
        Require(GetCurrentThreadId() == executionThread && readyMessage == null && readySequence < 64 &&
            ((role == "overlay-pointer" && message == "{\"type\":\"ready\"}") ||
             (role == "desktop-delivery" && message.Contains("\"ready\":true"))), "Native READY identity unavailable.");
        readyMessage = message; readySequence++;
        readyStartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); readyStartedTicks = Stopwatch.GetTimestamp();
    }
    public static void EndReadyWrite(string message) {
        long endedTicks = Ticks(), endedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Require(message == readyMessage, "Exact READY message changed.");
        var value = Self();
        value["readySequence"] = readySequence; value["messageBase64"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(message));
        value["writeApi"] = "Console.WriteLine"; value["writeComplete"] = true;
        value["writeStartedAt"] = readyStartedAt; value["writeCompletedAt"] = endedAt;
        value["writeStartedTicks"] = readyStartedTicks.ToString(); value["writeCompletedTicks"] = endedTicks.ToString();
        Publish(value,"desktop-ready-" + role + "-" + Process.GetCurrentProcess().Id + "-" + readySequence);
        readyMessage = null;
    }
    public static string CommitResponse(string json) {
        var serializer = new DataContractJsonSerializer(typeof(Dictionary<string, object>),
            new DataContractJsonSerializerSettings { UseSimpleDictionaryFormat = true,
                KnownTypes = new [] { typeof(Dictionary<string, object>) } });
        Dictionary<string,object> action;
        using (var memory = new MemoryStream(Encoding.UTF8.GetBytes(json)))
            action = (Dictionary<string,object>)serializer.ReadObject(memory);
        var value = Self();
        foreach (var pair in action) value[pair.Key] = pair.Value;
        if (authorityReceipt != null) value["authorityReceipt"] = authorityReceipt;
        Require(GetCurrentThreadId() == executionThread && Convert.ToUInt32(action["inputExecutionThread"]) == executionThread,
            "Input/response execution thread changed.");
        value["responseReadyTicks"] = Ticks().ToString(); value["responseComplete"] = true;
        value["driverPid"] = Process.GetCurrentProcess().Id; value["driverThread"] = executionThread;
        Publish(value,"driver-response-" + nonce);
        return Json(value);
    }
    public static void ValidateAuthority(string json, long window, int owner) {
        var serializer = new DataContractJsonSerializer(typeof(Dictionary<string,object>),
            new DataContractJsonSerializerSettings { UseSimpleDictionaryFormat = true });
        Dictionary<string,object> authority;
        using (var memory = new MemoryStream(Encoding.UTF8.GetBytes(json)))
            authority = (Dictionary<string,object>)serializer.ReadObject(memory);
        string oldNonce = (string)authority["requestNonce"];
        Require(Regex.IsMatch(oldNonce,"^[a-f0-9-]{36}$"), "Owned down authority nonce invalid.");
        string stem = "driver-response-" + oldNonce;
        byte[] bytes = Bytes(Path.Combine(output,stem + ".json"));
        Dictionary<string,object> down, commit;
        using (var memory = new MemoryStream(bytes)) down = (Dictionary<string,object>)serializer.ReadObject(memory);
        using (var memory = new MemoryStream(Bytes(Path.Combine(output,stem + ".commit.json"))))
            commit = (Dictionary<string,object>)serializer.ReadObject(memory);
        Require(Hash(bytes) == (string)authority["responseSHA256"] && (string)commit["sha256"] == Hash(bytes) &&
            Convert.ToBoolean(commit["commitComplete"]) && (string)down["requestNonce"] == oldNonce &&
            (string)down["sourceHead"] == head && (string)down["runId"] == run && (string)down["attempt"] == attempt &&
            (string)down["caseId"] == expected && (string)down["mode"] == "down" &&
            Convert.ToBoolean(down["ownerVerified"]) && Convert.ToBoolean(down["ownedDownInjected"]) &&
            Convert.ToBoolean(down["leftHeldAfter"]) && (string)down["ownedWindow"] == window.ToString() &&
            Convert.ToInt32(down["ownedOwnerPid"]) == owner, "Committed owned native down receipt mismatch.");
        Require(GetCurrentThreadId() == executionThread, "Down authority consumption thread changed.");
        authorityReceipt = new Dictionary<string, object> { {"requestNonce",oldNonce}, {"sha256",Hash(bytes)},
            {"pid",down["driverPid"]}, {"creationFileTime",down["creationFileTime"]},
            {"consumptionThread",GetCurrentThreadId()}, {"consumedTicks",Ticks().ToString()}, {"consumptionComplete",true} };
    }
}
'@
[OverlayDesktopAttestor]::Configure($DesktopName, $Output, $JobOutput, $Role, $Generation)
