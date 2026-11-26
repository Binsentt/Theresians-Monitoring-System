\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
\if :{?snapshot_id}
SET TRANSACTION SNAPSHOT :'snapshot_id';
\endif
SET LOCAL statement_timeout = '30min';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = pg_catalog;
SET LOCAL DateStyle = 'ISO, YMD';
SET LOCAL TimeZone = 'UTC';
SET LOCAL IntervalStyle = 'postgres_verbose';
SET LOCAL bytea_output = 'hex';
SET LOCAL work_mem = '64MB';
-- temp_file_limit is superuser-only; this restricted reader uses the transaction timeout and work_mem controls above.

SELECT current_database() = :'expected_database'
   AND current_user = :'expected_role'
   AND session_user = :'expected_role'
   AND COALESCE(host(inet_server_addr()), '') = :'expected_server_address'
   AND inet_server_port() = :'expected_server_port'::integer
   AND current_setting('server_version_num')::integer BETWEEN 180000 AND 189999
   AND to_regprocedure('pg_catalog.sha256(bytea)') IS NOT NULL AS backup_target_ok
\gset
\if :backup_target_ok
  \echo BACKUP_TARGET_IDENTITY=PASS
\else
  \echo BACKUP_TARGET_IDENTITY=FAIL
  \quit 3
\endif

WITH RECURSIVE schema_entities AS (
  SELECT jsonb_build_object(
    'kind', 'schema', 'name', namespace.nspname
  ) AS item
  FROM pg_catalog.pg_namespace AS namespace
  WHERE namespace.nspname <> 'information_schema'
    AND namespace.nspname !~ '^pg_'

  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'relation', 'schema', namespace.nspname, 'name', relation.relname,
    'relationKind', relation.relkind::text, 'persistence', relation.relpersistence::text,
    'partition', relation.relispartition,
    'partitionKey', CASE WHEN relation.relkind = 'p' THEN pg_catalog.pg_get_partkeydef(relation.oid) END,
    'partitionBound', CASE WHEN relation.relispartition THEN pg_catalog.pg_get_expr(relation.relpartbound, relation.oid) END,
    'options', relation.reloptions,
    'rowSecurity', relation.relrowsecurity, 'forceRowSecurity', relation.relforcerowsecurity,
    'replicaIdentity', relation.relreplident::text,
    'definition', CASE WHEN relation.relkind IN ('v', 'm') THEN pg_catalog.pg_get_viewdef(relation.oid, true) END
  )
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname <> 'information_schema'
    AND namespace.nspname !~ '^pg_'
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')

  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'column', 'schema', namespace.nspname, 'relation', relation.relname,
    'name', attribute.attname,
    'type', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
    'notNull', attribute.attnotnull, 'identity', attribute.attidentity::text,
    'generated', attribute.attgenerated::text,
    'default', pg_catalog.pg_get_expr(default_record.adbin, default_record.adrelid),
    'collationSchema', collation_namespace.nspname, 'collation', collation_entry.collname
  )
  FROM pg_catalog.pg_attribute AS attribute
  JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  LEFT JOIN pg_catalog.pg_attrdef AS default_record
    ON default_record.adrelid = attribute.attrelid AND default_record.adnum = attribute.attnum
  LEFT JOIN pg_catalog.pg_collation AS collation_entry ON collation_entry.oid = attribute.attcollation
  LEFT JOIN pg_catalog.pg_namespace AS collation_namespace ON collation_namespace.oid = collation_entry.collnamespace
  WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
    AND namespace.nspname <> 'information_schema' AND namespace.nspname !~ '^pg_'

  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'constraint', 'schema', namespace.nspname, 'relation', relation.relname,
    'name', constraint_record.conname, 'type', constraint_record.contype::text,
    'definition', pg_catalog.pg_get_constraintdef(constraint_record.oid, true),
    'validated', constraint_record.convalidated, 'deferrable', constraint_record.condeferrable,
    'deferred', constraint_record.condeferred, 'noInherit', constraint_record.connoinherit
  )
  FROM pg_catalog.pg_constraint AS constraint_record
  LEFT JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_record.conrelid
  LEFT JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  LEFT JOIN pg_catalog.pg_type AS constrained_type ON constrained_type.oid = constraint_record.contypid
  LEFT JOIN pg_catalog.pg_namespace AS type_namespace ON type_namespace.oid = constrained_type.typnamespace
  WHERE COALESCE(namespace.nspname, type_namespace.nspname) <> 'information_schema'
    AND COALESCE(namespace.nspname, type_namespace.nspname) !~ '^pg_'

  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'index', 'schema', namespace.nspname, 'relation', relation.relname,
    'name', index_relation.relname, 'definition', pg_catalog.pg_get_indexdef(index_record.indexrelid),
    'valid', index_record.indisvalid, 'ready', index_record.indisready,
    'live', index_record.indislive, 'primary', index_record.indisprimary,
    'unique', index_record.indisunique, 'immediate', index_record.indimmediate
  )
  FROM pg_catalog.pg_index AS index_record
  JOIN pg_catalog.pg_class AS relation ON relation.oid = index_record.indrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_record.indexrelid
  WHERE namespace.nspname <> 'information_schema' AND namespace.nspname !~ '^pg_'

  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'trigger', 'schema', namespace.nspname, 'relation', relation.relname,
    'name', trigger_record.tgname, 'definition', pg_catalog.pg_get_triggerdef(trigger_record.oid, true),
    'enabled', trigger_record.tgenabled::text, 'internal', trigger_record.tgisinternal
  )
  FROM pg_catalog.pg_trigger AS trigger_record
  JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_record.tgrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname <> 'information_schema' AND namespace.nspname !~ '^pg_'

  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'routine', 'schema', namespace.nspname, 'name', function_record.proname,
    'identityArguments', pg_catalog.pg_get_function_identity_arguments(function_record.oid),
    'definition', pg_catalog.pg_get_functiondef(function_record.oid),
    'kindCode', function_record.prokind::text, 'securityDefiner', function_record.prosecdef,
    'volatility', function_record.provolatile::text, 'configuration', function_record.proconfig
  )
  FROM pg_catalog.pg_proc AS function_record
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = function_record.pronamespace
  WHERE namespace.nspname <> 'information_schema' AND namespace.nspname !~ '^pg_'
    AND function_record.prokind IN ('f', 'p', 'w')

  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'type', 'schema', namespace.nspname, 'name', type_record.typname,
    'typeKind', type_record.typtype::text,
    'definition', pg_catalog.format_type(type_record.oid, NULL),
    'notNull', type_record.typnotnull, 'default', type_record.typdefault,
    'category', type_record.typcategory::text
  )
  FROM pg_catalog.pg_type AS type_record
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_record.typnamespace
  WHERE namespace.nspname <> 'information_schema' AND namespace.nspname !~ '^pg_'

  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'enum-label', 'schema', namespace.nspname, 'type', type_record.typname,
    'label', enum_record.enumlabel, 'sortOrder', enum_record.enumsortorder
  )
  FROM pg_catalog.pg_enum AS enum_record
  JOIN pg_catalog.pg_type AS type_record ON type_record.oid = enum_record.enumtypid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_record.typnamespace
  WHERE namespace.nspname <> 'information_schema' AND namespace.nspname !~ '^pg_'

  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'sequence-definition', 'schema', namespace.nspname, 'name', relation.relname,
    'type', pg_catalog.format_type(sequence.seqtypid, NULL), 'start', sequence.seqstart,
    'increment', sequence.seqincrement, 'minimum', sequence.seqmin, 'maximum', sequence.seqmax,
    'cache', sequence.seqcache, 'cycle', sequence.seqcycle
  )
  FROM pg_catalog.pg_sequence AS sequence
  JOIN pg_catalog.pg_class AS relation ON relation.oid = sequence.seqrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname <> 'information_schema' AND namespace.nspname !~ '^pg_'

  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'extension', 'name', extension.extname, 'version', extension.extversion,
    'schema', namespace.nspname
  )
  FROM pg_catalog.pg_extension AS extension
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
  WHERE extension.extname <> 'plpgsql'

  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'database', 'name', database_record.datname,
    'encoding', pg_catalog.pg_encoding_to_char(database_record.encoding),
    'collation', database_record.datcollate, 'characterType', database_record.datctype,
    'localeProvider', database_record.datlocprovider::text,
    'collationVersion', database_record.datcollversion
  )
  FROM pg_catalog.pg_database AS database_record
  WHERE database_record.datname = current_database()

  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'rule', 'schema', namespace.nspname, 'relation', relation.relname,
    'name', rule_record.rulename, 'definition', pg_catalog.pg_get_ruledef(rule_record.oid, true)
  )
  FROM pg_catalog.pg_rewrite AS rule_record
  JOIN pg_catalog.pg_class AS relation ON relation.oid = rule_record.ev_class
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname <> 'information_schema' AND namespace.nspname !~ '^pg_'

  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'row-security-policy', 'schema', namespace.nspname, 'relation', relation.relname,
    'name', policy.polname, 'command', policy.polcmd::text, 'permissive', policy.polpermissive,
    'roles', ARRAY(
      SELECT CASE WHEN policy_role.role_oid = 0::oid THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(policy_role.role_oid) END
      FROM unnest(policy.polroles) AS policy_role(role_oid)
      ORDER BY 1
    ),
    'using', pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
    'withCheck', pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid)
  )
  FROM pg_catalog.pg_policy AS policy
  JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname <> 'information_schema' AND namespace.nspname !~ '^pg_'

  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'sequence-ownership', 'sequenceSchema', sequence_namespace.nspname,
    'sequence', sequence_relation.relname, 'tableSchema', table_namespace.nspname,
    'table', table_relation.relname, 'column', table_attribute.attname,
    'dependencyType', dependency.deptype::text
  )
  FROM pg_catalog.pg_depend AS dependency
  JOIN pg_catalog.pg_class AS sequence_relation ON sequence_relation.oid = dependency.objid
  JOIN pg_catalog.pg_namespace AS sequence_namespace ON sequence_namespace.oid = sequence_relation.relnamespace
  JOIN pg_catalog.pg_class AS table_relation ON table_relation.oid = dependency.refobjid
  JOIN pg_catalog.pg_namespace AS table_namespace ON table_namespace.oid = table_relation.relnamespace
  JOIN pg_catalog.pg_attribute AS table_attribute
    ON table_attribute.attrelid = dependency.refobjid AND table_attribute.attnum = dependency.refobjsubid
  WHERE dependency.classid = 'pg_catalog.pg_class'::regclass
    AND dependency.refclassid = 'pg_catalog.pg_class'::regclass
    AND dependency.deptype IN ('a', 'i')
    AND sequence_relation.relkind = 'S'
    AND sequence_namespace.nspname <> 'information_schema' AND sequence_namespace.nspname !~ '^pg_'
    AND table_namespace.nspname <> 'information_schema' AND table_namespace.nspname !~ '^pg_'

  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'aggregate', 'schema', namespace.nspname, 'name', procedure.proname,
    'identityArguments', pg_catalog.pg_get_function_identity_arguments(procedure.oid),
    'aggregateKind', aggregate.aggkind::text, 'directArguments', aggregate.aggnumdirectargs,
    'transitionFunction', aggregate.aggtransfn::regprocedure::text,
    'finalFunction', aggregate.aggfinalfn::regprocedure::text,
    'combineFunction', aggregate.aggcombinefn::regprocedure::text,
    'serializeFunction', aggregate.aggserialfn::regprocedure::text,
    'deserializeFunction', aggregate.aggdeserialfn::regprocedure::text,
    'movingTransitionFunction', aggregate.aggmtransfn::regprocedure::text,
    'movingInverseFunction', aggregate.aggminvtransfn::regprocedure::text,
    'movingFinalFunction', aggregate.aggmfinalfn::regprocedure::text,
    'transitionType', pg_catalog.format_type(aggregate.aggtranstype, NULL),
    'movingTransitionType', pg_catalog.format_type(aggregate.aggmtranstype, NULL),
    'transitionSpace', aggregate.aggtransspace, 'movingTransitionSpace', aggregate.aggmtransspace,
    'sortOperator', aggregate.aggsortop::regoperator::text,
    'initialValue', aggregate.agginitval, 'movingInitialValue', aggregate.aggminitval,
    'finalModify', aggregate.aggfinalmodify::text, 'movingFinalModify', aggregate.aggmfinalmodify::text,
    'finalExtra', aggregate.aggfinalextra, 'movingFinalExtra', aggregate.aggmfinalextra
  )
  FROM pg_catalog.pg_aggregate AS aggregate
  JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = aggregate.aggfnoid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname <> 'information_schema' AND namespace.nspname !~ '^pg_'

  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'range-type', 'schema', range_namespace.nspname, 'name', range_type.typname,
    'subtype', pg_catalog.format_type(range.rngsubtype, NULL),
    'multirange', pg_catalog.format_type(range.rngmultitypid, NULL),
    'collation', range.rngcollation::regcollation::text,
    'subtypeOperatorClass', range.rngsubopc::regclass::text,
    'canonicalFunction', range.rngcanonical::regprocedure::text,
    'subdiffFunction', range.rngsubdiff::regprocedure::text
  )
  FROM pg_catalog.pg_range AS range
  JOIN pg_catalog.pg_type AS range_type ON range_type.oid = range.rngtypid
  JOIN pg_catalog.pg_namespace AS range_namespace ON range_namespace.oid = range_type.typnamespace
  WHERE range_namespace.nspname <> 'information_schema' AND range_namespace.nspname !~ '^pg_'
), schema_manifest AS (
  SELECT encode(pg_catalog.sha256(convert_to(
    COALESCE(jsonb_agg(item ORDER BY item::text COLLATE "C")::text, '[]'), 'UTF8'
  )), 'hex') AS schema_sha256
  FROM schema_entities
), table_relations AS (
  SELECT namespace.nspname AS schema_name, relation.relname AS relation_name
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname <> 'information_schema' AND namespace.nspname !~ '^pg_'
    AND relation.relkind IN ('r', 'p', 'm') AND NOT relation.relispartition
), table_metrics AS (
  SELECT table_relation.schema_name, table_relation.relation_name,
         pg_catalog.query_to_xml(pg_catalog.format($table_query$
           WITH row_hashes AS (
             SELECT encode(pg_catalog.sha256(convert_to(to_jsonb(row_data)::text, 'UTF8')), 'hex') AS row_sha256
             FROM %I.%I AS row_data
           ), numbered AS (
             SELECT row_sha256, row_number() OVER (ORDER BY row_sha256 COLLATE "C") AS row_number
             FROM row_hashes
           ), chunks AS (
             SELECT ((row_number - 1) / 8192)::bigint AS chunk_number,
                    COUNT(*)::bigint AS chunk_rows,
                    encode(pg_catalog.sha256(convert_to(
                      string_agg(row_sha256, '' ORDER BY row_sha256 COLLATE "C"), 'UTF8'
                    )), 'hex') AS chunk_sha256
             FROM numbered
             GROUP BY ((row_number - 1) / 8192)::bigint
           )
           SELECT COALESCE(SUM(chunk_rows), 0)::bigint AS row_count,
                  encode(pg_catalog.sha256(convert_to(
                    COALESCE(string_agg(chunk_number::text || ':' || chunk_rows::text || ':' || chunk_sha256,
                                       E'\n' ORDER BY chunk_number), ''), 'UTF8'
                  )), 'hex') AS content_sha256
           FROM chunks
         $table_query$, table_relation.schema_name, table_relation.relation_name), true, false, '') AS metrics
  FROM table_relations AS table_relation
), table_rows AS (
  SELECT schema_name, relation_name,
         COALESCE((xpath('/table/row/row_count/text()', metrics))[1]::text, '0')::bigint AS row_count,
         COALESCE((xpath('/table/row/content_sha256/text()', metrics))[1]::text, '') AS content_sha256
  FROM table_metrics
), table_manifest AS (
  SELECT COUNT(*)::bigint AS table_count,
         COALESCE(SUM(row_count), 0)::bigint AS row_count,
         encode(pg_catalog.sha256(convert_to(
           COALESCE(jsonb_agg(jsonb_build_object(
             'schema', schema_name, 'relation', relation_name,
             'rowCount', row_count, 'sha256', content_sha256
           ) ORDER BY schema_name COLLATE "C", relation_name COLLATE "C")::text, '[]'), 'UTF8'
         )), 'hex') AS table_sha256
  FROM table_rows
), sequence_sources AS (
  SELECT namespace.nspname AS schema_name, relation.relname AS sequence_name,
         pg_catalog.query_to_xml(pg_catalog.format(
           'SELECT last_value::text AS last_value, is_called::text AS is_called FROM %I.%I',
           namespace.nspname, relation.relname
         ), true, false, '') AS sequence_xml
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE relation.relkind = 'S' AND namespace.nspname <> 'information_schema'
    AND namespace.nspname !~ '^pg_'
), sequence_rows AS (
  SELECT schema_name, sequence_name,
         COALESCE((xpath('/table/row/last_value/text()', sequence_xml))[1]::text, '') AS last_value,
         COALESCE((xpath('/table/row/is_called/text()', sequence_xml))[1]::text, '') AS is_called
  FROM sequence_sources
), sequence_manifest AS (
  SELECT COUNT(*)::bigint AS sequence_count,
         encode(pg_catalog.sha256(convert_to(
           COALESCE(jsonb_agg(jsonb_build_object(
             'schema', schema_name, 'sequence', sequence_name,
             'lastValue', last_value, 'isCalled', is_called
           ) ORDER BY schema_name COLLATE "C", sequence_name COLLATE "C")::text, '[]'), 'UTF8'
         )), 'hex') AS sequence_sha256
  FROM sequence_rows
), lo_chunks(loid, chunk_number, chunk_length, chunk_sha256) AS (
  SELECT large_object.oid, 0::bigint, octet_length(chunk.data)::bigint,
         encode(pg_catalog.sha256(chunk.data), 'hex')
  FROM pg_catalog.pg_largeobject_metadata AS large_object
  CROSS JOIN LATERAL (
    SELECT pg_catalog.lo_get(large_object.oid, 0, 1048576) AS data
  ) AS chunk
  UNION ALL
  SELECT previous.loid, previous.chunk_number + 1,
         octet_length(chunk.data)::bigint, encode(pg_catalog.sha256(chunk.data), 'hex')
  FROM lo_chunks AS previous
  CROSS JOIN LATERAL (
    SELECT pg_catalog.lo_get(previous.loid, (previous.chunk_number + 1) * 1048576,
      1048576) AS data
  ) AS chunk
  WHERE previous.chunk_length = 1048576 AND previous.chunk_number < 1024
), lo_objects AS (
  SELECT lo_chunks.loid,
         SUM(lo_chunks.chunk_length)::bigint AS byte_length,
         BOOL_OR(lo_chunks.chunk_number = 1024 AND lo_chunks.chunk_length > 0) AS exceeds_integrity_limit,
         encode(pg_catalog.sha256(convert_to(
           COALESCE(string_agg(lo_chunks.chunk_number::text || ':' || lo_chunks.chunk_length::text || ':' || lo_chunks.chunk_sha256,
                              E'\n' ORDER BY lo_chunks.chunk_number), ''), 'UTF8'
         )), 'hex') AS object_sha256
  FROM lo_chunks
  GROUP BY lo_chunks.loid
), large_object_manifest AS (
  SELECT COUNT(*)::bigint AS large_object_count,
         COALESCE(SUM(byte_length), 0)::bigint AS large_object_bytes,
         COUNT(*) FILTER (WHERE exceeds_integrity_limit)::bigint AS invalid_large_object_count,
         encode(pg_catalog.sha256(convert_to(
           COALESCE(jsonb_agg(jsonb_build_object(
             'oid', loid, 'bytes', byte_length, 'sha256', object_sha256
           ) ORDER BY loid)::text, '[]'), 'UTF8'
         )), 'hex') AS large_object_sha256
  FROM lo_objects
)
SELECT CASE WHEN (SELECT invalid_large_object_count = 0 FROM large_object_manifest)
  THEN 'BACKUP_CONTENT_INTEGRITY=PASS|'
  ELSE 'BACKUP_CONTENT_INTEGRITY=FAIL|'
  END
  || (SELECT schema_sha256 FROM schema_manifest) || '|'
  || (SELECT table_sha256 FROM table_manifest) || '|'
  || (SELECT sequence_sha256 FROM sequence_manifest) || '|'
  || (SELECT large_object_sha256 FROM large_object_manifest) || '|'
  || (SELECT table_count::text FROM table_manifest) || '|'
  || (SELECT row_count::text FROM table_manifest) || '|'
  || (SELECT sequence_count::text FROM sequence_manifest) || '|'
  || (SELECT large_object_count::text FROM large_object_manifest) || '|'
  || (SELECT large_object_bytes::text FROM large_object_manifest) AS integrity_result;

COMMIT;
