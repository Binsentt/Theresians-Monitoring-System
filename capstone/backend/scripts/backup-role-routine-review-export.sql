\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\pset pager off

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = pg_catalog;

SELECT CASE WHEN
  current_setting('transaction_read_only') = 'on'
  AND current_database() = :'expected_database'
  AND current_user = 'tq_prod_backup_reader'
  AND session_user = current_user
  AND host(inet_server_addr()) = :'expected_server_address'
  AND pg_catalog.inet_server_port() = :'expected_server_port'::integer
THEN 'true' ELSE 'false' END AS target_identity_ok
\gset

\if :target_identity_ok
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
    function_record.probin,
    function_record.prosrc,
    extension_record.extname AS extension_name,
    extension_record.extversion AS extension_version,
    extension_namespace.nspname AS extension_schema,
    pg_catalog.pg_get_userbyid(extension_record.extowner) AS extension_owner,
    CASE
      WHEN function_record.prokind = 'a'
        THEN COALESCE(pg_catalog.to_jsonb(aggregate_record)::text, '') || E'\n' || COALESCE(function_record.prosrc, '')
      ELSE pg_catalog.pg_get_functiondef(function_record.oid)
    END AS routine_definition,
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
    ) AS definition_sha256,
    pg_catalog.has_function_privilege('tq_prod_backup_reader'::name, function_record.oid, 'EXECUTE') AS executable_by_backup_role
  FROM pg_catalog.pg_proc AS function_record
  JOIN pg_catalog.pg_namespace AS namespace_record
    ON namespace_record.oid = function_record.pronamespace
  JOIN pg_catalog.pg_language AS language_record
    ON language_record.oid = function_record.prolang
  LEFT JOIN pg_catalog.pg_aggregate AS aggregate_record
    ON aggregate_record.aggfnoid = function_record.oid
  LEFT JOIN pg_catalog.pg_depend AS extension_dependency
    ON extension_dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
    AND extension_dependency.objid = function_record.oid
    AND extension_dependency.objsubid = 0
    AND extension_dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
    AND extension_dependency.deptype = 'e'
  LEFT JOIN pg_catalog.pg_extension AS extension_record
    ON extension_record.oid = extension_dependency.refobjid
  LEFT JOIN pg_catalog.pg_namespace AS extension_namespace
    ON extension_namespace.oid = extension_record.extnamespace
  WHERE namespace_record.nspname <> 'information_schema'
    AND namespace_record.nspname !~ '^pg_'
),
inventory_digest AS (
  SELECT encode(
    pg_catalog.sha256(
      convert_to(
        COALESCE(
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_array(
              nspname, proname, identity_arguments, owner_name, language_name,
              prokind, prosecdef, provolatile, proleakproof, proconfig,
              routine_acl, probin, prosrc, extension_name, extension_version,
              extension_schema, extension_owner, definition_sha256
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
)
SELECT pg_catalog.jsonb_build_object(
  'routine_inventory_sha256', inventory_digest.routine_inventory_sha256,
  'routines', COALESCE(
    (
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'schema', routine_inventory.nspname,
          'name', routine_inventory.proname,
          'identity_arguments', routine_inventory.identity_arguments,
          'owner', routine_inventory.owner_name,
          'language', routine_inventory.language_name,
          'kind', routine_inventory.prokind,
          'security_definer', routine_inventory.prosecdef,
          'volatility', routine_inventory.provolatile,
          'leakproof', routine_inventory.proleakproof,
          'configuration', routine_inventory.proconfig,
          'acl', routine_inventory.routine_acl,
          'probin', routine_inventory.probin,
          'prosrc', routine_inventory.prosrc,
          'extension_name', routine_inventory.extension_name,
          'extension_version', routine_inventory.extension_version,
          'extension_schema', routine_inventory.extension_schema,
          'extension_owner', routine_inventory.extension_owner,
          'definition_sha256', routine_inventory.definition_sha256,
          'executable_by_backup_role', routine_inventory.executable_by_backup_role,
          'definition', routine_inventory.routine_definition
        )
        ORDER BY routine_inventory.nspname, routine_inventory.proname,
          routine_inventory.identity_arguments, routine_inventory.prokind
      )
      FROM routine_inventory
    ),
    '[]'::jsonb
  )
)::text AS routine_review_export
FROM inventory_digest;
\else
  \echo 'STOP: routine review export target identity or read-only transaction did not match.'
  ROLLBACK;
  \quit 3
\endif

ROLLBACK;
