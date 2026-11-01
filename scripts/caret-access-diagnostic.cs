using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

public static partial class ViCiDesktop {
    [StructLayout(LayoutKind.Sequential)]
    struct FileMapping { public uint read, write, execute, all; }
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr security, int level, int type, out IntPtr result);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    static extern uint GetNamedSecurityInfoW(string name, int type, uint information, out IntPtr owner,
        out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")]
    static extern void MapGenericMask(ref uint mask, ref FileMapping mapping);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool AccessCheck(IntPtr descriptor, IntPtr token, uint desired, ref FileMapping mapping,
        IntPtr privileges, ref uint privilegeBytes, out uint granted, out bool allowed);

    static object PrivilegeFact(Dictionary<long, uint> values, string name) {
        Win32(LookupPrivilegeValueW(null, name, out long luid), "Read controlled privilege identity");
        bool present = values.TryGetValue(luid, out uint attributes);
        return new { present, enabled = present && (attributes & 2) != 0 };
    }

    static object CheckControlledPath(string role, string path, bool directory, bool writable, IntPtr token, string state) {
        if (directory ? !Directory.Exists(path) : !File.Exists(path))
            throw new InvalidOperationException("Controlled diagnostic path unavailable: " + role);
        var mapping = new FileMapping { read = 0x120089, write = 0x120116, execute = 0x1200A0, all = 0x1F01FF };
        uint desired = writable ? 0xE0000000 : 0xA0000000;
        MapGenericMask(ref desired, ref mapping);
        IntPtr descriptor = IntPtr.Zero, privileges = IntPtr.Zero;
        try {
            uint error = GetNamedSecurityInfoW(path, 1, 7, out IntPtr owner, out IntPtr group,
                out IntPtr dacl, out IntPtr sacl, out descriptor);
            if (error != 0) throw new Win32Exception((int)error, "Read controlled path DACL: " + role);
            Require(owner != IntPtr.Zero && group != IntPtr.Zero, "Controlled path descriptor lacks owner/group.");
            privileges = Marshal.AllocHGlobal(4096);
            uint bytes = 4096;
            bool apiSucceeded = AccessCheck(descriptor, token, desired, ref mapping, privileges, ref bytes,
                out uint granted, out bool allowed);
            int code = apiSucceeded && allowed ? 0 : Marshal.GetLastWin32Error();
            if (!apiSucceeded) throw new Win32Exception(code, "Check controlled path DACL: " + role);
            return new { role, pathState = state, desiredMask = desired, grantedMask = granted,
                accessGranted = allowed, win32Error = code, scope = "DACL-only-not-launch-guarantee" };
        } finally {
            if (privileges != IntPtr.Zero) Marshal.FreeHGlobal(privileges);
            if (descriptor != IntPtr.Zero && LocalFree(descriptor) != IntPtr.Zero)
                throw new InvalidOperationException("Controlled path descriptor cleanup failed.");
        }
    }

    public static int RunCaretAccessDiagnostic(string root, string output) {
        Guard();
        Require(Environment.GetEnvironmentVariable("GITHUB_REPOSITORY") == "jiec-msft/vi" &&
            Environment.GetEnvironmentVariable("VI_CARET_TRUSTED_HEAD") == "true",
            "Read-only caret diagnostic requires trusted own-repository current-head CI.");
        root = Path.GetFullPath(root);
        output = Path.GetFullPath(output);
        Require(output.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase),
            "Diagnostic output must remain in the owned checkout.");
        Directory.CreateDirectory(output);
        var report = new Dictionary<string, object> {
            ["head"] = Environment.GetEnvironmentVariable("VI_PROBE_HEAD"),
            ["runId"] = Environment.GetEnvironmentVariable("GITHUB_RUN_ID"),
            ["attempt"] = Environment.GetEnvironmentVariable("GITHUB_RUN_ATTEMPT"),
            ["scope"] = "read-only-own-token-controlled-path-DACL",
            ["launchAttempted"] = false, ["threadImpersonationUsed"] = false, ["aclModified"] = false,
            ["saclRead"] = false, ["parentPrivilegeAdjustmentUsed"] = false
        };
        var errors = new List<object>();
        IntPtr own = IntPtr.Zero, medium = IntPtr.Zero, duplicate = IntPtr.Zero;
        Dictionary<long, uint> before = null;
        bool factsComplete = false, handlesClosed = true;
        try {
            using (var process = System.Diagnostics.Process.GetCurrentProcess())
                Win32(OpenProcessToken(process.Handle, 0x8b, out own), "Read diagnostic caller's own primary token");
            before = Privileges(own);
            report["quota"] = PrivilegeFact(before, "SeIncreaseQuotaPrivilege");
            report["impersonate"] = PrivilegeFact(before, "SeImpersonatePrivilege");
            Require(TokenIntegrity(own) == 0x3000, "Diagnostic requires the observed high CI caller, not an alternate identity.");
            medium = RestrictedMedium(own);
            report["mediumTokenVerification"] = VerifyCaretToken(own, medium, true);
            Win32(DuplicateTokenEx(medium, 8, IntPtr.Zero, 2, 2, out duplicate),
                "Duplicate same-user restricted medium token for read-only AccessCheck");
            Require(TokenNumber(duplicate, 8) == 2 && TokenIntegrity(duplicate) == 0x2000,
                "AccessCheck token must be an impersonation-type medium duplicate.");
            var checks = new List<object>();
            report["paths"] = checks;
            string dist = Path.Combine(root, "node_modules", "electron", "dist");
            checks.Add(CheckControlledPath("electron-image", Path.Combine(dist, "electron.exe"), false, false, duplicate, "existing"));
            checks.Add(CheckControlledPath("electron-dist", dist, true, false, duplicate, "existing"));
            checks.Add(CheckControlledPath("workspace", root, true, false, duplicate, "existing"));
            string profile = Path.Combine(root, "artifacts-ci", "caret", "profile");
            bool exists = Directory.Exists(profile);
            string parent = profile;
            while (!Directory.Exists(parent)) {
                parent = Path.GetDirectoryName(parent);
                Require(parent != null && (parent.Equals(root, StringComparison.OrdinalIgnoreCase) ||
                    parent.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)),
                    "No existing owned profile ancestor.");
            }
            checks.Add(CheckControlledPath("profile-parent", parent, true, true, duplicate, exists ? "existing" : "not-created"));
            factsComplete = true;
        } catch (Exception error) {
            errors.Add(new { category = "diagnostic-failed",
                win32Error = error is Win32Exception native ? native.NativeErrorCode : 0 });
        } finally {
            if (before != null && own != IntPtr.Zero) {
                try {
                    var after = Privileges(own);
                    bool exact = before.Count == after.Count;
                    foreach (var privilege in after)
                        exact = exact && before.TryGetValue(privilege.Key, out uint attributes) && attributes == privilege.Value;
                    report["parentPrivilegeAttributesExactlyUnchanged"] = exact;
                    if (!exact) errors.Add(new { category = "parent-privilege-state-changed", win32Error = 0 });
                } catch (Exception error) {
                    errors.Add(new { category = "parent-state-read-failed",
                        win32Error = error is Win32Exception native ? native.NativeErrorCode : 0 });
                }
            }
            foreach (IntPtr token in new[] { duplicate, medium, own }) {
                if (token != IntPtr.Zero && !CloseHandle(token)) {
                    handlesClosed = false;
                    errors.Add(new { category = "owned-token-close-failed", win32Error = Marshal.GetLastWin32Error() });
                }
            }
            report["ephemeralTokenHandlesClosed"] = handlesClosed;
            report["factsComplete"] = factsComplete;
            report["errors"] = errors;
            report["diagnosticPassed"] = factsComplete && handlesClosed && errors.Count == 0;
            Write(output, "access-report.json", report);
        }
        return factsComplete && handlesClosed && errors.Count == 0 ? 0 : 1;
    }
}
