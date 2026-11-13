\set ON_ERROR_STOP on

-- This fixed audit reads PostgreSQL catalogs only. It deliberately excludes
-- schema_migrations from the application-relation SELECT check because that
-- is the sole application table the preflight role needs to read.
\if :{?expected_database}
\else
  \echo 'STOP: -v expected_database is required.'
  SELECT 'preflight role audit stopped: expected_database is required'::integer;
\endif
\if :{?expected_role}
\else
  \echo 'STOP: -v expected_role is required.'
  SELECT 'preflight role audit stopped: expected_role is required'::integer;
\endif
\if :{?expected_server_address}
\else
  \echo 'STOP: -v expected_server_address is required.'
  SELECT 'preflight role audit stopped: expected_server_address is required'::integer;
\endif
\if :{?expected_server_port}
\else
  \echo 'STOP: -v expected_server_port is required.'
  SELECT 'preflight role audit stopped: expected_server_port is required'::integer;
\endif

BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';

WITH target_role AS (
  SELECT oid, rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb,
         rolcreaterole, rolreplication, rolbypassrls
  FROM pg_catalog.pg_roles
  WHERE rolname = current_user
), relation_privileges AS (
  SELECT
    COUNT(DISTINCT relation.oid) FILTER (
      WHERE relation.oid IS DISTINCT FROM to_regclass('public.schema_migrations')
        AND (
          has_table_privilege(current_user, relation.oid, 'SELECT')
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_attribute AS readable_column
            WHERE readable_column.attrelid = relation.oid
              AND readable_column.attnum > 0
              AND NOT readable_column.attisdropped
              AND has_column_privilege(current_user, relation.oid, readable_column.attnum, 'SELECT')
          )
        )
    )::integer AS application_relation_select_count,
    COUNT(*) FILTER (
      WHERE has_table_privilege(current_user, relation.oid, 'INSERT')
         OR has_table_privilege(current_user, relation.oid, 'UPDATE')
         OR has_table_privilege(current_user, relation.oid, 'DELETE')
         OR has_table_privilege(current_user, relation.oid, 'TRUNCATE')
         OR has_table_privilege(current_user, relation.oid, 'REFERENCES')
         OR has_table_privilege(current_user, relation.oid, 'TRIGGER')
    )::integer AS table_write_privilege_count
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS relation_namespace
    ON relation_namespace.oid = relation.relnamespace
  WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND relation_namespace.nspname <> 'information_schema'
    AND relation_namespace.nspname !~ '^pg_'
), sequence_privileges AS (
  SELECT COUNT(*) FILTER (
    WHERE has_sequence_privilege(current_user, sequence_relation.oid, 'SELECT')
       OR has_sequence_privilege(current_user, sequence_relation.oid, 'USAGE')
       OR has_sequence_privilege(current_user, sequence_relation.oid, 'UPDATE')
  )::integer AS sequence_privilege_count
  FROM pg_catalog.pg_class AS sequence_relation
  JOIN pg_catalog.pg_namespace AS sequence_namespace
    ON sequence_namespace.oid = sequence_relation.relnamespace
  WHERE sequence_relation.relkind = 'S'
    AND sequence_namespace.nspname <> 'information_schema'
    AND sequence_namespace.nspname !~ '^pg_'
), schema_privileges AS (
  SELECT COUNT(*) FILTER (
    WHERE has_schema_privilege(current_user, namespace_record.oid, 'CREATE')
  )::integer AS schema_create_privilege_count
  FROM pg_catalog.pg_namespace AS namespace_record
  WHERE namespace_record.nspname <> 'information_schema'
    AND namespace_record.nspname !~ '^pg_'
), role_memberships AS (
  SELECT COUNT(*)::integer AS role_membership_count
  FROM pg_catalog.pg_auth_members AS membership
  JOIN target_role ON target_role.oid = membership.member
), extra_ledger_column_privileges AS (
  SELECT COUNT(*)::integer AS extra_ledger_column_select_count
  FROM pg_catalog.pg_class AS ledger_relation
  JOIN pg_catalog.pg_namespace AS ledger_namespace
    ON ledger_namespace.oid = ledger_relation.relnamespace
  JOIN pg_catalog.pg_attribute AS ledger_column
    ON ledger_column.attrelid = ledger_relation.oid
  WHERE ledger_namespace.nspname = 'public'
    AND ledger_relation.relname = 'schema_migrations'
    AND ledger_relation.relkind IN ('r', 'p')
    AND ledger_column.attnum > 0
    AND NOT ledger_column.attisdropped
    AND ledger_column.attname NOT IN ('version', 'filename', 'checksum')
    AND has_column_privilege(current_user, ledger_relation.oid, ledger_column.attnum, 'SELECT')
), security_definer_functions AS (
  SELECT COUNT(*)::integer AS executable_security_definer_function_count
  FROM pg_catalog.pg_proc AS function_record
  JOIN pg_catalog.pg_namespace AS function_namespace
    ON function_namespace.oid = function_record.pronamespace
  WHERE function_namespace.nspname <> 'information_schema'
    AND function_namespace.nspname !~ '^pg_'
    AND function_record.prosecdef
    AND has_function_privilege(current_user, function_record.oid, 'EXECUTE')
)
SELECT
  current_database() = :'expected_database'
    AND current_user = :'expected_role'
    AND current_user = 'tq_release_preflight_reader'
    AND session_user = current_user
    AND host(inet_server_addr()) = :'expected_server_address'
    AND inet_server_port() = :'expected_server_port'::integer
    AS target_identity_ok,
  current_setting('transaction_read_only') = 'on'
    AND current_setting('statement_timeout')::interval = interval '10 seconds'
    AND current_setting('lock_timeout')::interval = interval '2 seconds'
    AS read_only_limits_ok,
  COALESCE((SELECT rolcanlogin AND NOT rolinherit AND NOT rolsuper
                   AND NOT rolcreatedb AND NOT rolcreaterole
                   AND NOT rolreplication AND NOT rolbypassrls
            FROM target_role), false)
    AND (SELECT role_membership_count = 0 FROM role_memberships)
    AS dedicated_non_admin_role_ok,
  COALESCE(has_database_privilege(current_user, current_database(), 'CONNECT'), false)
    AND NOT COALESCE(has_database_privilege(current_user, current_database(), 'CREATE'), true)
    AND NOT COALESCE(has_database_privilege(current_user, current_database(), 'TEMP'), true)
    AND COALESCE(has_schema_privilege(current_user, 'public', 'USAGE'), false)
    AND COALESCE(has_column_privilege(current_user, to_regclass('public.schema_migrations'), 'version', 'SELECT'), false)
    AND COALESCE(has_column_privilege(current_user, to_regclass('public.schema_migrations'), 'filename', 'SELECT'), false)
    AND COALESCE(has_column_privilege(current_user, to_regclass('public.schema_migrations'), 'checksum', 'SELECT'), false)
    AS required_access_ok,
  (SELECT application_relation_select_count FROM relation_privileges)
    AS application_relation_select_count,
  (SELECT table_write_privilege_count FROM relation_privileges)
    AS table_write_privilege_count,
  (SELECT sequence_privilege_count FROM sequence_privileges)
    AS sequence_privilege_count,
  (SELECT schema_create_privilege_count FROM schema_privileges)
    AS schema_create_privilege_count,
  (SELECT role_membership_count FROM role_memberships)
    AS role_membership_count,
  (SELECT extra_ledger_column_select_count FROM extra_ledger_column_privileges)
    AS extra_ledger_column_select_count,
  (SELECT executable_security_definer_function_count FROM security_definer_functions)
    AS executable_security_definer_function_count,
  ((SELECT application_relation_select_count = 0 FROM relation_privileges)
    AND (SELECT table_write_privilege_count = 0 FROM relation_privileges)
    AND (SELECT sequence_privilege_count = 0 FROM sequence_privileges)
    AND (SELECT schema_create_privilege_count = 0 FROM schema_privileges)
    AND (SELECT extra_ledger_column_select_count = 0 FROM extra_ledger_column_privileges)
    AND (SELECT executable_security_definer_function_count = 0 FROM security_definer_functions))
    AS no_application_data_or_write_privileges,
  (
    current_database() = :'expected_database'
    AND current_user = :'expected_role'
    AND current_user = 'tq_release_preflight_reader'
    AND session_user = current_user
    AND host(inet_server_addr()) = :'expected_server_address'
    AND inet_server_port() = :'expected_server_port'::integer
    AND current_setting('transaction_read_only') = 'on'
    AND current_setting('statement_timeout')::interval = interval '10 seconds'
    AND current_setting('lock_timeout')::interval = interval '2 seconds'
    AND COALESCE((SELECT rolcanlogin AND NOT rolinherit AND NOT rolsuper
                         AND NOT rolcreatedb AND NOT rolcreaterole
                         AND NOT rolreplication AND NOT rolbypassrls
                  FROM target_role), false)
    AND (SELECT role_membership_count = 0 FROM role_memberships)
    AND COALESCE(has_database_privilege(current_user, current_database(), 'CONNECT'), false)
    AND NOT COALESCE(has_database_privilege(current_user, current_database(), 'CREATE'), true)
    AND NOT COALESCE(has_database_privilege(current_user, current_database(), 'TEMP'), true)
    AND COALESCE(has_schema_privilege(current_user, 'public', 'USAGE'), false)
    AND COALESCE(has_column_privilege(current_user, to_regclass('public.schema_migrations'), 'version', 'SELECT'), false)
    AND COALESCE(has_column_privilege(current_user, to_regclass('public.schema_migrations'), 'filename', 'SELECT'), false)
    AND COALESCE(has_column_privilege(current_user, to_regclass('public.schema_migrations'), 'checksum', 'SELECT'), false)
    AND (SELECT application_relation_select_count = 0 FROM relation_privileges)
    AND (SELECT table_write_privilege_count = 0 FROM relation_privileges)
    AND (SELECT sequence_privilege_count = 0 FROM sequence_privileges)
    AND (SELECT schema_create_privilege_count = 0 FROM schema_privileges)
    AND (SELECT extra_ledger_column_select_count = 0 FROM extra_ledger_column_privileges)
    AND (SELECT executable_security_definer_function_count = 0 FROM security_definer_functions)
  ) AS role_audit_ok
\gset

\echo Preflight role audit counts: application_relation_select_count=:application_relation_select_count extra_ledger_column_select_count=:extra_ledger_column_select_count executable_security_definer_function_count=:executable_security_definer_function_count table_write_privilege_count=:table_write_privilege_count sequence_privilege_count=:sequence_privilege_count schema_create_privilege_count=:schema_create_privilege_count role_membership_count=:role_membership_count
\if :role_audit_ok
  \echo 'PASS: target identity, read-only limits, and preflight-only privileges verified.'
  ROLLBACK;
\else
  \echo 'STOP: preflight role identity or least-privilege requirements failed.'
  ROLLBACK;
  SELECT 'preflight role audit failed'::integer;
\endif
