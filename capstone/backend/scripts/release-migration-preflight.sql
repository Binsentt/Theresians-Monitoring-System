\set ON_ERROR_STOP on

-- Use a read-only database role and PGOPTIONS:
-- -c default_transaction_read_only=on -c statement_timeout=30000
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';

SELECT current_database() AS database_name,
       current_user AS database_user,
       inet_server_addr()::text AS server_address,
       inet_server_port() AS server_port,
       current_setting('server_version') AS server_version,
       current_setting('transaction_read_only') AS transaction_read_only;

SELECT object_name,
       to_regclass(format('public.%I', object_name))::text AS relation_name
FROM (VALUES
  ('schema_migrations'),
  ('accounts'),
  ('game_results'),
  ('playtime_sessions'),
  ('activity_logs'),
  ('website_sessions'),
  ('student_quest_milestones'),
  ('playtime_deletion_tombstones'),
  ('game_progress_save_commits')
) AS objects(object_name)
ORDER BY object_name;

SELECT (to_regclass('public.schema_migrations') IS NOT NULL) AS ledger_present \gset
\if :ledger_present
  \echo 'Migration ledger exists; continuing with read-only inspection.'
\else
  \echo 'STOP: schema_migrations is absent. Reconcile target history; no ledger was created.'
  \quit 3
\endif

-- Compare the returned ledger checksum to sha256sum of the exact migration
-- source files at the approved release commit. This query does not infer that
-- a missing ledger means all migrations are pending.
WITH expected(version, filename) AS (
  VALUES
    (18, '018_website_sessions_and_audit_metadata.sql'),
    (19, '019_playtime_history_removal.sql'),
    (20, '020_add_auth_otp_challenge_security.sql'),
    (21, '021_canonical_milestones_and_activity_contract.sql'),
    (22, '022_game_telemetry_contract.sql'),
    (23, '023_quest_evidence_and_playtime_tombstones.sql'),
    (24, '024_remove_legacy_six_digit_students.sql'),
    (25, '025_add_game_result_question_traceability.sql'),
    (26, '026_game_progress_save_commit_idempotency.sql')
)
SELECT e.version,
       e.filename AS expected_filename,
       m.filename AS ledger_filename,
       m.checksum AS ledger_sha256,
       m.applied_at,
       CASE
         WHEN m.version IS NULL THEN 'PENDING'
         WHEN m.filename <> e.filename THEN 'STOP_FILENAME_MISMATCH'
         ELSE 'APPLIED_COMPARE_CHECKSUM_TO_SOURCE'
       END AS preflight_state
FROM expected AS e
LEFT JOIN public.schema_migrations AS m ON m.version = e.version
ORDER BY e.version;

WITH expected(version, filename) AS (
  VALUES
    (18, '018_website_sessions_and_audit_metadata.sql'),
    (19, '019_playtime_history_removal.sql'),
    (20, '020_add_auth_otp_challenge_security.sql'),
    (21, '021_canonical_milestones_and_activity_contract.sql'),
    (22, '022_game_telemetry_contract.sql'),
    (23, '023_quest_evidence_and_playtime_tombstones.sql'),
    (24, '024_remove_legacy_six_digit_students.sql'),
    (25, '025_add_game_result_question_traceability.sql'),
    (26, '026_game_progress_save_commit_idempotency.sql')
)
SELECT EXISTS (
  SELECT 1
  FROM expected AS e
  JOIN public.schema_migrations AS m ON m.version = e.version
  WHERE m.filename <> e.filename
) AS filename_mismatch \gset
\if :filename_mismatch
  \echo 'STOP: migration ledger filename mismatch. No preflight counts are trusted.'
  \quit 3
\endif

SELECT EXISTS (
  SELECT 1 FROM public.schema_migrations WHERE version > 26
) AS newer_migration_present \gset
\if :newer_migration_present
  \echo 'STOP: ledger contains migration versions newer than this release source.'
  \quit 3
\endif


-- Account, progress, and activity schema metadata only. A missing optional
-- receipt table returns no rows; if 026 is already recorded as applied but
-- its table is missing, treat that as a stop condition.
SELECT table_name, column_name, data_type, udt_name, is_nullable,
       character_maximum_length, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('accounts', 'activity_logs', 'game_progress_save_commits')
ORDER BY table_name, ordinal_position;

SELECT c.conrelid::regclass::text AS table_name,
       c.conname,
       CASE c.contype
         WHEN 'p' THEN 'PRIMARY KEY'
         WHEN 'u' THEN 'UNIQUE'
         WHEN 'f' THEN 'FOREIGN KEY'
         WHEN 'c' THEN 'CHECK'
         ELSE c.contype::text
       END AS constraint_type,
       c.convalidated,
       pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint AS c
WHERE c.conrelid = ANY (ARRAY[
  to_regclass('public.accounts')::oid,
  to_regclass('public.activity_logs')::oid,
  to_regclass('public.game_progress_save_commits')::oid
])
ORDER BY table_name, c.conname;

SELECT EXISTS (
         SELECT 1 FROM public.schema_migrations WHERE version = 26
       ) AS migration_026_applied,
       (to_regclass('public.accounts') IS NOT NULL) AS accounts_present,
       (to_regclass('public.activity_logs') IS NOT NULL) AS activity_logs_present,
       (to_regclass('public.game_progress_save_commits') IS NOT NULL) AS receipts_present \gset
\if :migration_026_applied
  \if :receipts_present
    \echo 'Migration 026 is recorded and the receipt table exists; review its complete shape above.'
  \else
    \echo 'STOP: migration 026 is recorded but the receipt table is absent.'
    \quit 3
  \endif
\else
  \if :accounts_present
    \if :activity_logs_present
      \echo 'Migration 026 prerequisites are present or will be checked against pending migration order.'
    \else
      \echo 'STOP: activity_logs is absent while migration 026 is not recorded.'
      \quit 3
    \endif
  \else
    \echo 'STOP: accounts is absent while migration 026 is not recorded.'
    \quit 3
  \endif
\endif

SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('activity_logs', 'game_progress_save_commits')
ORDER BY tablename, indexname;

-- Only calculate deletion impact when migration 024 is still pending.
SELECT NOT EXISTS (
  SELECT 1 FROM public.schema_migrations WHERE version = 24
) AS migration_024_pending \gset
\if :migration_024_pending
  SELECT (to_regclass('public.accounts') IS NOT NULL) AS accounts_present,
         (to_regclass('public.game_results') IS NOT NULL) AS game_results_present,
         (to_regclass('public.playtime_sessions') IS NOT NULL) AS playtime_sessions_present \gset
  \if :accounts_present
    \if :game_results_present
      \if :playtime_sessions_present
        \echo 'Migration 024 direct count-only impact follows; no identifiers are selected.'
      \else
        \echo 'STOP: playtime_sessions is absent while migration 024 is pending.'
        \quit 3
      \endif
    \else
      \echo 'STOP: game_results is absent while migration 024 is pending.'
      \quit 3
    \endif
  \else
    \echo 'STOP: accounts is absent while migration 024 is pending.'
    \quit 3
  \endif

  WITH candidates AS (
    SELECT id
    FROM public.accounts
    WHERE LOWER(role) = 'student'
      AND BTRIM(COALESCE(game_student_id, '')) ~ '^[0-9]{6}$'
  )
  SELECT 'accounts (direct delete)' AS impact, COUNT(*) AS row_count
  FROM candidates
  UNION ALL
  SELECT 'game_results.resolved_student_id (direct delete)', COUNT(*)
  FROM public.game_results AS gr
  JOIN candidates AS c ON c.id = gr.resolved_student_id
  UNION ALL
  SELECT 'playtime_sessions.student_id (direct delete)', COUNT(*)
  FROM public.playtime_sessions AS ps
  JOIN candidates AS c ON c.id = ps.student_id;

  -- Known FK effects defined by migrations 018, 019, 021, 023, and 026.
  -- Missing optional tables are skipped; review their pending versions above.
  SELECT to_regclass('public.website_sessions') IS NOT NULL AS website_sessions_present,
         to_regclass('public.student_quest_milestones') IS NOT NULL AS milestones_present,
         to_regclass('public.game_progress_save_commits') IS NOT NULL AS receipts_present,
         to_regclass('public.playtime_deletion_tombstones') IS NOT NULL AS tombstones_present \gset
  \if :website_sessions_present
    WITH candidates AS (
      SELECT id FROM public.accounts
      WHERE LOWER(role) = 'student'
        AND BTRIM(COALESCE(game_student_id, '')) ~ '^[0-9]{6}$'
    )
    SELECT 'website_sessions.account_id (ON DELETE CASCADE)' AS impact, COUNT(*) AS row_count
    FROM public.website_sessions AS ws
    JOIN candidates AS c ON c.id = ws.account_id;
  \endif
  \if :milestones_present
    WITH candidates AS (
      SELECT id FROM public.accounts
      WHERE LOWER(role) = 'student'
        AND BTRIM(COALESCE(game_student_id, '')) ~ '^[0-9]{6}$'
    )
    SELECT 'student_quest_milestones.student_id (ON DELETE CASCADE)' AS impact, COUNT(*) AS row_count
    FROM public.student_quest_milestones AS sqm
    JOIN candidates AS c ON c.id = sqm.student_id;
  \endif
  \if :receipts_present
    WITH candidates AS (
      SELECT id FROM public.accounts
      WHERE LOWER(role) = 'student'
        AND BTRIM(COALESCE(game_student_id, '')) ~ '^[0-9]{6}$'
    )
    SELECT 'game_progress_save_commits.student_id (ON DELETE CASCADE)' AS impact, COUNT(*) AS row_count
    FROM public.game_progress_save_commits AS sc
    JOIN candidates AS c ON c.id = sc.student_id;
  \endif
  \if :tombstones_present
    WITH candidates AS (
      SELECT id FROM public.accounts
      WHERE LOWER(role) = 'student'
        AND BTRIM(COALESCE(game_student_id, '')) ~ '^[0-9]{6} for all direct inbound FK constraints and CASCADE
  -- descendants. Operators must derive count-only joins for every additional
  -- baseline relation shown here before approving migration 024.
  SELECT confrelid::regclass::text AS referenced_parent,
         conrelid::regclass::text AS referencing_child,
         conname,
         CASE confdeltype
           WHEN 'a' THEN 'NO ACTION'
           WHEN 'r' THEN 'RESTRICT'
           WHEN 'c' THEN 'CASCADE'
           WHEN 'n' THEN 'SET NULL'
           WHEN 'd' THEN 'SET DEFAULT'
         END AS on_delete,
         pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
  WHERE contype = 'f'
    AND confrelid IN (
      'public.accounts'::regclass,
      'public.game_results'::regclass,
      'public.playtime_sessions'::regclass
    )
  ORDER BY referenced_parent, referencing_child, conname;

  WITH RECURSIVE cascade_edges(parent_oid, child_oid, constraint_oid, depth, path) AS (
    SELECT c.confrelid, c.conrelid, c.oid, 1,
           ARRAY[c.confrelid, c.conrelid]::oid[]
    FROM pg_constraint AS c
    WHERE c.contype = 'f'
      AND c.confdeltype = 'c'
      AND c.confrelid IN (
        'public.accounts'::regclass,
        'public.game_results'::regclass,
        'public.playtime_sessions'::regclass
      )
    UNION ALL
    SELECT c.confrelid, c.conrelid, c.oid, e.depth + 1,
           e.path || c.conrelid
    FROM cascade_edges AS e
    JOIN pg_constraint AS c
      ON c.contype = 'f'
     AND c.confdeltype = 'c'
     AND c.confrelid = e.child_oid
    WHERE NOT c.conrelid = ANY(e.path)
  )
  SELECT DISTINCT e.depth,
         e.parent_oid::regclass::text AS parent_table,
         e.child_oid::regclass::text AS child_table,
         c.conname,
         pg_get_constraintdef(c.oid) AS definition
  FROM cascade_edges AS e
  JOIN pg_constraint AS c ON c.oid = e.constraint_oid
  ORDER BY e.depth, parent_table, child_table, c.conname;
\else
  \echo 'Migration 024 is recorded as applied; no 024 deletion counts were run.'
\endif

ROLLBACK;

    )
    SELECT 'playtime_deletion_tombstones.deleted_by (ON DELETE SET NULL)' AS impact, COUNT(*) AS row_count
    FROM public.playtime_deletion_tombstones AS t
    JOIN candidates AS c ON c.id = t.deleted_by;
  \endif
  \if :playtime_sessions_present
    WITH candidates AS (
      SELECT id FROM public.accounts
      WHERE LOWER(role) = 'student'
        AND BTRIM(COALESCE(game_student_id, '')) ~ '^[0-9]{6} for all direct inbound FK constraints and CASCADE
  -- descendants. Operators must derive count-only joins for every additional
  -- baseline relation shown here before approving migration 024.
  SELECT confrelid::regclass::text AS referenced_parent,
         conrelid::regclass::text AS referencing_child,
         conname,
         CASE confdeltype
           WHEN 'a' THEN 'NO ACTION'
           WHEN 'r' THEN 'RESTRICT'
           WHEN 'c' THEN 'CASCADE'
           WHEN 'n' THEN 'SET NULL'
           WHEN 'd' THEN 'SET DEFAULT'
         END AS on_delete,
         pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
  WHERE contype = 'f'
    AND confrelid IN (
      'public.accounts'::regclass,
      'public.game_results'::regclass,
      'public.playtime_sessions'::regclass
    )
  ORDER BY referenced_parent, referencing_child, conname;

  WITH RECURSIVE cascade_edges(parent_oid, child_oid, constraint_oid, depth, path) AS (
    SELECT c.confrelid, c.conrelid, c.oid, 1,
           ARRAY[c.confrelid, c.conrelid]::oid[]
    FROM pg_constraint AS c
    WHERE c.contype = 'f'
      AND c.confdeltype = 'c'
      AND c.confrelid IN (
        'public.accounts'::regclass,
        'public.game_results'::regclass,
        'public.playtime_sessions'::regclass
      )
    UNION ALL
    SELECT c.confrelid, c.conrelid, c.oid, e.depth + 1,
           e.path || c.conrelid
    FROM cascade_edges AS e
    JOIN pg_constraint AS c
      ON c.contype = 'f'
     AND c.confdeltype = 'c'
     AND c.confrelid = e.child_oid
    WHERE NOT c.conrelid = ANY(e.path)
  )
  SELECT DISTINCT e.depth,
         e.parent_oid::regclass::text AS parent_table,
         e.child_oid::regclass::text AS child_table,
         c.conname,
         pg_get_constraintdef(c.oid) AS definition
  FROM cascade_edges AS e
  JOIN pg_constraint AS c ON c.oid = e.constraint_oid
  ORDER BY e.depth, parent_table, child_table, c.conname;
\else
  \echo 'Migration 024 is recorded as applied; no 024 deletion counts were run.'
\endif

ROLLBACK;

    )
    SELECT 'playtime_sessions.deleted_by (ON DELETE SET NULL, excluding direct deletes)' AS impact,
           COUNT(*) AS row_count
    FROM public.playtime_sessions AS ps
    JOIN candidates AS deleter ON deleter.id = ps.deleted_by
    WHERE NOT EXISTS (
      SELECT 1 FROM candidates AS direct_delete
      WHERE direct_delete.id = ps.student_id
    );
  \endif

  -- Catalog inventory for all direct inbound FK constraints and CASCADE
  -- descendants. Operators must derive count-only joins for every additional
  -- baseline relation shown here before approving migration 024.
  SELECT confrelid::regclass::text AS referenced_parent,
         conrelid::regclass::text AS referencing_child,
         conname,
         CASE confdeltype
           WHEN 'a' THEN 'NO ACTION'
           WHEN 'r' THEN 'RESTRICT'
           WHEN 'c' THEN 'CASCADE'
           WHEN 'n' THEN 'SET NULL'
           WHEN 'd' THEN 'SET DEFAULT'
         END AS on_delete,
         pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
  WHERE contype = 'f'
    AND confrelid IN (
      'public.accounts'::regclass,
      'public.game_results'::regclass,
      'public.playtime_sessions'::regclass
    )
  ORDER BY referenced_parent, referencing_child, conname;

  WITH RECURSIVE cascade_edges(parent_oid, child_oid, constraint_oid, depth, path) AS (
    SELECT c.confrelid, c.conrelid, c.oid, 1,
           ARRAY[c.confrelid, c.conrelid]::oid[]
    FROM pg_constraint AS c
    WHERE c.contype = 'f'
      AND c.confdeltype = 'c'
      AND c.confrelid IN (
        'public.accounts'::regclass,
        'public.game_results'::regclass,
        'public.playtime_sessions'::regclass
      )
    UNION ALL
    SELECT c.confrelid, c.conrelid, c.oid, e.depth + 1,
           e.path || c.conrelid
    FROM cascade_edges AS e
    JOIN pg_constraint AS c
      ON c.contype = 'f'
     AND c.confdeltype = 'c'
     AND c.confrelid = e.child_oid
    WHERE NOT c.conrelid = ANY(e.path)
  )
  SELECT DISTINCT e.depth,
         e.parent_oid::regclass::text AS parent_table,
         e.child_oid::regclass::text AS child_table,
         c.conname,
         pg_get_constraintdef(c.oid) AS definition
  FROM cascade_edges AS e
  JOIN pg_constraint AS c ON c.oid = e.constraint_oid
  ORDER BY e.depth, parent_table, child_table, c.conname;
\else
  \echo 'Migration 024 is recorded as applied; no 024 deletion counts were run.'
\endif

ROLLBACK;
