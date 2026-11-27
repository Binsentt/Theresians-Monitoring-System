// Disposable PostgreSQL 18 integration worker. No production target or secret input.
using System;
using System.Runtime.InteropServices;

internal static class Pg18SyntheticPasswordWorker
{
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
    private static extern IntPtr PQconnectdb(string conninfo);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int PQstatus(IntPtr conn);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
    private static extern IntPtr PQexec(IntPtr conn, string sql);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int PQresultStatus(IntPtr result);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int PQntuples(IntPtr result);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr PQgetvalue(IntPtr result, int row, int column);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr PQresultErrorField(IntPtr result, int fieldcode);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern void PQclear(IntPtr result);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern void PQfinish(IntPtr conn);
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl)]
    private static extern int PQlibVersion();
    [DllImport("libpq.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
    private static extern IntPtr PQchangePassword(IntPtr conn, string user, string password);

    private static bool ScalarTrue(IntPtr conn, string sql)
    {
        IntPtr result = PQexec(conn, sql);
        try
        {
            return result != IntPtr.Zero && PQresultStatus(result) == 2 &&
                PQntuples(result) == 1 &&
                Marshal.PtrToStringAnsi(PQgetvalue(result, 0, 0)) == "t";
        }
        finally { if (result != IntPtr.Zero) PQclear(result); }
    }

    private static bool CommandOk(IntPtr conn, string sql)
    {
        IntPtr result = PQexec(conn, sql);
        try { return result != IntPtr.Zero && PQresultStatus(result) == 1; }
        finally { if (result != IntPtr.Zero) PQclear(result); }
    }

    private static string ReaderDataDirectoryStatus(IntPtr conn)
    {
        IntPtr result = PQexec(conn,
            "SELECT current_setting('data_directory') <> '';");
        try
        {
            if (result == IntPtr.Zero) return "UNAVAILABLE";
            if (PQresultStatus(result) == 2 && PQntuples(result) == 1)
                return Marshal.PtrToStringAnsi(PQgetvalue(result, 0, 0)) == "t" ?
                    "AVAILABLE" : "EMPTY";
            return Marshal.PtrToStringAnsi(PQresultErrorField(result, 67)) ==
                "42501" ? "PERMISSION_DENIED" : "UNAVAILABLE";
        }
        finally { if (result != IntPtr.Zero) PQclear(result); }
    }

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 3 ||
                (args[0] != "admin" && args[0] != "reader" && args[0] != "change" &&
                 args[0] != "bootstrap-owner" && args[0] != "bootstrap-reader") ||
                (args[1] != "tq_transport_owner" && args[1] != "tq_transport_reader") ||
                ((args[0] == "reader") != (args[1] == "tq_transport_reader")) ||
                ((args[0] == "change" || args[0] == "bootstrap-owner" ||
                  args[0] == "bootstrap-reader") && args[1] != "tq_transport_owner"))
                return 10;
            int port;
            if (!int.TryParse(args[2], out port) || port < 1024 || port > 65535 ||
                PQlibVersion() / 10000 != 18)
                return 11;
            string conninfo = "host=127.0.0.1 port=" + port +
                " dbname=postgres user=" + args[1] +
                " connect_timeout=3 sslmode=disable" +
                " options='-c statement_timeout=5000 -c lock_timeout=1000 -c search_path='";
            IntPtr conn = PQconnectdb(conninfo);
            try
            {
                if (conn == IntPtr.Zero || PQstatus(conn) != 0)
                {
                    Console.WriteLine("AUTH=FAIL");
                    return 20;
                }
                Console.WriteLine("AUTH=PASS");
                string role = args[1];
                string core = "SELECT current_database()='postgres' AND current_user='" + role +
                    "' AND session_user='" + role +
                    "' AND host(inet_server_addr())='127.0.0.1' AND inet_server_port()=" + port +
                    " AND current_setting('server_version_num')::int BETWEEN 180000 AND 189999;";
                if (!ScalarTrue(conn, core))
                {
                    Console.WriteLine("CORE_IDENTITY=FAIL");
                    return 21;
                }
                Console.WriteLine("CORE_IDENTITY=PASS");
                if (args[0] == "reader")
                {
                    // Diagnostic only: the original worker included this superuser-only GUC
                    // in the reader's required identity predicate. Never print its value.
                    Console.WriteLine("READER_DATA_DIRECTORY=" +
                        ReaderDataDirectoryStatus(conn));
                    return 0;
                }
                if (args[0] == "admin") return 0;
                string password = Console.In.ReadLine();
                if (String.IsNullOrEmpty(password) || password.Length > 256 ||
                    password.IndexOfAny(new char[] { '\r', '\n', '\0' }) >= 0)
                    return 22;
                if (!CommandOk(conn, "SET statement_timeout='5s'; SET lock_timeout='1s'; " +
                    "SET password_encryption='scram-sha-256';"))
                    return 23;
                string target = args[0] == "bootstrap-owner" ?
                    "tq_transport_owner" : "tq_transport_reader";
                IntPtr changed = PQchangePassword(conn, target, password);
                try
                {
                    if (changed == IntPtr.Zero || PQresultStatus(changed) != 1) return 24;
                    Console.WriteLine("PQ_CHANGE_PASSWORD=PASS");
                    return 0;
                }
                finally { if (changed != IntPtr.Zero) PQclear(changed); password = null; }
            }
            finally { if (conn != IntPtr.Zero) PQfinish(conn); }
        }
        catch
        {
            Console.WriteLine("WORKER_EXCEPTION=SANITIZED");
            return 99;
        }
    }
}
