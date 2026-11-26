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
SET LOCAL search_path = pg_catalog;

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
      WHERE has_table_privilege(current_user, relation.oid, 'SELECT WITH GRANT OPTION')
    )::integer AS relation_select_grant_option_count,
    COUNT(*) FILTER (
      WHERE has_any_column_privilege(current_user, relation.oid, 'SELECT WITH GRANT OPTION')
    )::integer AS column_select_grant_option_count,
    COUNT(*) FILTER (
      WHERE has_table_privilege(current_user, relation.oid, 'INSERT')
         OR has_table_privilege(current_user, relation.oid, 'UPDATE')
         OR has_table_privilege(current_user, relation.oid, 'DELETE')
         OR has_table_privilege(current_user, relation.oid, 'TRUNCATE')
         OR has_table_privilege(current_user, relation.oid, 'REFERENCES')
         OR has_table_privilege(current_user, relation.oid, 'TRIGGER')
    )::integer AS relation_write_privilege_count,
    COUNT(*) FILTER (
      WHERE has_any_column_privilege(current_user, relation.oid, 'INSERT')
         OR has_any_column_privilege(current_user, relation.oid, 'UPDATE')
         OR has_any_column_privilege(current_user, relation.oid, 'REFERENCES')
    )::integer AS relation_column_write_privilege_count,
    COUNT(*) FILTER (
      WHERE CASE
        WHEN current_setting('server_version_num')::integer >= 170000
          THEN has_table_privilege(current_user, relation.oid, 'MAINTAIN')
        ELSE false
      END
    )::integer AS relation_maintenance_privilege_count,
    COUNT(*) FILTER (WHERE relation.relrowsecurity)::integer AS row_security_relation_count,
    COUNT(*) FILTER (WHERE relation.relkind = 'f')::integer AS foreign_table_count
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS relation_namespace
    ON relation_namespace.oid = relation.relnamespace
  CROSS JOIN target_role
  WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND relation_namespace.nspname <> 'information_schema'
    AND relation_namespace.nspname !~ '^pg_'
), sequence_audit AS (
  SELECT
    COUNT(*) FILTER (
      WHERE NOT has_sequence_privilege(current_user, sequence_relation.oid, 'SELECT')
    )::integer AS unreadable_sequence_count,
    COUNT(*) FILTER (
      WHERE has_sequence_privilege(current_user, sequence_relation.oid, 'SELECT WITH GRANT OPTION')
    )::integer AS sequence_select_grant_option_count,
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
), large_object_audit AS (
  -- Decode the ACL directly so this audit also runs on PostgreSQL 16, where
  -- has_largeobject_privilege() is not available.
  SELECT
    COUNT(*) FILTER (
      WHERE large_object.lomowner <> target_role.oid
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.aclexplode(
            COALESCE(large_object.lomacl, pg_catalog.acldefault('L', large_object.lomowner))
          ) AS large_object_privilege
          WHERE (large_object_privilege.grantee = target_role.oid OR large_object_privilege.grantee = 0::oid)
            AND large_object_privilege.privilege_type = 'SELECT'
        )
    )::integer AS unreadable_large_object_count,
    COUNT(*) FILTER (
      WHERE large_object.lomowner = target_role.oid
        OR EXISTS (
          SELECT 1 FROM pg_catalog.aclexplode(
            COALESCE(large_object.lomacl, pg_catalog.acldefault('L', large_object.lomowner))
          ) AS large_object_privilege
          WHERE (large_object_privilege.grantee = target_role.oid OR large_object_privilege.grantee = 0::oid)
            AND large_object_privilege.privilege_type = 'UPDATE'
        )
    )::integer AS large_object_write_privilege_count,
    COUNT(*) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(
          COALESCE(large_object.lomacl, pg_catalog.acldefault('L', large_object.lomowner))
        ) AS large_object_privilege
        WHERE (large_object_privilege.grantee = target_role.oid OR large_object_privilege.grantee = 0::oid)
          AND large_object_privilege.privilege_type = 'SELECT'
          AND large_object_privilege.is_grantable
      )
    )::integer AS large_object_select_grant_option_count,
    COUNT(*) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(
          COALESCE(large_object.lomacl, pg_catalog.acldefault('L', large_object.lomowner))
        ) AS large_object_privilege
        WHERE large_object_privilege.grantee = 0::oid
          AND large_object_privilege.privilege_type = 'SELECT'
      )
    )::integer AS public_large_object_read_privilege_count,
    COUNT(*) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(
          COALESCE(large_object.lomacl, pg_catalog.acldefault('L', large_object.lomowner))
        ) AS large_object_privilege
        WHERE large_object_privilege.grantee = 0::oid
          AND large_object_privilege.privilege_type = 'UPDATE'
      )
    )::integer AS public_large_object_write_privilege_count
  FROM pg_catalog.pg_largeobject_metadata AS large_object
  CROSS JOIN target_role
), large_object_creation_function_audit AS (
  -- These server-side functions can create an LO owned by the caller. Since
  -- the owner can then write or unlink it, effective EXECUTE (including a
  -- grant to PUBLIC) is a database-write capability even with no table grants.
  SELECT COUNT(*) FILTER (
    WHERE has_function_privilege(current_user, creator.function_oid::oid, 'EXECUTE')
  )::integer AS executable_large_object_creation_function_count
  FROM (VALUES
    ('pg_catalog.lo_creat(integer)'::regprocedure),
    ('pg_catalog.lo_create(oid)'::regprocedure),
    ('pg_catalog.lo_from_bytea(oid,bytea)'::regprocedure)
  ) AS creator(function_oid)
), large_object_server_file_function_audit AS (
  -- Server-side LO import/export can read or write files using server OS
  -- privileges. PostgreSQL permits these routines to be granted to a
  -- non-superuser, so any effective EXECUTE must block this backup role.
  SELECT COUNT(*) FILTER (
    WHERE has_function_privilege(current_user, server_file.function_oid::oid, 'EXECUTE')
  )::integer AS executable_large_object_server_file_function_count
  FROM (VALUES
    ('pg_catalog.lo_import(text)'::regprocedure),
    ('pg_catalog.lo_import(text,oid)'::regprocedure),
    ('pg_catalog.lo_export(oid,text)'::regprocedure)
  ) AS server_file(function_oid)
), owned_user_routine_audit AS (
  -- Owning a user routine gives the backup role authority to alter or drop
  -- executable code after this audit. Reject that mutable audit surface.
  SELECT COUNT(*)::integer AS owned_user_routine_count
  FROM pg_catalog.pg_proc AS function_record
  JOIN pg_catalog.pg_namespace AS function_namespace
    ON function_namespace.oid = function_record.pronamespace
  CROSS JOIN target_role
  WHERE function_namespace.nspname <> 'information_schema'
    AND function_namespace.nspname !~ '^pg_'
    AND function_record.proowner = target_role.oid
), parameter_privilege_audit AS (
  -- SET on lo_compat_privileges disables large-object ACL checks. ALTER SYSTEM
  -- writes server configuration outside transaction rollback, so reject any
  -- effective grant to this role, including grants inherited through PUBLIC.
  SELECT
    COUNT(*) FILTER (
      WHERE parameter_record.parname = 'lo_compat_privileges'
        AND has_parameter_privilege(current_user, parameter_record.parname, 'SET')
    )::integer AS parameter_set_privilege_count,
    COUNT(*) FILTER (
      WHERE has_parameter_privilege(current_user, parameter_record.parname, 'ALTER SYSTEM')
    )::integer AS parameter_alter_system_privilege_count
  FROM pg_catalog.pg_parameter_acl AS parameter_record
), database_grant_option_audit AS (
  SELECT CASE WHEN has_database_privilege(current_user, current_database(), 'CONNECT WITH GRANT OPTION')
              THEN 1 ELSE 0 END::integer AS database_connect_grant_option_count
), routine_grant_option_audit AS (
  SELECT COUNT(*)::integer AS routine_execute_grant_option_count
  FROM pg_catalog.pg_proc AS function_record
  WHERE has_function_privilege(current_user, function_record.oid, 'EXECUTE WITH GRANT OPTION')
), security_definer_function_audit AS (
  SELECT COUNT(*)::integer AS executable_security_definer_function_count
  FROM pg_catalog.pg_proc AS function_record
  JOIN pg_catalog.pg_namespace AS function_namespace
    ON function_namespace.oid = function_record.pronamespace
  WHERE function_namespace.nspname <> 'information_schema'
    AND function_namespace.nspname !~ '^pg_'
    AND function_record.prosecdef
    AND has_function_privilege(current_user, function_record.oid, 'EXECUTE')
), untrusted_function_audit AS (
  -- Catalog metadata can flag callable C/untrusted-language routines, but
  -- cannot prove that arbitrary trusted-language function bodies are benign.
  SELECT COUNT(*)::integer AS executable_untrusted_function_count
  FROM pg_catalog.pg_proc AS function_record
  JOIN pg_catalog.pg_namespace AS function_namespace
    ON function_namespace.oid = function_record.pronamespace
  JOIN pg_catalog.pg_language AS function_language
    ON function_language.oid = function_record.prolang
  WHERE function_namespace.nspname <> 'information_schema'
    AND function_namespace.nspname !~ '^pg_'
    AND NOT function_language.lanpltrusted
    AND has_function_privilege(current_user, function_record.oid, 'EXECUTE')
), schema_audit AS (
  SELECT COUNT(*) FILTER (
    WHERE namespace_record.nspname <> 'information_schema'
      AND namespace_record.nspname !~ '^pg_'
      AND NOT has_schema_privilege(current_user, namespace_record.oid, 'USAGE')
  )::integer AS unusable_schema_count,
  COUNT(*) FILTER (
    WHERE has_schema_privilege(current_user, namespace_record.oid, 'CREATE')
  )::integer AS schema_create_privilege_count,
  COUNT(*) FILTER (
    WHERE has_schema_privilege(current_user, namespace_record.oid, 'USAGE WITH GRANT OPTION')
  )::integer AS schema_usage_grant_option_count
  FROM pg_catalog.pg_namespace AS namespace_record
), role_membership_audit AS (
  WITH RECURSIVE role_set_members(role_oid) AS (
    SELECT membership.member
    FROM pg_catalog.pg_auth_members AS membership
    CROSS JOIN target_role
    WHERE membership.roleid = target_role.oid
    UNION
    SELECT membership.member
    FROM pg_catalog.pg_auth_members AS membership
    JOIN role_set_members AS reachable ON membership.roleid = reachable.role_oid
  )
  SELECT target_role.oid AS target_role_oid,
         (SELECT COUNT(*)::integer FROM pg_catalog.pg_auth_members AS membership
          WHERE membership.member = target_role.oid) AS role_membership_count,
         (SELECT COUNT(*)::integer FROM pg_catalog.pg_auth_members AS membership
          WHERE membership.roleid = target_role.oid) AS role_member_count,
         (SELECT COUNT(*)::integer FROM role_set_members
          WHERE role_oid <> target_role.oid) AS role_set_member_count
  FROM target_role
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
    AND (SELECT role_membership_count = 0 AND role_member_count = 0 AND role_set_member_count = 0 FROM role_membership_audit)
    AS dedicated_non_admin_role_ok,
  COALESCE(has_database_privilege(current_user, current_database(), 'CONNECT'), false)
    AND NOT COALESCE(has_database_privilege(current_user, current_database(), 'CREATE'), true)
    AND NOT COALESCE(has_database_privilege(current_user, current_database(), 'TEMP'), true)
    AS database_privileges_ok,
  (SELECT role_membership_count FROM role_membership_audit) AS role_membership_count,
  (SELECT role_member_count FROM role_membership_audit) AS role_member_count,
  (SELECT role_set_member_count FROM role_membership_audit) AS role_set_member_count,
  (SELECT database_connect_grant_option_count FROM database_grant_option_audit) AS database_connect_grant_option_count,
  (SELECT schema_usage_grant_option_count FROM schema_audit) AS schema_usage_grant_option_count,
  (SELECT routine_execute_grant_option_count FROM routine_grant_option_audit) AS routine_execute_grant_option_count,
  (SELECT relation_select_grant_option_count FROM relation_audit) AS relation_select_grant_option_count,
  (SELECT column_select_grant_option_count FROM relation_audit) AS column_select_grant_option_count,
  (SELECT sequence_select_grant_option_count FROM sequence_audit) AS sequence_select_grant_option_count,
  (SELECT large_object_select_grant_option_count FROM large_object_audit) AS large_object_select_grant_option_count,
  (SELECT public_large_object_read_privilege_count FROM large_object_audit) AS public_large_object_read_privilege_count,
  (SELECT public_large_object_write_privilege_count FROM large_object_audit) AS public_large_object_write_privilege_count,
  (SELECT unreadable_relation_count FROM relation_audit) AS unreadable_relation_count,
  (SELECT unreadable_sequence_count FROM sequence_audit) AS unreadable_sequence_count,
  (SELECT unreadable_large_object_count FROM large_object_audit) AS unreadable_large_object_count,
  (SELECT relation_write_privilege_count FROM relation_audit) AS relation_write_privilege_count,
  (SELECT relation_column_write_privilege_count FROM relation_audit) AS relation_column_write_privilege_count,
  (SELECT relation_maintenance_privilege_count FROM relation_audit) AS relation_maintenance_privilege_count,
  (SELECT sequence_write_privilege_count FROM sequence_audit) AS sequence_write_privilege_count,
  (SELECT large_object_write_privilege_count FROM large_object_audit) AS large_object_write_privilege_count,
  (SELECT executable_large_object_creation_function_count FROM large_object_creation_function_audit)
    AS executable_large_object_creation_function_count,
  (SELECT executable_large_object_server_file_function_count FROM large_object_server_file_function_audit)
    AS executable_large_object_server_file_function_count,
  (SELECT owned_user_routine_count FROM owned_user_routine_audit)
    AS owned_user_routine_count,
  (SELECT parameter_set_privilege_count FROM parameter_privilege_audit)
    AS parameter_set_privilege_count,
  (SELECT parameter_alter_system_privilege_count FROM parameter_privilege_audit)
    AS parameter_alter_system_privilege_count,
  current_setting('lo_compat_privileges')::boolean AS lo_compat_privileges_enabled,
  (SELECT executable_security_definer_function_count FROM security_definer_function_audit)
    AS executable_security_definer_function_count,
  (SELECT executable_untrusted_function_count FROM untrusted_function_audit)
    AS executable_untrusted_function_count,
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
     AND (SELECT role_membership_count = 0 AND role_member_count = 0 AND role_set_member_count = 0 FROM role_membership_audit)
    AND COALESCE(has_database_privilege(current_user, current_database(), 'CONNECT'), false)
    AND NOT COALESCE(has_database_privilege(current_user, current_database(), 'CREATE'), true)
    AND NOT COALESCE(has_database_privilege(current_user, current_database(), 'TEMP'), true)
     AND (SELECT database_connect_grant_option_count = 0 FROM database_grant_option_audit)
     AND (SELECT schema_usage_grant_option_count = 0 FROM schema_audit)
     AND (SELECT routine_execute_grant_option_count = 0 FROM routine_grant_option_audit)
     AND (SELECT relation_select_grant_option_count = 0 FROM relation_audit)
     AND (SELECT column_select_grant_option_count = 0 FROM relation_audit)
     AND (SELECT sequence_select_grant_option_count = 0 FROM sequence_audit)
     AND (SELECT large_object_select_grant_option_count = 0 FROM large_object_audit)
     AND (SELECT public_large_object_read_privilege_count = 0 FROM large_object_audit)
     AND (SELECT public_large_object_write_privilege_count = 0 FROM large_object_audit)
    AND (SELECT unreadable_relation_count = 0 FROM relation_audit)
    AND (SELECT unreadable_sequence_count = 0 FROM sequence_audit)
    AND (SELECT unreadable_large_object_count = 0 FROM large_object_audit)
    AND (SELECT relation_write_privilege_count = 0 FROM relation_audit)
    AND (SELECT relation_column_write_privilege_count = 0 FROM relation_audit)
    AND (SELECT relation_maintenance_privilege_count = 0 FROM relation_audit)
    AND (SELECT sequence_write_privilege_count = 0 FROM sequence_audit)
    AND (SELECT large_object_write_privilege_count = 0 FROM large_object_audit)
    AND (SELECT executable_large_object_creation_function_count = 0 FROM large_object_creation_function_audit)
    AND (SELECT executable_large_object_server_file_function_count = 0 FROM large_object_server_file_function_audit)
    AND (SELECT owned_user_routine_count = 0 FROM owned_user_routine_audit)
    AND (SELECT parameter_set_privilege_count = 0 FROM parameter_privilege_audit)
    AND (SELECT parameter_alter_system_privilege_count = 0 FROM parameter_privilege_audit)
    AND NOT current_setting('lo_compat_privileges')::boolean
    AND (SELECT executable_security_definer_function_count = 0 FROM security_definer_function_audit)
    AND (SELECT executable_untrusted_function_count = 0 FROM untrusted_function_audit)
    AND (SELECT schema_create_privilege_count = 0 FROM schema_audit)
    AND (SELECT unusable_schema_count = 0 FROM schema_audit)
    AND (SELECT row_security_relation_count = 0 FROM relation_audit)
    AND (SELECT foreign_table_count = 0 FROM relation_audit)
  ) AS backup_role_ok
\gset
\echo Backup-role catalog counts: role_membership_count=:role_membership_count role_member_count=:role_member_count role_set_member_count=:role_set_member_count database_connect_grant_option_count=:database_connect_grant_option_count schema_usage_grant_option_count=:schema_usage_grant_option_count routine_execute_grant_option_count=:routine_execute_grant_option_count relation_select_grant_option_count=:relation_select_grant_option_count column_select_grant_option_count=:column_select_grant_option_count sequence_select_grant_option_count=:sequence_select_grant_option_count large_object_select_grant_option_count=:large_object_select_grant_option_count public_large_object_read_privilege_count=:public_large_object_read_privilege_count public_large_object_write_privilege_count=:public_large_object_write_privilege_count unreadable_relation_count=:unreadable_relation_count unreadable_sequence_count=:unreadable_sequence_count unreadable_large_object_count=:unreadable_large_object_count relation_write_privilege_count=:relation_write_privilege_count relation_column_write_privilege_count=:relation_column_write_privilege_count relation_maintenance_privilege_count=:relation_maintenance_privilege_count sequence_write_privilege_count=:sequence_write_privilege_count large_object_write_privilege_count=:large_object_write_privilege_count executable_large_object_creation_function_count=:executable_large_object_creation_function_count executable_large_object_server_file_function_count=:executable_large_object_server_file_function_count owned_user_routine_count=:owned_user_routine_count parameter_set_privilege_count=:parameter_set_privilege_count parameter_alter_system_privilege_count=:parameter_alter_system_privilege_count lo_compat_privileges_enabled=:lo_compat_privileges_enabled executable_security_definer_function_count=:executable_security_definer_function_count executable_untrusted_function_count=:executable_untrusted_function_count schema_create_privilege_count=:schema_create_privilege_count unusable_schema_count=:unusable_schema_count row_security_relation_count=:row_security_relation_count foreign_table_count=:foreign_table_count
\if :backup_role_ok
  \echo 'CATALOG_PRIVILEGE_CHECKS=PASS'
  \echo 'OVERALL_BACKUP_ROLE_NONWRITING=UNVERIFIED: arbitrary trusted function bodies may have side effects; review the exact routine inventory and provide a signed, current, independently pinned side-effect attestation.'
  WITH routine_inventory AS (
    SELECT
      namespace_record.nspname,
      function_record.proname,
      pg_catalog.pg_get_function_identity_arguments(function_record.oid) AS identity_arguments,
      pg_catalog.pg_get_userbyid(function_record.proowner) AS owner_name,
      language_record.lanname AS language_name,
      function_record.prokind,
      function_record.prosecdef,
      function_record.provolatile,
      function_record.proleakproof,
      function_record.proconfig,
      function_record.proacl::text AS routine_acl,
      encode(
        pg_catalog.sha256(
          convert_to(
            CASE
              WHEN function_record.prokind = 'a'
                THEN COALESCE(pg_catalog.to_jsonb(aggregate_record)::text, '') || E'\n' || COALESCE(function_record.prosrc, '')
              ELSE pg_catalog.pg_get_functiondef(function_record.oid)
            END,
            'UTF8'
          )
        ),
        'hex'
      ) AS definition_sha256
    FROM pg_catalog.pg_proc AS function_record
    JOIN pg_catalog.pg_namespace AS namespace_record
      ON namespace_record.oid = function_record.pronamespace
    JOIN pg_catalog.pg_language AS language_record
      ON language_record.oid = function_record.prolang
    LEFT JOIN pg_catalog.pg_aggregate AS aggregate_record
      ON aggregate_record.aggfnoid = function_record.oid
    WHERE namespace_record.nspname <> 'information_schema'
      AND namespace_record.nspname !~ '^pg_'
  )
  SELECT encode(
    pg_catalog.sha256(
      convert_to(
        COALESCE(
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_array(
              nspname, proname, identity_arguments, owner_name, language_name,
              prokind, prosecdef, provolatile, proleakproof, proconfig,
              routine_acl, definition_sha256
            )
            ORDER BY nspname, proname, identity_arguments, prokind
          )::text,
          '[]'
        ),
        'UTF8'
      )
    ),
    'hex'
  ) AS routine_inventory_sha256
  FROM routine_inventory
  \gset
  \echo BACKUP_ROLE_ROUTINE_INVENTORY_SHA256=:routine_inventory_sha256
  ROLLBACK;
\else
  \echo 'STOP: backup role, data-read coverage, target, or dump completeness prerequisites failed.'
  ROLLBACK;
  SELECT 'backup role audit failed'::integer;
\endif
