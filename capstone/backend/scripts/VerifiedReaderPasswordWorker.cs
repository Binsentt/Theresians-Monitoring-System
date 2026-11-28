using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;

internal static class VerifiedReaderPasswordWorker
{
    private const int ConnectionOk = 0;
    private const int PgResultCommandOk = 1;
    private const int PgResultTuplesOk = 2;

    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
    private static extern IntPtr PQconnectdb(string conninfo);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int PQstatus(IntPtr conn);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
    private static extern IntPtr PQhost(IntPtr conn);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
    private static extern IntPtr PQhostaddr(IntPtr conn);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
    private static extern IntPtr PQport(IntPtr conn);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
    private static extern IntPtr PQdb(IntPtr conn);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
    private static extern IntPtr PQuser(IntPtr conn);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int PQsslInUse(IntPtr conn);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
    private static extern IntPtr PQexec(IntPtr conn, string sql);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
    private static extern IntPtr PQchangePassword(IntPtr conn, string user, IntPtr password);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int PQresultStatus(IntPtr result);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int PQntuples(IntPtr result);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int PQnfields(IntPtr result);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
    private static extern IntPtr PQgetvalue(IntPtr result, int row, int column);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern void PQclear(IntPtr result);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern void PQfinish(IntPtr conn);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int PQlibVersion();

#if TQ_SYNTHETIC
    private const string ServiceAlias = "tq_synthetic_admin";
    private const string DatabaseName = "postgres";
    private const string AdminRole = "tq_transport_owner";
    private const string ExpectedAddress = "127.0.0.1";
#else
    private const string ServiceAlias = "tq_admin_identity";
    private const string DatabaseName = "railway";
    private const string AdminRole = "postgres";
#endif
    private const string TargetRole = "tq_release_preflight_reader";

    private static string PtrString(IntPtr value)
    {
        return value == IntPtr.Zero ? null : Marshal.PtrToStringAnsi(value);
    }

    private static bool ValidateConnectionEnvironment()
    {
        string serviceFile = Environment.GetEnvironmentVariable("PGSERVICEFILE");
        string passfile = Environment.GetEnvironmentVariable("PGPASSFILE");
        string readerPassfile = Environment.GetEnvironmentVariable("TQ_READER_PASSFILE_SOURCE");
        if (String.IsNullOrEmpty(serviceFile) || !Path.IsPathRooted(serviceFile) || !File.Exists(serviceFile) ||
            String.IsNullOrEmpty(passfile) || !Path.IsPathRooted(passfile) || !File.Exists(passfile) ||
            String.IsNullOrEmpty(readerPassfile) || !Path.IsPathRooted(readerPassfile) || !File.Exists(readerPassfile)) return false;
        if (Path.GetFullPath(passfile).Equals(Path.GetFullPath(readerPassfile), StringComparison.OrdinalIgnoreCase) ||
            (File.GetAttributes(serviceFile) & FileAttributes.ReparsePoint) != 0 ||
            (File.GetAttributes(passfile) & FileAttributes.ReparsePoint) != 0 ||
            (File.GetAttributes(readerPassfile) & FileAttributes.ReparsePoint) != 0) return false;
        IDictionary environment = Environment.GetEnvironmentVariables();
        foreach (DictionaryEntry entry in environment)
        {
            string name = Convert.ToString(entry.Key);
            if (name.StartsWith("PG", StringComparison.OrdinalIgnoreCase) &&
                !String.Equals(name, "PGSERVICEFILE", StringComparison.OrdinalIgnoreCase) &&
                !String.Equals(name, "PGPASSFILE", StringComparison.OrdinalIgnoreCase)) return false;
        }
        return true;
    }

    private static bool ScalarIs(IntPtr conn, string sql, string expected)
    {
        IntPtr result = PQexec(conn, sql);
        try
        {
            return result != IntPtr.Zero &&
                PQresultStatus(result) == PgResultTuplesOk &&
                PQntuples(result) == 1 && PQnfields(result) == 1 &&
                String.Equals(PtrString(PQgetvalue(result, 0, 0)), expected, StringComparison.Ordinal);
        }
        finally { if (result != IntPtr.Zero) PQclear(result); }
    }

    private static string RoleSnapshot(IntPtr conn)
    {
        const string sql =
            "SELECT (r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolinherit AND " +
            "NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication AND " +
            "NOT r.rolbypassrls AND (SELECT count(*) FROM pg_catalog.pg_auth_members m " +
            "WHERE m.member=r.oid)=0 AND (SELECT count(*) FROM pg_catalog.pg_auth_members m " +
            "WHERE m.roleid=r.oid)=0)::text || '|' || md5(ROW(r.rolcanlogin," +
            "r.rolsuper,r.rolinherit,r.rolcreatedb,r.rolcreaterole,r.rolreplication," +
            "r.rolbypassrls,r.rolconnlimit,r.rolvaliduntil,r.rolconfig," +
            "(SELECT count(*) FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid)," +
            "(SELECT count(*) FROM pg_catalog.pg_auth_members m WHERE m.roleid=r.oid))::text) " +
            "FROM pg_catalog.pg_roles r " +
            "WHERE r.rolname='tq_release_preflight_reader';";
        IntPtr result = PQexec(conn, sql);
        try
        {
            if (result == IntPtr.Zero || PQresultStatus(result) != PgResultTuplesOk ||
                PQntuples(result) != 1 || PQnfields(result) != 1) return null;
            return PtrString(PQgetvalue(result, 0, 0));
        }
        finally { if (result != IntPtr.Zero) PQclear(result); }
    }

    private static bool RequiredRoleSnapshot(string value)
    {
        return value != null && value.StartsWith("true|", StringComparison.Ordinal) &&
            value.Length == 37 &&
            value.Substring(5).Length == 32;
    }

    private static bool ValidateConnectionIdentity(IntPtr conn, int localPort, int serverPort,
        string expectedAddress)
    {
        if (conn == IntPtr.Zero || PQstatus(conn) != ConnectionOk ||
            PQsslInUse(conn) != 1 ||
            !String.Equals(PtrString(PQhost(conn)), "localhost", StringComparison.OrdinalIgnoreCase) ||
            !String.Equals(PtrString(PQhostaddr(conn)), "127.0.0.1", StringComparison.Ordinal) ||
            !String.Equals(PtrString(PQport(conn)), localPort.ToString(), StringComparison.Ordinal) ||
            !String.Equals(PtrString(PQdb(conn)), DatabaseName, StringComparison.Ordinal) ||
            !String.Equals(PtrString(PQuser(conn)), AdminRole, StringComparison.Ordinal))
            return false;

        string identitySql =
            "SELECT (current_database()='" + DatabaseName + "' AND current_user='" + AdminRole +
            "' AND session_user='" + AdminRole + "' AND " +
            "host(inet_server_addr())='" + expectedAddress + "' AND inet_server_port()=" +
            serverPort.ToString() +
            " AND current_setting('server_version_num')::integer BETWEEN 180000 AND 189999 " +
            "AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=current_user AND r.rolsuper) " +
            "AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_ssl " +
            "WHERE pid=pg_catalog.pg_backend_pid() AND ssl))::text;";
        return ScalarIs(conn, identitySql, "true");
    }

    private static void AddPassfileFieldAndClear(List<byte[]> fields, List<byte> field)
    {
        fields.Add(field.ToArray());
        for (int index = 0; index < field.Count; index++) field[index] = 0;
        field.Clear();
    }

    private static byte[] ReadSecretFromPassfile(string path, int port, string role, string database)
    {
        byte[] raw = null;
        var fields = new List<byte[]>();
        var field = new List<byte>(128);
        try
        {
            if (String.IsNullOrEmpty(path) || !Path.IsPathRooted(path) || !File.Exists(path) ||
                (File.GetAttributes(path) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) return null;
            var info = new FileInfo(path);
            if (info.Length < 8 || info.Length > 8192) return null;
            raw = File.ReadAllBytes(path);
            if (raw.Length != info.Length || raw.Length == 0 || raw[0] == 0xEF) return null;
            if (raw[raw.Length - 1] != 10) return null;
            int contentLength = raw.Length - 1;
            if (contentLength > 0 && raw[contentLength - 1] == 13) contentLength--;
            if (contentLength <= 0) return null;

            for (int index = 0; index < contentLength; index++)
            {
                byte value = raw[index];
                if (value == 10 || value == 13 || value == 0 || value < 33 || value > 126) return null;
                if (value == 92)
                {
                    if (++index >= contentLength || (raw[index] != 58 && raw[index] != 92)) return null;
                    field.Add(raw[index]);
                }
                else if (value == 58)
                {
                    AddPassfileFieldAndClear(fields, field);
                }
                else field.Add(value);
            }
            AddPassfileFieldAndClear(fields, field);
            if (fields.Count != 5 || fields[4].Length == 0 || fields[4].Length > 4096) return null;
            if (!String.Equals(Encoding.ASCII.GetString(fields[0]), "localhost", StringComparison.Ordinal) ||
                !String.Equals(Encoding.ASCII.GetString(fields[1]), port.ToString(), StringComparison.Ordinal) ||
                !String.Equals(Encoding.ASCII.GetString(fields[2]), database, StringComparison.Ordinal) ||
                !String.Equals(Encoding.ASCII.GetString(fields[3]), role, StringComparison.Ordinal)) return null;
            for (int index = 0; index < fields[4].Length; index++)
            {
                if (fields[4][index] < 33 || fields[4][index] > 126) return null;
            }
            return (byte[])fields[4].Clone();
        }
        finally
        {
            if (raw != null) Array.Clear(raw, 0, raw.Length);
            foreach (byte[] item in fields) Array.Clear(item, 0, item.Length);
            if (field.Count > 0) field.Clear();
        }
    }

    private static IntPtr ToUnmanagedSecret(byte[] secret)
    {
        IntPtr pointer = Marshal.AllocHGlobal(secret.Length + 1);
        try
        {
            Marshal.Copy(secret, 0, pointer, secret.Length);
            Marshal.WriteByte(pointer, secret.Length, 0);
            return pointer;
        }
        catch
        {
            for (int i = 0; i <= secret.Length; i++) Marshal.WriteByte(pointer, i, 0);
            Marshal.FreeHGlobal(pointer);
            throw;
        }
    }

    private static void ZeroAndFree(IntPtr pointer, int length)
    {
        if (pointer == IntPtr.Zero) return;
        for (int index = 0; index <= length; index++) Marshal.WriteByte(pointer, index, 0);
        Marshal.FreeHGlobal(pointer);
    }

    private static bool CommandOk(IntPtr conn, string sql)
    {
        IntPtr result = PQexec(conn, sql);
        try { return result != IntPtr.Zero && PQresultStatus(result) == PgResultCommandOk; }
        finally { if (result != IntPtr.Zero) PQclear(result); }
    }

    private static bool HasScramVerifier(IntPtr conn, string role)
    {
        string sql = "SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_authid WHERE rolname='" +
            role + "' AND rolpassword LIKE 'SCRAM-SHA-256$%')::text;";
        return ScalarIs(conn, sql, "true");
    }

    public static int Main(string[] args)
    {
        int localPort;
        int serverPort;
        string mode;
        string expectedAddress;
#if TQ_SYNTHETIC
        if (args.Length != 2 || !Int32.TryParse(args[0], out localPort) ||
            localPort < 1024 || localPort > 65535 ||
            (args[1] != "sync" && args[1] != "bootstrap-admin")) return 10;
        serverPort = localPort;
        mode = args[1];
        expectedAddress = ExpectedAddress;
#else
        if (args.Length != 0) return 10;
        localPort = 55432;
        serverPort = 5432;
        mode = "sync";
        expectedAddress = Environment.GetEnvironmentVariable("TQ_EXPECTED_PG_SERVER_ADDRESS");
        IPAddress parsedAddress;
        if (String.IsNullOrEmpty(expectedAddress) ||
            !IPAddress.TryParse(expectedAddress, out parsedAddress) ||
            parsedAddress.AddressFamily != AddressFamily.InterNetwork ||
            !String.Equals(parsedAddress.ToString(), expectedAddress, StringComparison.Ordinal))
        {
            Console.WriteLine("EXPECTED_TARGET_ANCHOR=FAIL");
            return 12;
        }
#endif
        if (PQlibVersion() / 10000 != 18) return 11;
        if (!ValidateConnectionEnvironment())
        {
            Console.WriteLine("CONNECTION_PROFILE_ENV=FAIL");
            return 13;
        }

        IntPtr conn = IntPtr.Zero;
        byte[] secret = null;
        IntPtr secretPointer = IntPtr.Zero;
        int secretLength = 0;
        try
        {
            conn = PQconnectdb("service=" + ServiceAlias +
                " sslmode=verify-full connect_timeout=10 options='-c default_transaction_read_only=on -c statement_timeout=8000 -c lock_timeout=2000'");
            if (conn == IntPtr.Zero || PQstatus(conn) != ConnectionOk)
            {
                Console.WriteLine("AUTH_OR_TLS=FAIL");
                return 20;
            }
            Console.WriteLine("AUTH_OR_TLS=PASS");

            if (!ValidateConnectionIdentity(conn, localPort, serverPort, expectedAddress))
            {
                Console.WriteLine("TARGET_IDENTITY=FAIL");
                return 21;
            }
            Console.WriteLine("TARGET_IDENTITY=PASS");

            string before = null;
            string roleToChange = TargetRole;
            if (mode == "sync")
            {
                before = RoleSnapshot(conn);
                if (!RequiredRoleSnapshot(before))
                {
                    Console.WriteLine("READER_ROLE_CONTRACT=FAIL");
                    return 22;
                }
                Console.WriteLine("READER_ROLE_CONTRACT=PASS");
            }
#if TQ_SYNTHETIC
            else
            {
                roleToChange = AdminRole;
            }
#endif

            if (!ScalarIs(conn, "SHOW default_transaction_read_only;", "on") ||
                !ScalarIs(conn, "SHOW statement_timeout;", "8s") ||
                !ScalarIs(conn, "SHOW lock_timeout;", "2s"))
            {
                Console.WriteLine("READ_ONLY_OR_BOUNDS=FAIL");
                return 28;
            }
            Console.WriteLine("READ_ONLY_OR_BOUNDS=PASS");

            secret = ReadSecretFromPassfile(
                Environment.GetEnvironmentVariable("TQ_READER_PASSFILE_SOURCE"),
                localPort, roleToChange, DatabaseName);
            if (secret == null)
            {
                Console.WriteLine("SECRET_INPUT=FAIL");
                return 23;
            }
            secretLength = secret.Length;
            secretPointer = ToUnmanagedSecret(secret);
            Array.Clear(secret, 0, secret.Length);
            secret = null;

            if (!CommandOk(conn, "SET default_transaction_read_only=off;") ||
                !CommandOk(conn, "SET password_encryption='scram-sha-256';") ||
                !CommandOk(conn, "SET statement_timeout='8s';") ||
                !CommandOk(conn, "SET lock_timeout='2s';") ||
                !ScalarIs(conn, "SHOW password_encryption;", "scram-sha-256") ||
                !ScalarIs(conn, "SHOW default_transaction_read_only;", "off"))
            {
                Console.WriteLine("SCRAM_OR_BOUNDS=FAIL");
                return 24;
            }
            Console.WriteLine("SCRAM_OR_BOUNDS=PASS");

            Console.WriteLine("PASSWORD_CHANGE_ATTEMPTED=TRUE");
            IntPtr changed = PQchangePassword(conn, roleToChange, secretPointer);
            try
            {
                if (changed == IntPtr.Zero || PQresultStatus(changed) != PgResultCommandOk)
                {
                    Console.WriteLine("PASSWORD_SYNC=FAIL");
                    return 25;
                }
            }
            finally { if (changed != IntPtr.Zero) PQclear(changed); }
            Console.WriteLine("PASSWORD_SYNC_OPERATION=PASS");

            if (!CommandOk(conn, "SET default_transaction_read_only=on;") ||
                !ScalarIs(conn, "SHOW default_transaction_read_only;", "on"))
            {
                Console.WriteLine("SESSION_READONLY_RESTORE=FAIL");
                return 29;
            }
            Console.WriteLine("SESSION_READONLY_RESTORE=PASS");

            if (mode == "sync")
            {
                string after = RoleSnapshot(conn);
                if (!String.Equals(before, after, StringComparison.Ordinal) ||
                    !RequiredRoleSnapshot(after))
                {
                    Console.WriteLine("ROLE_PROPERTIES_UNCHANGED=FAIL");
                    return 26;
                }
                Console.WriteLine("ROLE_PROPERTIES_UNCHANGED=PASS");
            }

            if (!HasScramVerifier(conn, roleToChange))
            {
                Console.WriteLine("SCRAM_VERIFIER=FAIL");
                return 27;
            }
            Console.WriteLine("SCRAM_VERIFIER=PASS");
#if TQ_SYNTHETIC
            if (mode == "bootstrap-admin")
            {
                Console.WriteLine("BOOTSTRAP=PASS");
                return 0;
            }
#endif
            Console.WriteLine("PASSWORD_SYNC=PASS");
            Console.WriteLine("SYNC=PASS");
            return 0;
        }
        catch
        {
            Console.WriteLine("WORKER=STOP");
            return 99;
        }
        finally
        {
            if (secret != null) Array.Clear(secret, 0, secret.Length);
            ZeroAndFree(secretPointer, secretLength);
            if (conn != IntPtr.Zero) PQfinish(conn);
        }
    }
}
