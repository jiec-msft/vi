using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;

public static partial class ViCiDesktop {
    [StructLayout(LayoutKind.Sequential)]
    struct FileMapping { public uint read, write, execute, all; }
    [StructLayout(LayoutKind.Sequential)]
    struct AclSize { public uint count, used, free; }
    sealed class PathFact {
        public string role { get; set; }
        public string pathState { get; set; }
        public string scope { get; set; }
        public uint desiredMask { get; set; }
        public uint grantedMask { get; set; }
        public bool accessGranted { get; set; }
        public int win32Error { get; set; }
    }
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
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetAclInformation(IntPtr acl, out AclSize size, uint bytes, int kind);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetAce(IntPtr acl, uint index, out IntPtr ace);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool InitializeAcl(IntPtr acl, uint bytes, uint revision);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool AddAce(IntPtr acl, uint revision, uint index, IntPtr ace, uint bytes);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool AddAccessAllowedAceEx(IntPtr acl, uint revision, uint flags, uint mask, IntPtr sid);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    static extern uint SetNamedSecurityInfoW(string name, int type, uint information,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

    static void PlainOwnedPath(string root, string path) {
        path = Path.GetFullPath(path);
        Require(path.Equals(root, StringComparison.OrdinalIgnoreCase) ||
            path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase),
            "Layout path escaped the owned checkout.");
        string current = path;
        while (current != null) {
            if (Directory.Exists(current))
                Require((File.GetAttributes(current) & FileAttributes.ReparsePoint) == 0, "Layout path contains a reparse point.");
            if (current.Equals(root, StringComparison.OrdinalIgnoreCase)) return;
            current = Path.GetDirectoryName(current);
        }
        throw new InvalidOperationException("Layout path lacks its canonical owned checkout ancestor.");
    }

    static void GrantOwnTreeModify(string root, string tree, IntPtr token) {
        PlainOwnedPath(root, tree);
        IntPtr descriptor = IntPtr.Zero, afterDescriptor = IntPtr.Zero, acl = IntPtr.Zero, user = TokenData(token, 1);
        try {
            uint error = GetNamedSecurityInfoW(tree, 1, 7, out IntPtr owner, out IntPtr group,
                out IntPtr original, out IntPtr sacl, out descriptor);
            if (error != 0) throw new Win32Exception((int)error, "Read owned synthetic tree DACL");
            Require(original != IntPtr.Zero && owner != IntPtr.Zero && group != IntPtr.Zero, "Owned tree requires a real DACL.");
            Win32(GetAclInformation(original, out AclSize size, (uint)Marshal.SizeOf<AclSize>(), 2), "Read owned DACL size");
            Require(size.count <= 128 && size.used <= 32768, "Owned DACL bound exceeded.");
            uint revision = Marshal.ReadByte(original), bytes = size.used + 8 + GetLengthSid(Marshal.ReadIntPtr(user));
            acl = Marshal.AllocHGlobal((int)bytes);
            Win32(InitializeAcl(acl, bytes, revision), "Create owned tree DACL copy");
            bool added = false;
            var originalEntries = new List<byte[]>();
            for (uint index = 0; index < size.count; index++) {
                Win32(GetAce(original, index, out IntPtr ace), "Read owned DACL entry");
                if (!added && (Marshal.ReadByte(ace, 1) & 0x10) != 0) {
                    Win32(AddAccessAllowedAceEx(acl, revision, 3, 0x1301BF, Marshal.ReadIntPtr(user)), "Add current-user inheritable Modify entry");
                    added = true;
                }
                uint aceBytes = (ushort)Marshal.ReadInt16(ace, 2);
                var entry = new byte[aceBytes];
                Marshal.Copy(ace, entry, 0, entry.Length);
                originalEntries.Add(entry);
                Win32(AddAce(acl, revision, UInt32.MaxValue, ace, aceBytes), "Preserve original owned DACL entry");
            }
            if (!added) Win32(AddAccessAllowedAceEx(acl, revision, 3, 0x1301BF, Marshal.ReadIntPtr(user)), "Add current-user inheritable Modify entry");
            error = SetNamedSecurityInfoW(tree, 1, 4, IntPtr.Zero, IntPtr.Zero, acl, IntPtr.Zero);
            if (error != 0) throw new Win32Exception((int)error, "Set only the owned synthetic tree DACL");
            PlainOwnedPath(root, tree);
            error = GetNamedSecurityInfoW(tree, 1, 7, out IntPtr afterOwner, out IntPtr afterGroup,
                out IntPtr afterAcl, out IntPtr afterSacl, out afterDescriptor);
            if (error != 0) throw new Win32Exception((int)error, "Read actual owned tree DACL after modification");
            Require(EqualSid(owner, afterOwner) && EqualSid(group, afterGroup), "Owned tree owner/group changed.");
            Win32(GetAclInformation(afterAcl, out AclSize actual, (uint)Marshal.SizeOf<AclSize>(), 2), "Read actual owned DACL size");
            var actualEntries = new List<byte[]>();
            bool grantVerified = false;
            for (uint index = 0; index < actual.count; index++) {
                Win32(GetAce(afterAcl, index, out IntPtr ace), "Read actual owned DACL entry");
                int count = (ushort)Marshal.ReadInt16(ace, 2);
                var entry = new byte[count];
                Marshal.Copy(ace, entry, 0, count);
                actualEntries.Add(entry);
                if (Marshal.ReadByte(ace) == 0 && (Marshal.ReadByte(ace, 1) & 0x13) == 3 &&
                    (uint)Marshal.ReadInt32(ace, 4) == 0x1301BF && EqualSid(IntPtr.Add(ace, 8), Marshal.ReadIntPtr(user)))
                    grantVerified = true;
            }
            Require(originalEntries.All(entry => actualEntries.Any(actualEntry => entry.SequenceEqual(actualEntry))) && grantVerified,
                "Actual owned DACL lacks preserved original entries or the exact current-user Modify grant.");
        } finally {
            Marshal.FreeHGlobal(user);
            if (acl != IntPtr.Zero) Marshal.FreeHGlobal(acl);
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
            if (afterDescriptor != IntPtr.Zero) LocalFree(afterDescriptor);
        }
    }

    static object PrivilegeFact(Dictionary<long, uint> values, string name) {
        Win32(LookupPrivilegeValueW(null, name, out long luid), "Read controlled privilege identity");
        bool present = values.TryGetValue(luid, out uint attributes);
        return new { present, enabled = present && (attributes & 2) != 0 };
    }

    static PathFact CheckControlledPath(string role, string path, bool directory, bool writable, IntPtr token, string state) {
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
            return new PathFact { role = role, pathState = state, desiredMask = desired, grantedMask = granted,
                accessGranted = allowed, win32Error = code, scope = "DACL-only-not-launch-guarantee" };
        } finally {
            if (privileges != IntPtr.Zero) Marshal.FreeHGlobal(privileges);
            if (descriptor != IntPtr.Zero && LocalFree(descriptor) != IntPtr.Zero)
                throw new InvalidOperationException("Controlled path descriptor cleanup failed.");
        }
    }

    public static int RunCaretAccessDiagnostic(string root, string output, bool qualifyOwnedLayout = false) {
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
        string tree = Path.Combine(root, "artifacts-ci", "caret"), createdProfile = Path.Combine(tree, "profile");
        bool treeCreated = false, profileCreated = false, layoutCleaned = !qualifyOwnedLayout;
        bool factsComplete = false, handlesClosed = true;
        try {
            using (var process = System.Diagnostics.Process.GetCurrentProcess())
                Win32(OpenProcessToken(process.Handle, 0x8b, out own), "Read diagnostic caller's own primary token");
            before = Privileges(own);
            report["quota"] = PrivilegeFact(before, "SeIncreaseQuotaPrivilege");
            report["impersonate"] = PrivilegeFact(before, "SeImpersonatePrivilege");
            Require(TokenIntegrity(own) == 0x3000, "Diagnostic requires the observed high CI caller, not an alternate identity.");
            if (qualifyOwnedLayout) {
                PlainOwnedPath(root, tree);
                Require(!Directory.Exists(tree) && !File.Exists(tree), "Synthetic tree must be fresh; refusing to modify pre-existing files.");
                Directory.CreateDirectory(tree); treeCreated = true;
                PlainOwnedPath(root, tree);
                Directory.CreateDirectory(createdProfile); profileCreated = true;
                PlainOwnedPath(root, createdProfile);
                GrantOwnTreeModify(root, tree, own);
                report["aclModified"] = true;
                report["layoutScope"] = "fresh-owned-caret-tree-current-user-inheritable-Modify";
                report["originalAceEntriesPreserved"] = true;
                report["canonicalNonReparsePaths"] = true;
            }
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
            if (qualifyOwnedLayout) {
                var ancestorFact = CheckControlledPath("artifact-ancestor", Path.Combine(root, "artifacts-ci"), true, false, duplicate, "existing");
                var treeFact = CheckControlledPath("caret-evidence-tree", tree, true, true, duplicate, "created");
                var profileFact = CheckControlledPath("created-profile", createdProfile, true, true, duplicate, "created");
                checks.Add(ancestorFact); checks.Add(treeFact); checks.Add(profileFact);
                Require(ancestorFact.accessGranted && treeFact.accessGranted && profileFact.accessGranted, "Owned layout access remains denied.");
            }
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
            if (qualifyOwnedLayout) {
                try {
                    if (profileCreated) { PlainOwnedPath(root, createdProfile); Directory.Delete(createdProfile, false); }
                    if (treeCreated) { PlainOwnedPath(root, tree); Directory.Delete(tree, false); }
                    layoutCleaned = !Directory.Exists(createdProfile) && !Directory.Exists(tree);
                    if (!layoutCleaned) errors.Add(new { category = "owned-layout-cleanup-incomplete", win32Error = 0 });
                } catch { errors.Add(new { category = "owned-layout-cleanup-failed", win32Error = 0 }); }
            }
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
            report["ownedLayoutRemoved"] = layoutCleaned;
            report["factsComplete"] = factsComplete;
            report["errors"] = errors;
            report["diagnosticPassed"] = factsComplete && handlesClosed && layoutCleaned && errors.Count == 0;
            Write(output, "access-report.json", report);
        }
        return factsComplete && handlesClosed && layoutCleaned && errors.Count == 0 ? 0 : 1;
    }
}
