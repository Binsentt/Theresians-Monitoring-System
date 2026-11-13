\set ON_ERROR_STOP on

-- Catalog-only preflight for a separately approved full logical backup. This
-- role can read application data, so do not reuse it for ordinary preflight.
\if :{?expected_database}
\else
  \echo 'STOP: -v expected_database is required.'
  SELECT 'backup role audit stopped: expected_database is required'::integer;
\endif
\if :{?expected_role}
\else
  \echo 'STOP: -v expected_role is required.'
  SELECT 'backup role audit stopped: expected_role is required'::integer;
\endif
\if :{?expected_server_address}
\else
  \echo 'STOP: -v expected_server_address is required.'
  SELECT 'backup role audit stopped: expected_server_address is required'::integer;
\endif
\if :{?expected_server_port}
\else
  \echo 'STOP: -v expected_server_port is required.'
  SELECT 'backup role audit stopped: expected_server_port is required'::integer;
\endif

BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';

WITH target_role AS (
  SELECT oid, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
         rolreplication, rolbypassrls
  FROM pg_catalog.pg_roles
  WHERE rolname = current_user
), relation_audit AS (
  SELECT
    COUNT(*) FILTER (
      WHERE NOT has_table_privilege(current_user, relation.oid, 'SELECT')
    )::integer AS unreadable_relation_count,
    COUNT(*) FILTER (
      WHERE has_table_privilege(current_user, relation.oid, 'INSERT')
         OR has_table_privilege(current_user, relation.oid, 'UPDATE')
         OR has_table_privilege(current_user, relation.oid, 'DELETE')
         OR has_table_privilege(current_user, relation.oid, 'TRUNCATE')
         OR has_table_privilege(current_user, relation.oid, 'REFERENCES')
         OR has_table_privilege(current_user, relation.oid, 'TRIGGER')
    )::integer AS relation_write_privilege_count,
    COUNT(*) FILTER (WHERE relation.relrowsecurity)::integer AS row_security_relation_count,
    COUNT(*) FILTER (WHERE relation.relkind = 'f')::integer AS foreign_table_count
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS relation_namespace
    ON relation_namespace.oid = relation.relnamespace
  WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND relation_namespace.nspname <> 'information_schema'
    AND relation_namespace.nspname !~ '^pg_'
), sequence_audit AS (
  SELECT
    COUNT(*) FILTER (
      WHERE NOT has_sequence_privilege(current_user, sequence_relation.oid, 'SELECT')
    )::integer AS unreadable_sequence_count,
    COUNT(*) FILTER (
      WHERE has_sequence_privilege(current_user, sequence_relation.oid, 'USAGE')
         OR has_sequence_privilege(current_user, sequence_relation.oid, 'UPDATE')
    )::integer AS sequence_write_privilege_count
  FROM pg_catalog.pg_class AS sequence_relation
  JOIN pg_catalog.pg_namespace AS sequence_namespace
    ON sequence_namespace.oid = sequence_relation.relnamespace
  WHERE sequence_relation.relkind = 'S'
    AND sequence_namespace.nspname <> 'information_schema'
    AND sequence_namespace.nspname !~ '^pg_'
), schema_audit AS (
  SELECT COUNT(*) FILTER (
    WHERE NOT has_schema_privilege(current_user, namespace_record.oid, 'USAGE')
  )::integer AS unusable_schema_count,
  COUNT(*) FILTER (
    WHERE has_schema_privilege(current_user, namespace_record.oid, 'CREATE')
  )::integer AS schema_create_privilege_count
  FROM pg_catalog.pg_namespace AS namespace_record
  WHERE namespace_record.nspname <> 'information_schema'
    AND namespace_record.nspname !~ '^pg_'
), role_membership_audit AS (
  SELECT COUNT(*)::integer AS role_membership_count
  FROM pg_catalog.pg_auth_members AS membership
  JOIN target_role ON target_role.oid = membership.member
)
SELECT
  current_database() = :'expected_database'
    AND current_user = :'expected_role'
    AND current_user = 'tq_prod_backup_reader'
    AND session_user = current_user
    AND host(inet_server_addr()) = :'expected_server_address'
    AND inet_server_port() = :'expected_server_port'::integer
    AS target_identity_ok,
  COALESCE((SELECT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
                   AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
            FROM target_role), false)
    AND (SELECT role_membership_count = 0 FROM role_membership_audit)
    AS dedicated_non_admin_role_ok,
  COALESCE(has_database_privilege(current_user, current_database(), 'CONNECT'), false)
    AND NOT COALESCE(has_database_privilege(current_user, current_database(), 'CREATE'), true)
    AND NOT COALESCE(has_database_privilege(current_user, current_database(), 'TEMP'), true)
    AS database_privileges_ok,
  (SELECT unreadable_relation_count FROM relation_audit) AS unreadable_relation_count,
  (SELECT unreadable_sequence_count FROM sequence_audit) AS unreadable_sequence_count,
  (SELECT relation_write_privilege_count FROM relation_audit) AS relation_write_privilege_count,
  (SELECT sequence_write_privilege_count FROM sequence_audit) AS sequence_write_privilege_count,
  (SELECT schema_create_privilege_count FROM schema_audit) AS schema_create_privilege_count,
  (SELECT unusable_schema_count FROM schema_audit) AS unusable_schema_count,
  (SELECT row_security_relation_count FROM relation_audit) AS row_security_relation_count,
  (SELECT foreign_table_count FROM relation_audit) AS foreign_table_count,
  (
    current_database() = :'expected_database'
    AND current_user = :'expected_role'
    AND current_user = 'tq_prod_backup_reader'
    AND session_user = current_user
    AND host(inet_server_addr()) = :'expected_server_address'
    AND inet_server_port() = :'expected_server_port'::integer
    AND COALESCE((SELECT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
                         AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
                  FROM target_role), false)
    AND (SELECT role_membership_count = 0 FROM role_membership_audit)
    AND COALESCE(has_database_privilege(current_user, current_database(), 'CONNECT'), false)
    AND NOT COALESCE(has_database_privilege(current_user, current_database(), 'CREATE'), true)
    AND NOT COALESCE(has_database_privilege(current_user, current_database(), 'TEMP'), true)
    AND (SELECT unreadable_relation_count = 0 FROM relation_audit)
    AND (SELECT unreadable_sequence_count = 0 FROM sequence_audit)
    AND (SELECT relation_write_privilege_count = 0 FROM relation_audit)
    AND (SELECT sequence_write_privilege_count = 0 FROM sequence_audit)
    AND (SELECT schema_create_privilege_count = 0 FROM schema_audit)
    AND (SELECT unusable_schema_count = 0 FROM schema_audit)
    AND (SELECT row_security_relation_count = 0 FROM relation_audit)
    AND (SELECT foreign_table_count = 0 FROM relation_audit)
  ) AS backup_role_ok
\gset

\echo Backup-role catalog counts: unreadable_relation_count=:unreadable_relation_count unreadable_sequence_count=:unreadable_sequence_count relation_write_privilege_count=:relation_write_privilege_count sequence_write_privilege_count=:sequence_write_privilege_count schema_create_privilege_count=:schema_create_privilege_count unusable_schema_count=:unusable_schema_count row_security_relation_count=:row_security_relation_count foreign_table_count=:foreign_table_count
\if :backup_role_ok
  \echo 'PASS: approved full-backup role and catalog scope verified.'
  ROLLBACK;
\else
  \echo 'STOP: backup role, data-read coverage, target, or dump completeness prerequisites failed.'
  ROLLBACK;
  SELECT 'backup role audit failed'::integer;
\endif
