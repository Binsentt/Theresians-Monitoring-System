-- READ-ONLY assessment, not a writer freeze and not backup authorization.
-- Run with the approved DBA evidence reader, psql --no-psqlrc and
-- --set=ON_ERROR_STOP=1. Keep evidence in the restricted review record.
-- No connection URL, credentials, SQL text, routine bodies, role names,
-- subscription connection strings or application rows are emitted.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';

SELECT 'NO_GO'::text AS production_quiescence,
       'READ_ONLY_ASSESSMENT_ONLY'::text AS evidence_scope,
       current_setting('server_version_num')::integer / 10000 AS postgres_major,
       pg_catalog.pg_is_in_recovery() AS server_in_recovery;

WITH target AS (
  SELECT * FROM pg_catalog.pg_database WHERE datname = current_database()
), public_acl AS (
  SELECT x.privilege_type FROM target d,
    LATERAL pg_catalog.aclexplode(COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) x
  WHERE x.grantee = 0
)
SELECT d.datallowconn AS normal_connections_allowed,
       d.datconnlimit AS connection_limit,
       EXISTS (SELECT FROM public_acl WHERE privilege_type = 'CONNECT') AS public_connect,
       EXISTS (SELECT FROM public_acl WHERE privilege_type = 'CREATE') AS public_create,
       EXISTS (SELECT FROM public_acl WHERE privilege_type = 'TEMPORARY') AS public_temporary,
       (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolcanlogin
         AND pg_catalog.has_database_privilege(r.oid, d.oid, 'CONNECT')) AS login_roles_with_effective_connect,
       (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolcanlogin
         AND pg_catalog.has_database_privilege(r.oid, d.oid, 'CREATE')) AS login_roles_with_effective_create,
       (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolcanlogin
         AND pg_catalog.has_database_privilege(r.oid, d.oid, 'TEMPORARY')) AS login_roles_with_effective_temporary,
       (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolcanlogin
         AND pg_catalog.pg_has_role(r.oid, d.datdba, 'MEMBER')) AS owner_or_owner_member_login_roles
FROM target d;

SELECT count(*) FILTER (WHERE rolcanlogin AND rolsuper) AS superuser_login_roles,
       count(*) FILTER (WHERE rolcanlogin AND rolcreatedb) AS createdb_login_roles,
       count(*) FILTER (WHERE rolcanlogin AND rolcreaterole) AS createrole_login_roles,
       count(*) FILTER (WHERE rolcanlogin AND rolreplication) AS replication_login_roles
FROM pg_catalog.pg_roles;

SELECT backend_type, state, count(*) AS session_count,
       count(*) FILTER (WHERE xact_start IS NOT NULL) AS sessions_with_transactions
FROM pg_catalog.pg_stat_activity
WHERE datid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
GROUP BY backend_type, state ORDER BY backend_type, state;

SELECT count(*) AS prepared_transaction_count
FROM pg_catalog.pg_prepared_xacts WHERE database = current_database();

SELECT (SELECT count(*) FROM pg_catalog.pg_subscription
          WHERE subdbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
            AND subenabled) AS enabled_subscription_count,
       (SELECT count(*) FROM pg_catalog.pg_foreign_table) AS foreign_table_count,
       (SELECT count(*) FROM pg_catalog.pg_foreign_server) AS foreign_server_count,
       (SELECT count(*) FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql') AS nondefault_extension_count,
       (SELECT count(*) FROM pg_catalog.pg_event_trigger WHERE evtenabled <> 'D') AS enabled_event_trigger_count,
       (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')) AS user_security_definer_routine_count,
       (SELECT count(*) FROM pg_catalog.pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'D') AS enabled_user_trigger_count,
       current_setting('shared_preload_libraries') <> '' AS has_shared_preload_libraries,
       current_setting('session_preload_libraries') <> '' AS has_session_preload_libraries,
       current_setting('local_preload_libraries') <> '' AS has_local_preload_libraries;

-- Zero counts do not prove absence of a dynamically registered worker,
-- remote scheduler, privileged session in another database, untrusted
-- extension, external source, or a future change to the control plane.
ROLLBACK;
