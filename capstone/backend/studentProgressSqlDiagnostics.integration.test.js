const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { RELEASE_MIGRATIONS, applyReleaseMigrations } = require('./releaseMigrations');
const { getPublicRegistrySnapshot } = require('./curriculumScopeRegistry');

const databaseUrl = process.env.STUDENT_DIAGNOSTICS_TEST_DATABASE_URL || '';
const databaseName = 'tq_student_progress_diagnostics_test_ci';
const diagnosticRole = 'tq_student_progress_diagnostic_reader';
const diagnosticsDir = path.join(__dirname, 'diagnostics');
const query1 = fs.readFileSync(path.join(diagnosticsDir, 'student-progress-query-1.sql'), 'utf8');
const query2 = fs.readFileSync(path.join(diagnosticsDir, 'student-progress-query-2.sql'), 'utf8');
const preflightSql = fs.readFileSync(path.join(diagnosticsDir, 'student-progress-diagnostics-preflight.sql'), 'utf8');
const workflowRelativePath = path.join('.github', 'workflows', 'backend-network-isolated.yml');
const resolveIsolatedWorkflowPath = (
  backendDirectory = __dirname,
  workflowPathOverride = process.env.STUDENT_PROGRESS_CI_WORKFLOW_PATH,
  fileExists = fs.existsSync
) => {
  const candidates = [
    workflowPathOverride,
    path.resolve(backendDirectory, '..', workflowRelativePath),
    path.resolve(backendDirectory, '..', '..', workflowRelativePath),
  ].filter(Boolean);
  return candidates.find((candidate) => fileExists(candidate)) || null;
};
const isolatedWorkflowPath = resolveIsolatedWorkflowPath();
if (!isolatedWorkflowPath) {
  throw new Error(`Unable to locate ${workflowRelativePath}; expose it read-only or set STUDENT_PROGRESS_CI_WORKFLOW_PATH.`);
}
const isolatedWorkflow = fs.readFileSync(isolatedWorkflowPath, 'utf8');
const studentId = 501;
const currentCycle = 2;
const studentNameSentinel = 'SYNTHETIC_PRIVATE_STUDENT_NAME';
const questionSentinel = 'SYNTHETIC_PRIVATE_QUESTION_TEXT';
const answerSentinel = 'SYNTHETIC_PRIVATE_ANSWER_TEXT';

test('isolated workflow lookup supports app-root, repository-root, and mounted CI layouts', () => {
  const backendDirectory = path.resolve('synthetic-worktree', 'capstone', 'backend');
  const appRootWorkflow = path.resolve(backendDirectory, '..', workflowRelativePath);
  const repositoryRootWorkflow = path.resolve(backendDirectory, '..', '..', workflowRelativePath);
  const mountedWorkflow = path.resolve('workflow-config', 'workflows', 'backend-network-isolated.yml');

  assert.equal(resolveIsolatedWorkflowPath(backendDirectory, null, (candidate) => candidate === appRootWorkflow), appRootWorkflow);
  assert.equal(resolveIsolatedWorkflowPath(backendDirectory, null, (candidate) => candidate === repositoryRootWorkflow), repositoryRootWorkflow);
  assert.equal(resolveIsolatedWorkflowPath(backendDirectory, mountedWorkflow, (candidate) => candidate === mountedWorkflow), mountedWorkflow);
});

test('diagnostic preflight covers all Query 2 columns and column-level write privileges', () => {
  assert.match(preflightSql, /\('game_results',\s*'grade_level'\)/);
  assert.match(preflightSql, /\('game_results',\s*'difficulty'\)/);
  assert.match(preflightSql, /has_any_column_privilege/i);
  assert.match(preflightSql, /has_any_column_privilege\([\s\S]*?'INSERT'/i);
  assert.match(preflightSql, /has_any_column_privilege\([\s\S]*?'UPDATE'/i);
  assert.match(preflightSql, /has_schema_privilege\(current_user, 'public', 'USAGE'\)/i);
});

test('Query 2 treats whitespace-only question Grade and Difficulty as invalid ingestion scope', () => {
  assert.match(query2, /CASE WHEN q\.grade_level IS NULL OR q\.grade_level = '' THEN s\.canonical_grade/i);
  assert.match(query2, /CASE WHEN q\.difficulty IS NULL OR q\.difficulty = '' THEN s\.canonical_difficulty/i);
  assert.match(query2, /ELSE q_grade\.canonical_grade END IS NULL/i);
  assert.match(query2, /ELSE q_difficulty\.canonical_difficulty END IS NULL/i);
});

test('isolated CI marks and forwards only the diagnostics database as disposable', () => {
  assert.match(isolatedWorkflow, /tq_student_progress_diagnostics_test_ci/);
  assert.match(isolatedWorkflow, /COMMENT ON DATABASE[\s\S]*tq-disposable-ci:/);
  assert.match(isolatedWorkflow, /TQ_DISPOSABLE_DB_SENTINEL/);
  assert.match(isolatedWorkflow, /--env TQ_DISPOSABLE_DB_SENTINEL/);
  assert.match(isolatedWorkflow, /--volume "\$GITHUB_WORKSPACE\/\.github:\/workflow-config:ro"/);
  assert.match(isolatedWorkflow, /--env STUDENT_PROGRESS_CI_WORKFLOW_PATH=\/workflow-config\/workflows\/backend-network-isolated\.yml/);
});

const isApprovedDisposableDatabase = (value, env = process.env) => {
  try {
    const url = new URL(value);
    return env.CI === 'true'
      && env.NODE_ENV === 'test'
      && /^[a-f0-9]{48}$/.test(env.TQ_DISPOSABLE_DB_SENTINEL || '')
      && ['postgres:', 'postgresql:'].includes(url.protocol)
      && url.hostname === '127.0.0.1'
      && decodeURIComponent(url.pathname.slice(1)) === databaseName
      && !url.search
      && !url.hash;
  } catch (_error) {
    return false;
  }
};

test('database safety guard rejects unmarked, remote, or URL-overridden PostgreSQL targets', () => {
  const env = { CI: 'true', NODE_ENV: 'test', TQ_DISPOSABLE_DB_SENTINEL: 'a'.repeat(48) };
  const safeUrl = `postgresql://postgres@127.0.0.1:5432/${databaseName}`;
  assert.equal(isApprovedDisposableDatabase(safeUrl, env), true);
  assert.equal(isApprovedDisposableDatabase(`${safeUrl}?host=production.example.test`, env), false);
  assert.equal(isApprovedDisposableDatabase('postgresql://postgres@production.example.test/tq_student_progress_diagnostics_test_ci', env), false);
  assert.equal(isApprovedDisposableDatabase(safeUrl, { ...env, TQ_DISPOSABLE_DB_SENTINEL: '' }), false);
  assert.equal(isApprovedDisposableDatabase(safeUrl, { ...env, CI: 'false' }), false);
});

if (!isApprovedDisposableDatabase(databaseUrl)) {
  if (process.env.CI === 'true') {
    throw new Error('CI must provide only the isolated loopback Student diagnostics database URL');
  }
  test('Student Progress SQL diagnostics require isolated PostgreSQL', {
    skip: 'STUDENT_DIAGNOSTICS_TEST_DATABASE_URL must target 127.0.0.1/tq_student_progress_diagnostics_test_ci',
  }, () => {});
} else {
  test('Student Progress aggregate diagnostics match canonical contracts on disposable PostgreSQL', async (t) => {
    assert.equal(process.env.AI_RUNTIME_ENABLED, 'false');
    assert.equal(process.env.AI_GENERATION_ENABLED, 'false');
    if (process.env.DATABASE_URL) {
      const generalDatabase = new URL(process.env.DATABASE_URL);
      assert.equal(generalDatabase.hostname, '127.0.0.1', 'the general CI database must remain loopback-only');
      assert.equal(decodeURIComponent(generalDatabase.pathname.slice(1)), 'tq_backend_test_ci');
    }
    assert.equal(process.env.RESEND_API_KEY, undefined);
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    assert.equal(process.env.SMTP_PASSWORD, undefined);
    assert.equal(process.env.SMTP_USER, undefined);

    const bootstrap = new Pool({ connectionString: databaseUrl, max: 2 });
    let diagnosticClient;
    let roleCreated = false;
    try {
      const endpoint = await bootstrap.query(`
        SELECT current_database() AS database_name,
               inet_server_addr()::TEXT AS server_address,
               current_setting('transaction_read_only') AS transaction_read_only,
               shobj_description(db.oid, 'pg_database') AS database_comment
        FROM pg_database db
        WHERE db.datname = current_database()
      `);
      assert.equal(endpoint.rows[0].database_name, databaseName);
      assert.equal(endpoint.rows[0].server_address, '127.0.0.1');
      assert.equal(endpoint.rows[0].database_comment, `tq-disposable-ci:${process.env.TQ_DISPOSABLE_DB_SENTINEL}`);

      await bootstrap.query(`DROP TABLE IF EXISTS
        public.game_results,
        public.questions,
        public.learning_files,
        public.playtime_sessions,
        public.accounts,
        public.schema_migrations CASCADE`);
      await bootstrap.query('DROP SCHEMA IF EXISTS tq_legacy_diagnostic_fixture CASCADE');
      const priorRole = await bootstrap.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [diagnosticRole]);
      if (priorRole.rowCount) {
        await bootstrap.query(`DROP OWNED BY ${diagnosticRole}`);
        await bootstrap.query(`DROP ROLE ${diagnosticRole}`);
      }
      await bootstrap.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await bootstrap.query(`
        CREATE TABLE public.accounts (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          role TEXT NOT NULL,
          is_archived BOOLEAN NOT NULL DEFAULT false,
          current_learning_cycle_version INTEGER NOT NULL DEFAULT 0,
          current_learning_cycle_started_at TIMESTAMPTZ
        );
        CREATE TABLE public.learning_files (
          id INTEGER PRIMARY KEY,
          grade_level VARCHAR(50),
          difficulty VARCHAR(20),
          topic_id VARCHAR(100),
          math_topic VARCHAR(100)
        );
        CREATE TABLE public.questions (
          id INTEGER PRIMARY KEY,
          learning_file_id INTEGER NOT NULL REFERENCES public.learning_files(id),
          question TEXT NOT NULL,
          correct_answer TEXT NOT NULL,
          grade_level VARCHAR(50),
          difficulty VARCHAR(20),
          topic_id VARCHAR(100),
          math_topic VARCHAR(100)
        );
        CREATE TABLE public.playtime_sessions (
          id INTEGER PRIMARY KEY,
          student_id INTEGER NOT NULL REFERENCES public.accounts(id),
          learning_cycle_version INTEGER
        );
        CREATE TABLE public.game_results (
          id INTEGER PRIMARY KEY,
          resolved_student_id INTEGER NOT NULL REFERENCES public.accounts(id),
          grade_level VARCHAR(50),
          difficulty VARCHAR(20),
          math_topic VARCHAR(100),
          score INTEGER NOT NULL,
          total_items INTEGER NOT NULL,
          played_at TIMESTAMPTZ NOT NULL,
          question_set_id INTEGER REFERENCES public.learning_files(id) ON DELETE RESTRICT,
          playtime_session_id INTEGER,
          session_id BIGINT
        );
      `);

      await bootstrap.query(`INSERT INTO public.accounts
        (id, name, role, is_archived, current_learning_cycle_version, current_learning_cycle_started_at)
        VALUES ($1, $2, 'student', false, $3, '2026-09-01T00:00:00Z')`,
      [studentId, studentNameSentinel, currentCycle]);
      await bootstrap.query(`INSERT INTO public.playtime_sessions (id, student_id, learning_cycle_version)
        VALUES (100, $1, 2), (101, $1, 1)`, [studentId]);
      await bootstrap.query(`INSERT INTO public.learning_files
        (id, grade_level, difficulty, topic_id, math_topic) VALUES
        (10, 'Grade 1', 'Easy', 'basic_addition', 'Basic Addition'),
        (11, 'Grade 1', 'Easy', NULL, 'Mathematics'),
        (12, 'Grade 1', 'Easy', 'subtraction', 'Subtraction'),
        (13, 'Grade 1', 'Easy', NULL, 'Mathematics'),
        (14, 'Grade 1', 'Easy', NULL, 'Mathematics'),
        (15, 'Grade 1', 'Easy', NULL, 'Mathematics'),
        (16, 'Grade 1', 'Easy', 'basic_addition', 'Basic Addition'),
        (17, 'Grade 1', 'Easy', '', 'Mathematics'),
        (18, 'Grade 1', 'Easy', 'invalid_set_topic', 'Basic Addition'),
        (19, 'Grade 1', 'Easy', '   ', 'Basic Addition')`);
      await bootstrap.query(`INSERT INTO public.questions
        (id, learning_file_id, question, correct_answer, grade_level, difficulty, topic_id, math_topic) VALUES
        (100, 10, $1, $2, 'Grade 1', 'Easy', 'basic_addition', 'Basic Addition'),
        (101, 11, $1, $2, 'Grade 1', 'Easy', NULL, 'Basic Addition'),
        (102, 15, $1, $2, 'Grade 1', 'Easy', 'invalid_question_topic', 'Basic Addition'),
        (103, 12, $1, $2, 'Grade 1', 'Easy', 'basic_addition', 'Basic Addition'),
        (104, 13, $1, $2, 'Grade 1', 'Easy', NULL, 'Subtraction'),
        (105, 14, $1, $2, 'Grade 1', 'Easy', NULL, 'Unknown Legacy Label'),
        (106, 16, $1, $2, '   ', '   ', 'basic_addition', 'Basic Addition'),
        (107, 17, $1, $2, NULL, NULL, '', 'Basic Addition'),
        (108, 11, $1, $2, '', '', '', 'Basic Addition'),
        (109, 19, $1, $2, 'Grade 1', 'Easy', '   ', 'Basic Addition')`,
      [questionSentinel, answerSentinel]);

      const migration025 = RELEASE_MIGRATIONS.find(({ version }) => version === 25);
      assert.ok(migration025, 'release migration registry must include migration 025');
      const migrationClient = await bootstrap.connect();
      try {
        await applyReleaseMigrations({ client: migrationClient, migrations: [migration025] });
      } finally {
        migrationClient.release();
      }

      const migrationRow = await bootstrap.query(
        'SELECT filename FROM public.schema_migrations WHERE version = 25',
      );
      assert.deepEqual(migrationRow.rows, [{ filename: '025_add_game_result_question_traceability.sql' }]);
      const migrationConstraints = await bootstrap.query(`
        SELECT conname, convalidated
        FROM pg_constraint
        WHERE conrelid = 'public.game_results'::regclass
          AND conname IN ('game_results_question_set_question_fkey', 'game_results_question_requires_set_check')
        ORDER BY conname
      `);
      assert.deepEqual(migrationConstraints.rows, [
        { conname: 'game_results_question_requires_set_check', convalidated: true },
        { conname: 'game_results_question_set_question_fkey', convalidated: true },
      ]);
      const migrationIndexes = await bootstrap.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN ('questions', 'game_results')
          AND indexname IN ('questions_id_learning_file_id_unique', 'idx_game_results_question_id')
        ORDER BY indexname
      `);
      assert.deepEqual(migrationIndexes.rows.map(({ indexname }) => indexname), [
        'idx_game_results_question_id',
        'questions_id_learning_file_id_unique',
      ]);
      assert.match(migrationIndexes.rows[0].indexdef, /WHERE \(question_id IS NOT NULL\)/i);
      assert.match(migrationIndexes.rows[1].indexdef, /CREATE UNIQUE INDEX/i);

      await bootstrap.query(`INSERT INTO public.game_results
        (id, resolved_student_id, grade_level, difficulty, math_topic, score, total_items, played_at,
         question_set_id, question_id, session_id, playtime_session_id) VALUES
        (1, $1, 'Grade 1', 'Easy', 'untrusted copied label', 1, 1, '2026-09-02T00:00:00Z', 10, 100, 100, 100),
        (2, $1, 'Grade 1', 'Easy', 'untrusted copied label', 0, 1, '2026-09-02T00:01:00Z', 11, 101, 100, 100),
        (3, $1, 'Grade 1', 'Easy', 'untrusted copied label', 0, 1, '2026-09-02T00:02:00Z', 15, 102, 100, 100),
        (4, $1, 'Grade 1', 'Easy', 'untrusted copied label', 1, 1, '2026-09-02T00:03:00Z', 12, 103, 100, 100),
        (5, $1, 'Grade 1', 'Easy', 'untrusted copied label', 1, 1, '2026-09-02T00:04:00Z', 10, NULL, 100, 100),
        (6, $1, 'Grade 1', 'Easy', 'untrusted copied label', 0, 1, '2026-09-02T00:05:00Z', NULL, NULL, NULL, NULL),
        (7, $1, 'Grade 1', 'Easy', 'untrusted copied label', 1, 1, '2026-09-02T00:06:00Z', 13, NULL, 100, 100),
        (8, $1, 'Grade 1', 'Easy', 'untrusted copied label', 0, 1, '2026-09-02T00:07:00Z', 14, NULL, 100, 100),
        (9, $1, 'Grade 1', 'Easy', 'untrusted copied label', 0, 1, '2026-09-02T00:08:00Z', 18, NULL, 100, 100),
        (10, $1, 'Grade 1', 'Easy', 'untrusted copied label', 1, 1, '2026-09-02T00:09:00Z', 10, 100, 101, 101),
        (11, $1, 'Grade 1', 'Easy', 'untrusted copied label', 1, 1, '2026-09-02T00:10:00Z', 10, 100, 100, 101),
        (12, $1, 'Grade 1', 'Easy', 'untrusted copied label', 1, 1, '2026-09-02T00:11:00Z', 16, 106, 100, 100),
        (13, $1, 'Grade 1', 'Easy', 'untrusted copied label', 1, 1, '2026-09-02T00:12:00Z', 17, 107, 100, 100),
        (14, $1, 'Grade 1', 'Easy', 'untrusted copied label', 1, 1, '2026-09-02T00:13:00Z', 11, 108, 100, 100),
        (15, $1, 'Grade 1', 'Easy', 'untrusted copied label', 1, 1, '2026-09-02T00:14:00Z', 19, 109, 100, 100),
        (16, $1, 'Grade 1', 'Easy', 'untrusted copied label', 0, 1, '2026-08-31T23:59:00Z', 10, 100, 100, 100)`,
      [studentId]);

      await assert.rejects(
        bootstrap.query(`INSERT INTO public.game_results
          (id, resolved_student_id, score, total_items, played_at, question_set_id, question_id)
          VALUES (90, $1, 1, 1, NOW(), 11, 100)`, [studentId]),
        (error) => error.code === '23503',
        'migration 025 must reject an existing question ID paired with another set',
      );
      await assert.rejects(
        bootstrap.query(`INSERT INTO public.game_results
          (id, resolved_student_id, score, total_items, played_at, question_set_id, question_id)
          VALUES (91, $1, 1, 1, NOW(), 10, 999)`, [studentId]),
        (error) => error.code === '23503',
        'migration 025 must reject a question ID with no source question',
      );
      await assert.rejects(
        bootstrap.query(`INSERT INTO public.game_results
          (id, resolved_student_id, score, total_items, played_at, question_id)
          VALUES (92, $1, 1, 1, NOW(), 100)`, [studentId]),
        (error) => error.code === '23514',
        'migration 025 must reject a question ID without a question set ID',
      );

      await bootstrap.query(`CREATE ROLE ${diagnosticRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
      roleCreated = true;
      await bootstrap.query(`GRANT USAGE ON SCHEMA public TO ${diagnosticRole}`);
      await bootstrap.query(`GRANT SELECT (id, role, is_archived, current_learning_cycle_version, current_learning_cycle_started_at)
        ON public.accounts TO ${diagnosticRole}`);
      await bootstrap.query(`GRANT SELECT (id, resolved_student_id, grade_level, difficulty, math_topic, score, total_items,
        played_at, question_set_id, question_id, session_id, playtime_session_id)
        ON public.game_results TO ${diagnosticRole}`);
      await bootstrap.query(`GRANT SELECT (id, student_id, learning_cycle_version)
        ON public.playtime_sessions TO ${diagnosticRole}`);
      await bootstrap.query(`GRANT SELECT (id, grade_level, difficulty, topic_id, math_topic)
        ON public.learning_files TO ${diagnosticRole}`);
      await bootstrap.query(`GRANT SELECT (id, learning_file_id, grade_level, difficulty, topic_id, math_topic)
        ON public.questions TO ${diagnosticRole}`);
      await bootstrap.query(`GRANT SELECT (version, filename) ON public.schema_migrations TO ${diagnosticRole}`);

      await bootstrap.query(`GRANT INSERT (grade_level) ON public.game_results TO ${diagnosticRole}`);
      diagnosticClient = await bootstrap.connect();
      await diagnosticClient.query(`SET ROLE ${diagnosticRole}`);
      await diagnosticClient.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await diagnosticClient.query("SET LOCAL statement_timeout = '10s'");
      await diagnosticClient.query("SET LOCAL lock_timeout = '2s'");
      const columnWriteGrantPreflight = await diagnosticClient.query(preflightSql, [studentId, currentCycle]);
      assert.equal(columnWriteGrantPreflight.rows[0].no_table_write_privileges, false,
        'preflight must detect a column-level INSERT grant, even when table-level INSERT is absent');
      await diagnosticClient.query('ROLLBACK');
      await diagnosticClient.query('RESET ROLE');
      diagnosticClient.release();
      diagnosticClient = null;
      await bootstrap.query(`REVOKE INSERT (grade_level) ON public.game_results FROM ${diagnosticRole}`);

      const columnInventory = await bootstrap.query(`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (
            ('accounts', 'id'), ('accounts', 'role'), ('accounts', 'is_archived'),
            ('accounts', 'current_learning_cycle_version'), ('accounts', 'current_learning_cycle_started_at'),
            ('game_results', 'resolved_student_id'), ('game_results', 'score'), ('game_results', 'total_items'),
            ('game_results', 'played_at'), ('game_results', 'grade_level'), ('game_results', 'difficulty'),
            ('game_results', 'question_id'), ('game_results', 'question_set_id'),
            ('game_results', 'session_id'), ('game_results', 'playtime_session_id'),
            ('playtime_sessions', 'id'), ('playtime_sessions', 'student_id'), ('playtime_sessions', 'learning_cycle_version'),
            ('learning_files', 'id'), ('learning_files', 'grade_level'), ('learning_files', 'difficulty'),
            ('learning_files', 'topic_id'), ('learning_files', 'math_topic'),
            ('questions', 'id'), ('questions', 'learning_file_id'), ('questions', 'grade_level'),
            ('questions', 'difficulty'), ('questions', 'topic_id'), ('questions', 'math_topic'),
            ('schema_migrations', 'version'), ('schema_migrations', 'filename')
          )
      `);
      assert.equal(columnInventory.rowCount, 31, 'every column used by the diagnostics and migration ledger must exist');

      await createAndRunLegacyAssociationProbe(
        bootstrap,
        diagnosticRole,
        query1,
        query2,
        JSON.stringify(getPublicRegistrySnapshot()),
      );

      const before = await tableCounts(bootstrap);
      diagnosticClient = await bootstrap.connect();
      await diagnosticClient.query(`SET ROLE ${diagnosticRole}`);
      await diagnosticClient.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await diagnosticClient.query("SET LOCAL statement_timeout = '10s'");
      await diagnosticClient.query("SET LOCAL lock_timeout = '2s'");

      const preflight = await diagnosticClient.query(preflightSql, [studentId, currentCycle]);
      assert.deepEqual(preflight.rows, [{
        read_only_transaction: true,
        scope_match_count: 1,
        cycle_parameter_match_count: 1,
        migration_025_count: 1,
        required_columns_present_count: 31,
        required_select_columns: true,
        migration_025_valid_constraint_count: 2,
        migration_025_required_index_count: 2,
        no_table_write_privileges: true,
        public_schema_usage: true,
        no_public_schema_create: true,
        role_is_nonprivileged: true,
      }]);

      const q1 = await diagnosticClient.query(query1, [studentId, currentCycle]);
      const q2 = await diagnosticClient.query(query2, [studentId, currentCycle, JSON.stringify(getPublicRegistrySnapshot())]);
      assert.equal(q1.rowCount, 1);
      assert.equal(q2.rowCount, 1);
      assertAggregateOnly(q1.rows[0], [
        'selected_student_scope_match_count', 'current_cycle_parameter_match_count',
        'current_cycle_eligible_result_count', 'current_cycle_valid_score_count',
        'correct_answers_count', 'incorrect_answers_count', 'missing_question_id_count',
        'missing_question_set_id_count', 'missing_source_question_count', 'missing_source_question_set_count',
        'question_set_association_mismatch_count', 'valid_question_set_association_count',
        'session_id_mismatch_count', 'learning_cycle_timestamp_mismatch_count',
        'learning_cycle_session_mismatch_count', 'parent_history_eligible_result_count',
        'parent_only_eligible_result_count', 'student_analytics_only_eligible_result_count',
      ]);
      assertAggregateOnly(q2.rows[0], [
        'selected_student_scope_match_count', 'current_cycle_parameter_match_count',
        'current_cycle_eligible_result_count', 'current_cycle_valid_score_result_count',
        'analytics_topic_linked_result_count', 'safe_topic_recovered_result_count',
        'exact_question_canonical_id_recovery_count', 'exact_question_label_recovery_count',
        'exact_question_set_topic_recovery_count', 'set_level_consistent_recovery_count',
        'missing_question_id_count', 'missing_question_set_id_count', 'missing_source_question_count',
        'question_set_association_mismatch_count', 'missing_source_question_set_count',
        'invalid_nonblank_question_topic_id_count', 'invalid_nonblank_set_topic_id_count',
        'invalid_question_set_grade_difficulty_scope_count', 'grade_difficulty_scope_conflict_count',
        'question_set_topic_conflict_count', 'mixed_set_question_topic_count',
        'unrecoverable_topic_result_count',
      ]);

      assert.equal(Number(q1.rows[0].current_cycle_eligible_result_count), 14);
      assert.equal(Number(q1.rows[0].current_cycle_valid_score_count), 14);
      assert.equal(Number(q1.rows[0].current_cycle_parameter_match_count), 1);
      assert.equal(Number(q1.rows[0].missing_question_id_count), 5);
      assert.equal(Number(q1.rows[0].missing_question_set_id_count), 1);
      assert.equal(Number(q1.rows[0].missing_source_question_count), 0);
      assert.equal(Number(q1.rows[0].missing_source_question_set_count), 0);
      assert.equal(Number(q1.rows[0].question_set_association_mismatch_count), 0);
      assert.equal(Number(q1.rows[0].session_id_mismatch_count), 1);
      assert.equal(Number(q1.rows[0].learning_cycle_timestamp_mismatch_count), 1);
      assert.equal(Number(q1.rows[0].learning_cycle_session_mismatch_count), 1);
      assert.equal(Number(q1.rows[0].parent_history_eligible_result_count), 12);
      assert.equal(Number(q1.rows[0].parent_only_eligible_result_count), 0);
      assert.equal(Number(q1.rows[0].student_analytics_only_eligible_result_count), 2);

      assert.equal(Number(q2.rows[0].current_cycle_eligible_result_count), 14);
      assert.equal(Number(q2.rows[0].current_cycle_parameter_match_count), 1);
      assert.equal(Number(q2.rows[0].current_cycle_valid_score_result_count), 14);
      assert.equal(Number(q2.rows[0].analytics_topic_linked_result_count), 9);
      assert.equal(Number(q2.rows[0].safe_topic_recovered_result_count), 8);
      assert.equal(Number(q2.rows[0].exact_question_canonical_id_recovery_count), 3);
      assert.equal(Number(q2.rows[0].exact_question_label_recovery_count), 4);
      assert.equal(Number(q2.rows[0].exact_question_set_topic_recovery_count), 0);
      assert.equal(Number(q2.rows[0].set_level_consistent_recovery_count), 2);
      assert.equal(Number(q2.rows[0].invalid_nonblank_question_topic_id_count), 1);
      assert.equal(Number(q2.rows[0].invalid_nonblank_set_topic_id_count), 1);
      assert.equal(Number(q2.rows[0].invalid_question_set_grade_difficulty_scope_count), 0);
      assert.equal(Number(q2.rows[0].grade_difficulty_scope_conflict_count), 1);
      assert.equal(Number(q2.rows[0].question_set_topic_conflict_count), 1);
      assert.equal(Number(q2.rows[0].mixed_set_question_topic_count), 0);
      assert.equal(Number(q2.rows[0].unrecoverable_topic_result_count), 5);

      const readonlyState = await diagnosticClient.query(`
        SELECT current_setting('transaction_read_only') = 'on' AS read_only,
               current_setting('statement_timeout') = '10s' AS statement_timeout_10s,
               current_setting('lock_timeout') = '2s' AS lock_timeout_2s
      `);
      assert.deepEqual(readonlyState.rows[0], {
        read_only: true,
        statement_timeout_10s: true,
        lock_timeout_2s: true,
      });
      await assert.rejects(
        diagnosticClient.query(`INSERT INTO public.game_results
          (id, resolved_student_id, score, total_items, played_at)
          VALUES (99, $1, 1, 1, NOW())`, [studentId]),
        (error) => ['25006', '42501'].includes(error.code),
        'read-only transaction and/or least-privilege grants must reject writes before any row is changed',
      );
      await diagnosticClient.query('ROLLBACK');
      await diagnosticClient.query('RESET ROLE');
      diagnosticClient.release();
      diagnosticClient = null;

      const after = await tableCounts(bootstrap);
      assert.deepEqual(after, before, 'diagnostics must not modify synthetic database rows');
      assert.equal(JSON.stringify([q1.rows[0], q2.rows[0]]).includes(studentNameSentinel), false);
      assert.equal(JSON.stringify([q1.rows[0], q2.rows[0]]).includes(questionSentinel), false);
      assert.equal(JSON.stringify([q1.rows[0], q2.rows[0]]).includes(answerSentinel), false);

      t.diagnosticCounts = { query1: q1.rows[0], query2: q2.rows[0] };
    } finally {
      if (diagnosticClient) {
        await diagnosticClient.query('ROLLBACK').catch(() => {});
        await diagnosticClient.query('RESET ROLE').catch(() => {});
        diagnosticClient.release();
      }
      await bootstrap.query('DROP SCHEMA IF EXISTS tq_legacy_diagnostic_fixture CASCADE').catch(() => {});
      if (roleCreated) {
        await bootstrap.query(`DROP OWNED BY ${diagnosticRole}`).catch(() => {});
        await bootstrap.query(`DROP ROLE IF EXISTS ${diagnosticRole}`).catch(() => {});
      }
      await bootstrap.end();
    }
  });
}

function assertAggregateOnly(row, expectedKeys) {
  const keys = Object.keys(row);
  assert.deepEqual(keys, expectedKeys, 'diagnostics must return only their fixed aggregate count columns');
  for (const key of keys) {
    assert.match(key, /_count$/);
    assert.match(String(row[key]), /^\d+$/);
  }
}

async function createAndRunLegacyAssociationProbe(bootstrap, roleName, query1, query2, registrySnapshot) {
  const schemaName = 'tq_legacy_diagnostic_fixture';
  // Keep malformed historical associations in a separate synthetic schema so
  // the real migration-025 constraints remain enabled and verified in public.
  await bootstrap.query(`CREATE SCHEMA ${schemaName}`);
  try {
    await bootstrap.query(`
      CREATE TABLE ${schemaName}.accounts (
        id INTEGER PRIMARY KEY, role TEXT NOT NULL, is_archived BOOLEAN NOT NULL DEFAULT false,
        current_learning_cycle_version INTEGER NOT NULL, current_learning_cycle_started_at TIMESTAMPTZ
      );
      CREATE TABLE ${schemaName}.playtime_sessions (
        id BIGINT PRIMARY KEY, student_id INTEGER NOT NULL, learning_cycle_version INTEGER
      );
      CREATE TABLE ${schemaName}.learning_files (
        id INTEGER PRIMARY KEY, grade_level TEXT, difficulty TEXT, topic_id TEXT, math_topic TEXT
      );
      CREATE TABLE ${schemaName}.questions (
        id INTEGER PRIMARY KEY, learning_file_id INTEGER NOT NULL, grade_level TEXT,
        difficulty TEXT, topic_id TEXT, math_topic TEXT
      );
      CREATE TABLE ${schemaName}.game_results (
        id INTEGER PRIMARY KEY, resolved_student_id INTEGER NOT NULL, grade_level TEXT,
        difficulty TEXT, math_topic TEXT, score INTEGER NOT NULL, total_items INTEGER NOT NULL,
        played_at TIMESTAMPTZ NOT NULL, question_id INTEGER, question_set_id INTEGER,
        session_id BIGINT, playtime_session_id INTEGER
      );
      INSERT INTO ${schemaName}.accounts VALUES (900, 'student', false, 1, '2026-09-01T00:00:00Z');
      INSERT INTO ${schemaName}.playtime_sessions VALUES (500, 900, 1);
      INSERT INTO ${schemaName}.learning_files VALUES
        (10, 'Grade 1', 'Easy', 'basic_addition', 'Basic Addition'),
        (11, 'Grade 1', 'Easy', 'basic_addition', 'Basic Addition');
      INSERT INTO ${schemaName}.questions VALUES
        (100, 10, 'Grade 1', 'Easy', 'basic_addition', 'Basic Addition');
      INSERT INTO ${schemaName}.game_results VALUES
        (1, 900, 'Grade 1', 'Easy', 'Basic Addition', 1, 1, '2026-09-02T00:00:00Z', 100, 11, 500, 500),
        (2, 900, 'Grade 1', 'Easy', 'Basic Addition', 0, 1, '2026-09-02T00:01:00Z', 999, 10, 500, 500);
      GRANT USAGE ON SCHEMA ${schemaName} TO ${roleName};
      GRANT SELECT ON ALL TABLES IN SCHEMA ${schemaName} TO ${roleName};
    `);
    const legacyQuery1 = query1.replaceAll('public.', `${schemaName}.`);
    const legacyQuery2 = query2.replaceAll('public.', `${schemaName}.`);
    const client = await bootstrap.connect();
    try {
      await client.query(`SET ROLE ${roleName}`);
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '10s'");
      await client.query("SET LOCAL lock_timeout = '2s'");
      const q1 = await client.query(legacyQuery1, [900, 1]);
      assert.equal(q1.rowCount, 1);
      assertAggregateOnly(q1.rows[0], [
        'selected_student_scope_match_count', 'current_cycle_parameter_match_count',
        'current_cycle_eligible_result_count', 'current_cycle_valid_score_count',
        'correct_answers_count', 'incorrect_answers_count', 'missing_question_id_count',
        'missing_question_set_id_count', 'missing_source_question_count', 'missing_source_question_set_count',
        'question_set_association_mismatch_count', 'valid_question_set_association_count',
        'session_id_mismatch_count', 'learning_cycle_timestamp_mismatch_count',
        'learning_cycle_session_mismatch_count', 'parent_history_eligible_result_count',
        'parent_only_eligible_result_count', 'student_analytics_only_eligible_result_count',
      ]);
      assert.equal(Number(q1.rows[0].question_set_association_mismatch_count), 1);
      assert.equal(Number(q1.rows[0].missing_source_question_count), 1);
      assert.equal(Number(q1.rows[0].valid_question_set_association_count), 0);

      const q2 = await client.query(legacyQuery2, [900, 1, registrySnapshot]);
      assert.equal(q2.rowCount, 1);
      assertAggregateOnly(q2.rows[0], [
        'selected_student_scope_match_count', 'current_cycle_parameter_match_count',
        'current_cycle_eligible_result_count', 'current_cycle_valid_score_result_count',
        'analytics_topic_linked_result_count', 'safe_topic_recovered_result_count',
        'exact_question_canonical_id_recovery_count', 'exact_question_label_recovery_count',
        'exact_question_set_topic_recovery_count', 'set_level_consistent_recovery_count',
        'missing_question_id_count', 'missing_question_set_id_count', 'missing_source_question_count',
        'question_set_association_mismatch_count', 'missing_source_question_set_count',
        'invalid_nonblank_question_topic_id_count', 'invalid_nonblank_set_topic_id_count',
        'invalid_question_set_grade_difficulty_scope_count', 'grade_difficulty_scope_conflict_count',
        'question_set_topic_conflict_count', 'mixed_set_question_topic_count',
        'unrecoverable_topic_result_count',
      ]);
      assert.equal(Number(q2.rows[0].missing_source_question_count), 1);
      assert.equal(Number(q2.rows[0].question_set_association_mismatch_count), 1);
      assert.equal(Number(q2.rows[0].analytics_topic_linked_result_count), 0);
      assert.equal(Number(q2.rows[0].unrecoverable_topic_result_count), 2);
      await client.query('ROLLBACK');
      await client.query('RESET ROLE');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.query('RESET ROLE').catch(() => {});
      client.release();
    }
  } finally {
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  }
}

async function tableCounts(client) {
  const result = await client.query(`
    SELECT (SELECT COUNT(*) FROM public.game_results)::INTEGER AS game_results,
           (SELECT COUNT(*) FROM public.questions)::INTEGER AS questions,
           (SELECT COUNT(*) FROM public.learning_files)::INTEGER AS learning_files,
           (SELECT COUNT(*) FROM public.playtime_sessions)::INTEGER AS playtime_sessions,
           (SELECT COUNT(*) FROM public.accounts)::INTEGER AS accounts,
           (SELECT COUNT(*) FROM public.schema_migrations)::INTEGER AS schema_migrations
  `);
  return result.rows[0];
}
