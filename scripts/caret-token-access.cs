using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

public static partial class ViCiDesktop {
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityInfo(IntPtr handle, int type, uint information, out IntPtr owner,
        out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);

    public static int DiagnoseCaretTokenObject(string output) {
        Guard();
        Require(Environment.GetEnvironmentVariable("GITHUB_REPOSITORY") == "jiec-msft/vi" &&
            Environment.GetEnvironmentVariable("VI_CARET_TRUSTED_HEAD") == "true", "Trusted own-head token diagnostic required.");
        string root = Path.GetFullPath(Environment.GetEnvironmentVariable("GITHUB_WORKSPACE"));
        output = Path.GetFullPath(output); PlainOwnedPath(root, output);
        Directory.CreateDirectory(output);
        IntPtr own = IntPtr.Zero, medium = IntPtr.Zero, duplicate = IntPtr.Zero, descriptor = IntPtr.Zero,
            tokenUser = IntPtr.Zero, defaultDacl = IntPtr.Zero, privilegeSet = IntPtr.Zero;
        var report = new Dictionary<string, object> {
            ["head"] = Environment.GetEnvironmentVariable("VI_PROBE_HEAD"),
            ["runId"] = Environment.GetEnvironmentVariable("GITHUB_RUN_ID"),
            ["attempt"] = Environment.GetEnvironmentVariable("GITHUB_RUN_ATTEMPT"),
            ["scope"] = "read-only-generated-own-primary-token-OBJECT-DACL",
            ["sourceVersion"] = "Electron45.1.0-Chromium156.0.8078.49",
            ["launchAttempted"] = false, ["aclWritten"] = false, ["saclRead"] = false, ["threadImpersonationUsed"] = false
        };
        var errors = new List<object>();
        Dictionary<long, uint> before = null;
        bool complete = false, closed = true;
        try {
            using (var process = System.Diagnostics.Process.GetCurrentProcess())
                Win32(OpenProcessToken(process.Handle, 0x2008B, out own), "Read caller's own primary with query/descriptor access");
            before = Privileges(own);
            medium = RestrictedMedium(own);
            report["tokenVerification"] = VerifyCaretToken(own, medium, true);
            uint error = GetSecurityInfo(medium, 6, 7, out IntPtr owner, out IntPtr group,
                out IntPtr dacl, out IntPtr sacl, out descriptor);
            if (error != 0) throw new Win32Exception((int)error, "Read generated token OBJECT descriptor");
            Require(owner != IntPtr.Zero && group != IntPtr.Zero && dacl != IntPtr.Zero, "Generated token OBJECT has no bounded descriptor.");
            tokenUser = TokenData(medium, 1);
            report["objectOwnerSameUser"] = EqualSid(owner, Marshal.ReadIntPtr(tokenUser));
            defaultDacl = TokenData(medium, 6);
            report["tokenDefaultDaclPresent"] = Marshal.ReadIntPtr(defaultDacl) != IntPtr.Zero;
            report["tokenDefaultDaclUsedForObjectCheck"] = false;
            Win32(DuplicateTokenEx(medium, 8, IntPtr.Zero, 2, 2, out duplicate), "Create query-only duplicate for AccessCheck");
            var checks = new List<object>();
            report["rights"] = checks;
            var mapping = new FileMapping { read = 0x20008, write = 0x200E0, execute = 0x20000, all = 0xF01FF };
            privilegeSet = Marshal.AllocHGlobal(4096);
            foreach (var right in new[] { ("query", 8U), ("duplicate", 2U), ("query-and-duplicate", 10U),
                ("chromium-GetRestrictedToken-FromCurrentProcess-exact", 0xF01FFU) }) {
                uint desired = right.Item2, bytes = 4096;
                MapGenericMask(ref desired, ref mapping);
                bool api = AccessCheck(descriptor, duplicate, desired, ref mapping, privilegeSet, ref bytes,
                    out uint granted, out bool allowed);
                int code = api && allowed ? 0 : Marshal.GetLastWin32Error();
                if (!api) throw new Win32Exception(code, "Check generated token OBJECT rights");
                checks.Add(new { role = right.Item1, desiredMask = desired, grantedMask = granted,
                    accessGranted = allowed, win32Error = code, scope = "OBJECT-DACL-only-not-nested-API-proof" });
            }
            complete = true;
        } catch (Exception error) {
            errors.Add(new { category = "token-object-diagnostic-failed",
                win32Error = error is Win32Exception native ? native.NativeErrorCode : 0 });
        } finally {
            if (before != null && own != IntPtr.Zero) {
                try {
                    var after = Privileges(own);
                    bool same = after.Count == before.Count;
                    foreach (var value in after) same = same && before.TryGetValue(value.Key, out uint attributes) && attributes == value.Value;
                    report["parentPrivilegeAttributesExactlyUnchanged"] = same;
                    if (!same) errors.Add(new { category = "parent-state-changed", win32Error = 0 });
                } catch { errors.Add(new { category = "parent-state-read-failed", win32Error = 0 }); }
            }
            foreach (IntPtr token in new[] { duplicate, medium, own }) if (token != IntPtr.Zero && !CloseHandle(token)) closed = false;
            foreach (IntPtr memory in new[] { tokenUser, defaultDacl, privilegeSet }) if (memory != IntPtr.Zero) Marshal.FreeHGlobal(memory);
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
            report["ownedHandlesClosed"] = closed;
            report["factsComplete"] = complete;
            report["errors"] = errors;
            report["diagnosticPassed"] = complete && closed && errors.Count == 0;
            Write(output, "token-object-report.json", report);
        }
        return complete && closed && errors.Count == 0 ? 0 : 1;
    }
}
