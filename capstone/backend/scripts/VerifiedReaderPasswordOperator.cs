using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

// This gate has no SQL or password-changing implementation. Both builds invoke
// the existing worker callback only after the same authorization and file gates.
internal static class VerifiedReaderPasswordOperator
{
    private const string Operation = "reader-password-sync";
    private const string ProductionCaDerSha256 = "9a84d18ed0bb44450d38da6f35a3c4e22ad68192a0c91a2c96dd16e5c17c04df";
    private const int Failure = 31;
    private const uint SafeSearch = 0x00000800 | 0x00000400; // SYSTEM32 | USER_DIRS
    private const uint SafeLoad = 0x00000100 | 0x00000800; // DLL_LOAD_DIR | SYSTEM32
    private static readonly string[] RequiredKeys = {
        "formatVersion", "operation", "operationId", "issuedUtc", "expiresUtc",
        "sourceCommit", "repositoryRoot", "tunnelPort", "serverPort", "targetServerAddress",
        "adminServiceFile", "adminServiceSha256", "adminPassfile", "adminPassfileSha256",
        "readerServiceFile", "readerServiceSha256", "readerPassfile", "readerPassfileSha256",
        "rootCaFile", "rootCaSha256", "executableSha256", "gateSourceSha256", "workerSourceSha256",
        "supervisorSourceSha256", "gitExecutable", "gitSha256", "nativeDirectory", "journalDirectory"
    };

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetDefaultDllDirectories(uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr AddDllDirectory(string directory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetModuleFileName(IntPtr module, StringBuilder name, int size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint desiredAccess, uint shareMode,
        IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation info);
    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        internal uint Attributes;
        internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, LastAccess, LastWrite;
        internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    private sealed class GateFailure : Exception
    {
        internal readonly string Category;
        internal GateFailure(string category) { Category = category; }
    }
    private static void Require(bool condition, string category)
    { if (!condition) throw new GateFailure(category); }

    private static string FullPath(string path)
    {
        Require(path != null && Regex.IsMatch(path, @"\A[A-Za-z]:[\\/]") &&
            path.IndexOf(':', 2) < 0 && path.IndexOfAny(new char[] { '\r', '\n', '\0', '"' }) < 0,
            "LOCAL_PATH");
        string full = Path.GetFullPath(path).TrimEnd('\\', '/');
        Require(String.Equals(full, path.Replace('/', '\\').TrimEnd('\\'), StringComparison.OrdinalIgnoreCase),
            "CANONICAL_PATH");
        return full;
    }
    private static bool SamePath(string a, string b)
    { return String.Equals(FullPath(a), FullPath(b), StringComparison.OrdinalIgnoreCase); }
    private static bool Under(string path, string directory)
    {
        string value = FullPath(path), parent = FullPath(directory);
        return value.Equals(parent, StringComparison.OrdinalIgnoreCase) ||
            value.StartsWith(parent + "\\", StringComparison.OrdinalIgnoreCase);
    }
    private static string Sha256(byte[] bytes)
    {
        using (SHA256 sha = SHA256.Create())
            return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
    }
    private static string Sha256(Stream stream)
    {
        stream.Position = 0;
        using (SHA256 sha = SHA256.Create())
        {
            string hash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            stream.Position = 0;
            return hash;
        }
    }

    private static string UserSid()
    { return WindowsIdentity.GetCurrent().User.Value; }
    private static bool TrustedSid(string sid)
    { return sid == UserSid() || sid == "S-1-5-18" || sid == "S-1-5-32-544"; }

    // Only the invoking user, SYSTEM and Administrators may replace a private
    // input. Exact DACLs also avoid inherited deny/allow ordering ambiguities.
    private static void ExactAcl(string path, bool directory)
    {
        FileSystemSecurity acl = directory ? (FileSystemSecurity)Directory.GetAccessControl(path) : File.GetAccessControl(path);
        Require(acl.AreAccessRulesProtected, "PRIVATE_ACL_INHERITANCE");
        Require(acl.GetOwner(typeof(SecurityIdentifier)).Value == UserSid(), "PRIVATE_ACL_OWNER");
        AuthorizationRuleCollection rules = acl.GetAccessRules(true, true, typeof(SecurityIdentifier));
        HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (FileSystemAccessRule rule in rules)
        {
            string sid = rule.IdentityReference.Value;
            Require(!rule.IsInherited && rule.AccessControlType == AccessControlType.Allow &&
                rule.FileSystemRights == FileSystemRights.FullControl && TrustedSid(sid) &&
                (rule.InheritanceFlags == InheritanceFlags.None || (directory &&
                    rule.InheritanceFlags == (InheritanceFlags.ObjectInherit | InheritanceFlags.ContainerInherit))) &&
                rule.PropagationFlags == PropagationFlags.None &&
                seen.Add(sid), "PRIVATE_ACL_RULE");
        }
        Require(rules.Count == 3 && seen.Count == 3, "PRIVATE_ACL_COUNT");
    }

    // Installed Git may retain ordinary read-only Program Files ACL entries.
    // Its exact approved file hash is checked separately before execution.
    private static void TrustedToolAcl(string path, bool directory)
    {
        FileSystemSecurity acl = directory ? (FileSystemSecurity)Directory.GetAccessControl(path) : File.GetAccessControl(path);
        Require(TrustedSid(acl.GetOwner(typeof(SecurityIdentifier)).Value) ||
            acl.GetOwner(typeof(SecurityIdentifier)).Value == "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", "TOOL_OWNER");
        const FileSystemRights mutation = FileSystemRights.Write | FileSystemRights.Delete |
            FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            Require(rule.AccessControlType != AccessControlType.Allow || TrustedSid(rule.IdentityReference.Value) ||
                rule.IdentityReference.Value == "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464" ||
                (rule.FileSystemRights & mutation) == 0, "TOOL_ACL");
    }

    private sealed class HeldFiles : IDisposable
    {
        private readonly List<IDisposable> held = new List<IDisposable>();
        private readonly Dictionary<FileStream, string> hashes = new Dictionary<FileStream, string>();
        private readonly HashSet<string> directories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        internal void HoldAncestors(string path)
        {
            string full = FullPath(path);
            string cursor = Path.GetPathRoot(full);
            Require(new DriveInfo(cursor).DriveType == DriveType.Fixed &&
                (File.GetAttributes(cursor) & FileAttributes.ReparsePoint) == 0, "LOCAL_DRIVE");
            foreach (string component in full.Substring(cursor.Length).Split('\\'))
            {
                if (component.Length == 0) continue;
                cursor = Path.Combine(cursor, component);
                FileAttributes attributes = File.GetAttributes(cursor);
                Require((attributes & FileAttributes.ReparsePoint) == 0, "REPARSE_POINT");
                if ((attributes & FileAttributes.Directory) != 0 && directories.Add(cursor))
                {
                    // No FILE_SHARE_DELETE: an ancestor cannot be renamed while
                    // the inputs are validated and consumed by libpq.
                    SafeFileHandle handle = CreateFile(cursor, 0x80, 1 | 2, IntPtr.Zero, 3,
                        0x02000000 | 0x00200000, IntPtr.Zero);
                    Require(!handle.IsInvalid, "DIRECTORY_LOCK");
                    held.Add(handle);
                    FileInformation information;
                    Require(GetFileInformationByHandle(handle, out information) &&
                        (information.Attributes & (uint)FileAttributes.ReparsePoint) == 0, "REPARSE_POINT");
                }
            }
        }
        internal FileStream Open(string path, string expectedHash, string repository, bool exactAcl)
        {
            path = FullPath(path);
            Require(!Under(path, repository), "PRIVATE_INPUT_IN_SOURCE");
            HoldAncestors(path);
            Require((File.GetAttributes(path) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0, "REGULAR_FILE");
            string parent = Path.GetDirectoryName(path);
            if (exactAcl) { ExactAcl(parent, true); ExactAcl(path, false); }
            else { TrustedToolAcl(parent, true); TrustedToolAcl(path, false); }
            FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            held.Add(stream);
            FileInformation information;
            Require(GetFileInformationByHandle(stream.SafeFileHandle, out information) &&
                (!exactAcl || information.Links == 1), "HARD_LINK");
            Require(stream.Length > 0 && stream.Length <= 268435456 && Sha256(stream) == expectedHash, "FILE_HASH");
            hashes.Add(stream, expectedHash);
            return stream;
        }
        internal void SourceFile(string path, string expectedHash)
        {
            HoldAncestors(path);
            Require((File.GetAttributes(path) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0, "SOURCE_FILE");
            FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            held.Add(stream);
            Require(stream.Length > 0 && stream.Length <= 1048576 && Sha256(stream) == expectedHash, "SOURCE_HASH");
            hashes.Add(stream, expectedHash);
        }
        internal void Unchanged()
        {
            foreach (KeyValuePair<FileStream, string> pair in hashes)
                Require(Sha256(pair.Key) == pair.Value, "INPUT_CHANGED");
        }
        public void Dispose()
        { for (int i = held.Count - 1; i >= 0; i--) held[i].Dispose(); }
    }

    private static byte[] Bytes(FileStream stream, int maximum)
    {
        Require(stream.Length > 0 && stream.Length <= maximum, "INPUT_SIZE");
        byte[] bytes = new byte[(int)stream.Length];
        int offset = 0;
        stream.Position = 0;
        while (offset < bytes.Length)
        {
            int count = stream.Read(bytes, offset, bytes.Length - offset);
            Require(count > 0, "INPUT_READ"); offset += count;
        }
        stream.Position = 0;
        return bytes;
    }
    private static string Ascii(byte[] bytes)
    {
        foreach (byte value in bytes)
            Require(value == 10 || value == 13 || (value >= 32 && value <= 126), "ASCII_INPUT");
        string text = Encoding.ASCII.GetString(bytes);
        Require(text.IndexOf('\r') < 0 || text.Replace("\r\n", "").IndexOf('\r') < 0, "LINE_ENDING");
        return text.Replace("\r\n", "\n");
    }
    private static Dictionary<string, string> Envelope(byte[] bytes)
    {
        string text = Ascii(bytes);
        Require(text.EndsWith("\n", StringComparison.Ordinal), "AUTH_FORMAT");
        Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.Ordinal);
        HashSet<string> required = new HashSet<string>(RequiredKeys, StringComparer.Ordinal);
        foreach (string line in text.Substring(0, text.Length - 1).Split('\n'))
        {
            int split = line.IndexOf('=');
            Require(split > 0 && split < line.Length - 1, "AUTH_FORMAT");
            string key = line.Substring(0, split), value = line.Substring(split + 1);
            Require((required.Contains(key) || Regex.IsMatch(key, @"\Anative\.[a-z0-9][a-z0-9._-]*\.dll\z")) &&
                value.Trim() == value && !values.ContainsKey(key), "AUTH_KEYS");
            values.Add(key, value);
        }
        foreach (string key in RequiredKeys) Require(values.ContainsKey(key), "AUTH_KEYS");
        foreach (KeyValuePair<string, string> field in values)
            if (field.Key.EndsWith("Sha256", StringComparison.Ordinal) || field.Key.StartsWith("native.", StringComparison.Ordinal))
                Require(Regex.IsMatch(field.Value, @"\A[0-9a-f]{64}\z"), "HASH_FORMAT");
        Require(values["formatVersion"] == "1" && values["operation"] == Operation &&
            Regex.IsMatch(values["operationId"], @"\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z") &&
            Regex.IsMatch(values["sourceCommit"], @"\A[0-9a-f]{40}\z"), "AUTH_SCOPE");
        return values;
    }
    private static void AuthorizationTime(Dictionary<string, string> values)
    {
        DateTime issued = DateTime.MinValue, expires = DateTime.MinValue;
        const DateTimeStyles styles = DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal;
        Require(DateTime.TryParseExact(values["issuedUtc"], "yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture, styles, out issued) &&
            DateTime.TryParseExact(values["expiresUtc"], "yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture, styles, out expires), "AUTH_TIME");
        DateTime now = DateTime.UtcNow;
        Require(issued <= now && expires > now && expires > issued && expires - issued <= TimeSpan.FromHours(1), "AUTH_TIME");
    }

    private static string Git(string executable, string repository, string command, bool emptyAllowed = false)
    {
        ProcessStartInfo start = new ProcessStartInfo(executable,
            "--no-replace-objects -c core.fsmonitor=false -c core.untrackedCache=false -c core.hooksPath=NUL -C \"" + repository + "\" " + command);
        start.UseShellExecute = false; start.CreateNoWindow = true;
        start.RedirectStandardOutput = true; start.RedirectStandardError = true;
        List<string> remove = new List<string>();
        foreach (string name in start.EnvironmentVariables.Keys)
            if (name.StartsWith("GIT", StringComparison.OrdinalIgnoreCase)) remove.Add(name);
        foreach (string name in remove) start.EnvironmentVariables.Remove(name);
        start.EnvironmentVariables["GIT_CONFIG_NOSYSTEM"] = "1";
        start.EnvironmentVariables["GIT_CONFIG_GLOBAL"] = "NUL";
        start.EnvironmentVariables["GIT_ATTR_NOSYSTEM"] = "1";
        start.EnvironmentVariables["GIT_NO_LAZY_FETCH"] = "1";
        start.EnvironmentVariables["GIT_TERMINAL_PROMPT"] = "0";
        using (Process process = Process.Start(start))
        {
            // Async draining avoids a full stdout/stderr pipe bypassing timeout.
            StringBuilder output = new StringBuilder();
            bool overflow = false;
            using (System.Threading.ManualResetEvent outputClosed = new System.Threading.ManualResetEvent(false))
            using (System.Threading.ManualResetEvent errorClosed = new System.Threading.ManualResetEvent(false))
            {
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) {
                if (e.Data == null) outputClosed.Set();
                else lock (output) { if (output.Length + e.Data.Length > 1048576) overflow = true; else output.AppendLine(e.Data); }
            };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data == null) errorClosed.Set(); };
            process.BeginOutputReadLine(); process.BeginErrorReadLine();
            if (!process.WaitForExit(10000)) { try { process.Kill(); } catch { } throw new GateFailure("SOURCE_TIMEOUT"); }
            Require(System.Threading.WaitHandle.WaitAll(new System.Threading.WaitHandle[] { outputClosed, errorClosed }, 1000), "SOURCE_OUTPUT_TIMEOUT");
            Require(!overflow && (process.ExitCode == 0 || (emptyAllowed && process.ExitCode == 1 && output.Length == 0)), "SOURCE_GIT");
            return output.ToString().Trim();
            }
        }
    }

    private static void Source(Dictionary<string, string> values, string repository, string expectedCommit, HeldFiles held)
    {
        Require(values["sourceCommit"] == expectedCommit && SamePath(values["repositoryRoot"], repository), "SOURCE_PIN");
        string git = FullPath(values["gitExecutable"]);
        Require(Git(git, repository, "config --get-regexp \"^filter\\.\"", true).Length == 0, "SOURCE_FILTERS");
        Require(!Regex.IsMatch(Git(git, repository, "ls-files --stage"), @"(?m)^160000 "), "SOURCE_SUBMODULE");
        Require(SamePath(Git(git, repository, "rev-parse --show-toplevel"), repository) &&
            Git(git, repository, "rev-parse HEAD") == expectedCommit &&
            Git(git, repository, "status --porcelain=v1 --untracked-files=all --ignore-submodules=all").Length == 0, "SOURCE_CLEAN");
        string scriptRoot = Path.Combine(repository, @"capstone\backend\scripts");
        foreach (string[] pair in new string[][] {
            new string[] { "VerifiedReaderPasswordOperator.cs", "gateSourceSha256" },
            new string[] { "VerifiedReaderPasswordWorker.cs", "workerSourceSha256" },
            new string[] { "productionReaderPasswordOperator.cjs", "supervisorSourceSha256" } })
        {
            string file = Path.Combine(scriptRoot, pair[0]);
            held.SourceFile(file, values[pair[1]]);
            Require(Git(git, repository, "ls-files --error-unmatch -- \"capstone/backend/scripts/" + pair[0] + "\"").Length > 0, "SOURCE_TRACKED");
        }
    }

    private static void Service(FileStream file, string alias, string database, string role, int port, string ca)
    {
        string text = Ascii(Bytes(file, 16384));
        Dictionary<string, string> settings = new Dictionary<string, string>(StringComparer.Ordinal);
        string section = null;
        foreach (string raw in text.Split('\n'))
        {
            if (raw.Length == 0) continue;
            string line = raw.Trim();
            if (line.StartsWith("[", StringComparison.Ordinal))
            {
                Require(section == null && line == "[" + alias + "]", "SERVICE_SECTION"); section = alias; continue;
            }
            int split = line.IndexOf('=');
            Require(section != null && split > 0 && split < line.Length - 1, "SERVICE_FORMAT");
            string key = line.Substring(0, split).Trim(), value = line.Substring(split + 1).Trim();
            Require(!settings.ContainsKey(key) && value.IndexOfAny(new char[] { '#', ';', '\'', '"' }) < 0, "SERVICE_FORMAT");
            settings.Add(key, value);
        }
        Dictionary<string, string> expected = new Dictionary<string, string> {
            { "host", "localhost" }, { "hostaddr", "127.0.0.1" }, { "port", port.ToString(CultureInfo.InvariantCulture) },
            { "dbname", database }, { "user", role }, { "sslmode", "verify-full" }, { "sslrootcert", ca }
        };
        Require(section == alias && settings.Count == expected.Count, "SERVICE_KEYS");
        foreach (KeyValuePair<string, string> pair in expected)
            Require(settings.ContainsKey(pair.Key) && (pair.Key == "sslrootcert" ? SamePath(settings[pair.Key], pair.Value) :
                settings[pair.Key] == pair.Value), "SERVICE_TARGET_TLS");
    }

    private static void Passfile(FileStream file, string database, string role, int port)
    {
        byte[] bytes = Bytes(file, 8192);
        List<byte[]> fields = new List<byte[]>();
        List<byte> field = new List<byte>();
        try
        {
            Require(bytes[bytes.Length - 1] == 10, "PASSFILE_FORMAT");
            int length = bytes.Length - 1;
            if (length > 0 && bytes[length - 1] == 13) length--;
            for (int i = 0; i < length; i++)
            {
                byte value = bytes[i];
                Require(value >= 33 && value <= 126, "PASSFILE_FORMAT");
                if (value == 92) { Require(++i < length && (bytes[i] == 58 || bytes[i] == 92), "PASSFILE_ESCAPE"); field.Add(bytes[i]); }
                else if (value == 58) { fields.Add(field.ToArray()); for (int j = 0; j < field.Count; j++) field[j] = 0; field.Clear(); }
                else field.Add(value);
            }
            fields.Add(field.ToArray());
            string[] expected = { "localhost", port.ToString(CultureInfo.InvariantCulture), database, role };
            Require(fields.Count == 5 && fields[4].Length > 0 && fields[4].Length <= 4096, "PASSFILE_TUPLE");
            for (int i = 0; i < 4; i++) Require(Encoding.ASCII.GetString(fields[i]) == expected[i], "PASSFILE_TUPLE");
        }
        finally
        {
            Array.Clear(bytes, 0, bytes.Length);
            foreach (byte[] item in fields) Array.Clear(item, 0, item.Length);
            for (int j = 0; j < field.Count; j++) field[j] = 0;
            field.Clear();
        }
    }

    private static void Certificate(FileStream file)
    {
        string pem = Ascii(Bytes(file, 32768));
        Match match = Regex.Match(pem, @"\A-----BEGIN CERTIFICATE-----\n([A-Za-z0-9+/=\n]+)-----END CERTIFICATE-----\n?\z");
        Require(match.Success, "CA_PEM");
        string base64 = match.Groups[1].Value.Replace("\n", "");
        byte[] der = Convert.FromBase64String(base64);
        Require(Convert.ToBase64String(der) == base64, "CA_PEM");
        using (X509Certificate2 cert = new X509Certificate2(der))
        {
            bool isCa = false;
            foreach (X509Extension extension in cert.Extensions)
                if (extension.Oid.Value == "2.5.29.19")
                    isCa = new X509BasicConstraintsExtension(extension, extension.Critical).CertificateAuthority;
            Require(isCa && cert.Subject == cert.Issuer && cert.NotBefore.ToUniversalTime() <= DateTime.UtcNow &&
                cert.NotAfter.ToUniversalTime() > DateTime.UtcNow &&
                Convert.ToBase64String(cert.RawData) == base64, "CA_CONSTRAINTS");
#if !TQ_SYNTHETIC
            Require(Sha256(der) == ProductionCaDerSha256, "CA_PRODUCTION_PIN");
#endif
        }
    }

    private static FileSecurity NewFileAcl()
    {
        FileSecurity acl = new FileSecurity();
        acl.SetOwner(new SecurityIdentifier(UserSid())); acl.SetAccessRuleProtection(true, false);
        foreach (string sid in new string[] { UserSid(), "S-1-5-18", "S-1-5-32-544" })
            acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, AccessControlType.Allow));
        return acl;
    }
    private static FileStream JournalFile(string path, FileMode mode, FileShare share)
    {
        bool existing = File.Exists(path);
        if (mode == FileMode.OpenOrCreate) mode = existing ? FileMode.Open : FileMode.CreateNew;
        FileStream stream = new FileStream(path, mode, FileSystemRights.FullControl, share, 4096,
            FileOptions.WriteThrough, NewFileAcl());
        try
        {
            // CreateFile's SECURITY_ATTRIBUTES does not consistently retain the
            // protected-DACL control bit; apply it explicitly to this new file.
            if (!existing) stream.SetAccessControl(NewFileAcl());
            ExactAcl(path, false);
            return stream;
        }
        catch { stream.Dispose(); throw; }
    }
    private static void Append(FileStream file, string text)
    {
        byte[] bytes = Encoding.ASCII.GetBytes(text + "\n");
        file.Seek(0, SeekOrigin.End); file.Write(bytes, 0, bytes.Length); file.Flush(true);
    }

    private static void LoadNative(Dictionary<string, string> values, HeldFiles held, string repository)
    {
        string directory = FullPath(values["nativeDirectory"]);
        Require(!Under(directory, repository), "NATIVE_IN_SOURCE");
        held.HoldAncestors(directory); ExactAcl(directory, true);
        HashSet<string> manifest = new HashSet<string>(StringComparer.Ordinal);
        foreach (KeyValuePair<string, string> pair in values)
            if (pair.Key.StartsWith("native.", StringComparison.Ordinal)) manifest.Add(pair.Key.Substring(7));
        Require(manifest.Contains("libpq.dll"), "NATIVE_MANIFEST");
        string[] files = Directory.GetFiles(directory, "*.dll");
        Require(files.Length == manifest.Count, "NATIVE_MANIFEST");
        foreach (string file in files)
        {
            string name = Path.GetFileName(file).ToLowerInvariant();
            Require(manifest.Remove(name), "NATIVE_MANIFEST");
            held.Open(file, values["native." + name], repository, true);
        }
        Require(manifest.Count == 0 && SetDefaultDllDirectories(SafeSearch) &&
            AddDllDirectory(directory) != IntPtr.Zero, "NATIVE_SEARCH");
        string libpq = Path.Combine(directory, "libpq.dll");
        IntPtr module = LoadLibraryEx(libpq, IntPtr.Zero, SafeLoad);
        Require(module != IntPtr.Zero, "NATIVE_LOAD");
        StringBuilder loaded = new StringBuilder(32768);
        uint count = GetModuleFileName(module, loaded, loaded.Capacity);
        Require(count > 0 && count < loaded.Capacity && SamePath(loaded.ToString(), libpq), "NATIVE_MODULE");
        // Loaded modules and the search policy remain fixed for this one-shot
        // process. Held file handles prevent their replacement until exit.
    }

    public static int Run(string[] args, Func<int, int, string, int> worker)
    {
        bool claimed = false;
        try
        {
            Require(Environment.OSVersion.Platform == PlatformID.Win32NT && args != null && args.Length == 4 && worker != null,
                "ARGUMENTS");
            Require(Regex.IsMatch(args[1], @"\A[0-9a-f]{64}\z") && Regex.IsMatch(args[3], @"\A[0-9a-f]{40}\z"), "INDEPENDENT_PIN");
            foreach (DictionaryEntry pair in Environment.GetEnvironmentVariables())
            {
                string name = Convert.ToString(pair.Key);
                Require(!name.StartsWith("PG", StringComparison.OrdinalIgnoreCase) &&
                    !name.Equals("DATABASE_URL", StringComparison.OrdinalIgnoreCase) &&
                    !name.Equals("DB_SSL", StringComparison.OrdinalIgnoreCase) &&
                    !name.Equals("TQ_READER_PASSFILE_SOURCE", StringComparison.OrdinalIgnoreCase), "AMBIENT_CONNECTION");
            }
            string repository = FullPath(args[2]);
            using (HeldFiles held = new HeldFiles())
            {
                held.HoldAncestors(repository);
                FileStream auth = held.Open(args[0], args[1], repository, true);
                Dictionary<string, string> values = Envelope(Bytes(auth, 65536));
                AuthorizationTime(values);
                int localPort = 0, serverPort = 0;
                Require(Int32.TryParse(values["tunnelPort"], out localPort) && localPort >= 1024 && localPort <= 65535 &&
                    values["tunnelPort"] == localPort.ToString(CultureInfo.InvariantCulture) &&
                    Int32.TryParse(values["serverPort"], out serverPort) && serverPort > 0 && serverPort <= 65535 &&
                    values["serverPort"] == serverPort.ToString(CultureInfo.InvariantCulture), "TARGET_PORT");
                System.Net.IPAddress address;
                Require(System.Net.IPAddress.TryParse(values["targetServerAddress"], out address) &&
                    address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork &&
                    address.ToString() == values["targetServerAddress"], "TARGET_ADDRESS");
#if TQ_SYNTHETIC
                const string database = "postgres", adminRole = "tq_transport_owner", adminAlias = "tq_synthetic_admin", readerAlias = "tq_synthetic_reader";
                Require(serverPort == localPort && values["targetServerAddress"] == "127.0.0.1", "SYNTHETIC_TARGET");
                string privateRoot = Path.GetDirectoryName(FullPath(args[0]));
                Require(SamePath(values["journalDirectory"], Path.Combine(privateRoot, "journal")), "JOURNAL_LOCATION");
#else
                const string database = "railway", adminRole = "postgres", adminAlias = "tq_admin_identity", readerAlias = "tq_release_preflight";
                Require(localPort == 55432 && serverPort == 5432 && !System.Net.IPAddress.IsLoopback(address) &&
                    !address.Equals(System.Net.IPAddress.Any) && !address.Equals(System.Net.IPAddress.Broadcast), "PRODUCTION_TARGET");
                string backupRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Theresians-Production-Backups");
                string privateRoot = Path.Combine(backupRoot, "postgres-preflight");
                Require(SamePath(values["rootCaFile"], Path.Combine(backupRoot, @"postgres-ca-trust\root.crt")) &&
                    SamePath(values["journalDirectory"], Path.Combine(backupRoot, "reader-password-sync-journal")), "PRODUCTION_PATHS");
#endif
                foreach (string[] pair in new string[][] {
                    new string[] { "adminServiceFile", "pg_admin_service.conf" }, new string[] { "adminPassfile", "pg_admin_passfile.conf" },
                    new string[] { "readerServiceFile", "pg_service.conf" }, new string[] { "readerPassfile", "pgpass.conf" } })
                    Require(SamePath(values[pair[0]], Path.Combine(privateRoot, pair[1])), "CREDENTIAL_LOCATION");
                HashSet<string> distinct = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (string key in new string[] { "adminServiceFile", "adminPassfile", "readerServiceFile", "readerPassfile", "rootCaFile" })
                    Require(distinct.Add(FullPath(values[key])), "DISTINCT_INPUTS");
                string executable = FullPath(Assembly.GetExecutingAssembly().Location);
                held.Open(executable, values["executableSha256"], repository, true);
                string executableDirectory = Path.GetDirectoryName(executable);
                Require(Directory.GetFiles(executableDirectory, "*.dll").Length == 0 &&
                    !File.Exists(executable + ".config") && !File.Exists(executable + ".manifest") &&
                    !Directory.Exists(executable + ".local") && !File.Exists(executable + ".local"), "EXECUTABLE_DIRECTORY");
                held.Open(values["gitExecutable"], values["gitSha256"], repository, false);
                Source(values, repository, args[3], held);
                FileStream adminService = held.Open(values["adminServiceFile"], values["adminServiceSha256"], repository, true);
                FileStream adminPass = held.Open(values["adminPassfile"], values["adminPassfileSha256"], repository, true);
                FileStream readerService = held.Open(values["readerServiceFile"], values["readerServiceSha256"], repository, true);
                FileStream readerPass = held.Open(values["readerPassfile"], values["readerPassfileSha256"], repository, true);
                FileStream ca = held.Open(values["rootCaFile"], values["rootCaSha256"], repository, true);
                Service(adminService, adminAlias, database, adminRole, localPort, values["rootCaFile"]);
                Service(readerService, readerAlias, database, "tq_release_preflight_reader", localPort, values["rootCaFile"]);
                Passfile(adminPass, database, adminRole, localPort);
                Passfile(readerPass, database, "tq_release_preflight_reader", localPort);
                Certificate(ca);
                string journal = FullPath(values["journalDirectory"]);
                Require(!Under(journal, repository), "JOURNAL_IN_SOURCE");
                held.HoldAncestors(journal); ExactAcl(journal, true);
                string lockPath = Path.Combine(journal, "operation.lock");
                string claimPath = Path.Combine(journal, "operation.consumed");
                Require(!File.Exists(claimPath), "OPERATION_CONSUMED");
                if (File.Exists(lockPath)) { held.HoldAncestors(lockPath); ExactAcl(lockPath, false); }
                using (FileStream operationLock = JournalFile(lockPath, FileMode.OpenOrCreate, FileShare.None))
                {
                    ExactAcl(lockPath, false);
                    Require(!File.Exists(claimPath), "OPERATION_CONSUMED");
                    LoadNative(values, held, repository);
                    AuthorizationTime(values);
                    // CreateNew is the durable operation-wide single-use claim.
                    // UNKNOWN is flushed before the callback, so a killed process
                    // never represents an interrupted mutation as safe to retry.
                    using (FileStream claim = JournalFile(claimPath, FileMode.CreateNew, FileShare.Read))
                    {
                        claimed = true;
                        Append(claim, "STATE=OUTCOME_UNKNOWN\nEVENT=CLAIMED\noperationId=" + values["operationId"] +
                            "\nsourceCommit=" + args[3] + "\nauthorizationSha256=" + args[1]);
                        string previousService = Environment.GetEnvironmentVariable("PGSERVICEFILE");
                        string previousPass = Environment.GetEnvironmentVariable("PGPASSFILE");
                        string previousReader = Environment.GetEnvironmentVariable("TQ_READER_PASSFILE_SOURCE");
                        try
                        {
                            Environment.SetEnvironmentVariable("PGSERVICEFILE", FullPath(values["adminServiceFile"]));
                            Environment.SetEnvironmentVariable("PGPASSFILE", FullPath(values["adminPassfile"]));
                            Environment.SetEnvironmentVariable("TQ_READER_PASSFILE_SOURCE", FullPath(values["readerPassfile"]));
                            Console.WriteLine("OPERATOR_GATE=PASS");
                            int result = worker(localPort, serverPort, values["targetServerAddress"]);
                            held.Unchanged();
                            Append(claim, "COMPLETED=" + result.ToString(CultureInfo.InvariantCulture));
                            Console.WriteLine(result == 0 ? "OPERATOR_RESULT=PASS" : "OPERATOR_RESULT=UNKNOWN");
                            return result;
                        }
                        finally
                        {
                            Environment.SetEnvironmentVariable("PGSERVICEFILE", previousService);
                            Environment.SetEnvironmentVariable("PGPASSFILE", previousPass);
                            Environment.SetEnvironmentVariable("TQ_READER_PASSFILE_SOURCE", previousReader);
                        }
                    }
                }
            }
        }
        catch (GateFailure error) { Console.WriteLine("OPERATOR_GATE=FAIL:" + error.Category); }
        catch { Console.WriteLine("OPERATOR_GATE=FAIL:CLOSED"); }
        Console.WriteLine(claimed ? "OPERATOR_RESULT=UNKNOWN" : "OPERATOR_RESULT=STOP");
        return Failure;
    }
}
