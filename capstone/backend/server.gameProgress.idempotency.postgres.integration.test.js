const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Client, Pool } = require('pg');
const { RELEASE_MIGRATIONS, applyReleaseMigrations, runReleaseMigrations } = require('./releaseMigrations');
const { buildProgressActivityEventKey, hashSaveCommitId } = require('./gameProgressSaveCommit.utils');
const { assertDisposablePostgresUrl, assertDisposablePostgresDatabase } = require('./testSafety/disposablePostgres');

const databaseUrl = process.env.DATABASE_URL || '';
if (!databaseUrl) {
  test('game progress idempotency PostgreSQL integration', {
    skip: 'DATABASE_URL is required for the run-marked disposable PostgreSQL integration test',
  }, () => {});
} else {
  assertDisposablePostgresUrl({ connectionString: databaseUrl, expectedDatabaseName: 'tq_backend_test_ci' });
  const parentCode = '930001';
  const otherParentCode = '930002';
  const studentCode = '24000011';
  const secondStudentCode = '24000012';
  const studentName = 'CI Save Commit Student';
  const secondStudentName = 'CI Second Save Commit Student';
  const migrationFixtureDescription = 'synthetic pre-026 progress fixture';
  let pool;
  let serverExports;
  let appServer;
  let baseUrl;
  let parentId;
  let otherParentId;
  let studentId;
  let secondStudentId;
  let migrationFixture;
  const releaseApprovalEnvironmentKeys = [
    'RELEASE_MIGRATIONS_APPROVED',
    'RELEASE_APPROVAL_REFERENCE',
    'RELEASE_EXPECTED_DATABASE',
    'RELEASE_EXPECTED_DB_USER',
    'RELEASE_EXPECTED_SERVER_ADDRESS',
    'RELEASE_EXPECTED_SERVER_PORT',
    'RELEASE_EXPECTED_PENDING_MIGRATIONS',
    'RELEASE_MIGRATION_024_APPROVED',
    'RELEASE_MIGRATION_024_CASCADE_REVIEWED',
    'RELEASE_MIGRATION_024_WRITES_QUIESCED',
    'RELEASE_EXPECTED_024_ACCOUNT_COUNT',
    'RELEASE_EXPECTED_024_GAME_RESULTS_COUNT',
    'RELEASE_EXPECTED_024_PLAYTIME_SESSIONS_COUNT',
  ];
  const originalReleaseApprovalEnvironment = new Map(
    releaseApprovalEnvironmentKeys.map((key) => [key, process.env[key]]),
  );

  const setReleaseMigrationApproval = async (client, { migration024Counts } = {}) => {
    const identityResult = await client.query(`
      SELECT current_database() AS database_name,
             current_user AS database_user,
             inet_server_addr()::text AS server_address,
             inet_server_port() AS server_port`);
    const identity = identityResult.rows[0];
    assert.ok(identity?.server_address, 'disposable PostgreSQL must use a TCP connection for target verification');

    const ledgerResult = await client.query(
      'SELECT version FROM public.schema_migrations WHERE version = ANY($1::integer[])',
      [RELEASE_MIGRATIONS.map(({ version }) => version)],
    );
    const appliedVersions = new Set(ledgerResult.rows.map(({ version }) => Number(version)));
    const pendingVersions = RELEASE_MIGRATIONS
      .filter(({ version }) => !appliedVersions.has(version))
      .map(({ version }) => version);

    const approvalValues = {
      RELEASE_MIGRATIONS_APPROVED: 'true',
      RELEASE_APPROVAL_REFERENCE: 'CI:synthetic-save-commit-test',
      RELEASE_EXPECTED_DATABASE: identity.database_name,
      RELEASE_EXPECTED_DB_USER: identity.database_user,
      RELEASE_EXPECTED_SERVER_ADDRESS: identity.server_address,
      RELEASE_EXPECTED_SERVER_PORT: String(identity.server_port),
      RELEASE_EXPECTED_PENDING_MIGRATIONS: pendingVersions.length ? pendingVersions.join(',') : 'none',
    };
    if (pendingVersions.includes(24)) {
      approvalValues.RELEASE_MIGRATION_024_APPROVED = 'true';
      approvalValues.RELEASE_MIGRATION_024_CASCADE_REVIEWED = 'true';
      approvalValues.RELEASE_MIGRATION_024_WRITES_QUIESCED = 'true';
      approvalValues.RELEASE_EXPECTED_024_ACCOUNT_COUNT = String(migration024Counts?.accounts ?? 1);
      approvalValues.RELEASE_EXPECTED_024_GAME_RESULTS_COUNT = String(migration024Counts?.gameResults ?? 0);
      approvalValues.RELEASE_EXPECTED_024_PLAYTIME_SESSIONS_COUNT = String(migration024Counts?.playtimeSessions ?? 0);
    } else {
      for (const key of releaseApprovalEnvironmentKeys.slice(7)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(approvalValues)) process.env[key] = value;
    return pendingVersions;
  };

  const requestJson = async (body) => {
    const response = await fetch(`${baseUrl}/api/game/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const progressPayload = (commitId, overrides = {}) => ({
    parent_id: parentCode,
    student_name: studentName,
    student_id: studentCode,
    save_commit_id: commitId,
    learning_cycle_version: 0,
    current_quest: 'Oakleaf Village',
    quest_progress: 25,
    lesson_progress: 25,
    score: 2,
    correct_answers: 2,
    total_questions: 5,
    total_play_time: 60,
    current_scene: 'OakleafVillage',
    current_map: 'oakleaf_village',
    difficulty_level: 'Easy',
    activity_description: 'Synthetic database integration save',
    timestamp: '2026-11-01T00:00:00.000Z',
    ...overrides,
  });

  const eventKeyFor = (commitId, cycleVersion, hash = hashSaveCommitId(commitId)) =>
    buildProgressActivityEventKey(cycleVersion, hash);

  const rowCountsFor = async (targetStudentId, commitId, cycleVersion) => {
    const eventKey = eventKeyFor(commitId, cycleVersion);
    const [receipt, activity] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::INTEGER AS count
         FROM public.game_progress_save_commits
         WHERE student_id = $1 AND learning_cycle_version = $2 AND save_commit_id_hash = $3`,
        [targetStudentId, cycleVersion, hashSaveCommitId(commitId)],
      ),
      pool.query(
        `SELECT COUNT(*)::INTEGER AS count
         FROM public.activity_logs WHERE student_id = $1 AND event_key = $2`,
        [targetStudentId, eventKey],
      ),
    ]);
    return { receipts: receipt.rows[0].count, activities: activity.rows[0].count };
  };

  const startCurrentSession = async () => {
    const response = await fetch(`${baseUrl}/api/playtime/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parent_id: parentCode,
        student_id: studentCode,
        student_name: studentName,
      }),
    });
    return { status: response.status, body: await response.json() };
  };

  test.before(async () => {
    const bootstrap = new Pool({ connectionString: databaseUrl });
    try {
      await assertDisposablePostgresDatabase({ client: bootstrap, connectionString: databaseUrl, expectedDatabaseName: 'tq_backend_test_ci' });
      await bootstrap.query(`CREATE TABLE IF NOT EXISTS public.accounts (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT, password TEXT,
        role VARCHAR(50) NOT NULL, status VARCHAR(50) DEFAULT 'active'
      )`);
    } finally {
      await bootstrap.end();
    }

    serverExports = require('./server');
    pool = require('./database/db');
    await serverExports.schemaReady;
    await assertDisposablePostgresDatabase({ client: pool, connectionString: databaseUrl, expectedDatabaseName: 'tq_backend_test_ci' });

    const activityIdempotencyMigration = await fs.readFile(
      path.join(__dirname, 'migrations', '012_add_activity_log_event_idempotency.sql'),
      'utf8',
    );
    await pool.query(activityIdempotencyMigration);
    await assertDisposablePostgresDatabase({ client: pool, connectionString: databaseUrl, expectedDatabaseName: 'tq_backend_test_ci' });
    await pool.query('TRUNCATE public.accounts RESTART IDENTITY CASCADE');

    const priorReleaseMigrations = RELEASE_MIGRATIONS.filter(({ version }) => version < 24);
    const migrationClient = new Client({ connectionString: databaseUrl });
    await migrationClient.connect();
    try {
      await assertDisposablePostgresDatabase({ client: migrationClient, connectionString: databaseUrl, expectedDatabaseName: 'tq_backend_test_ci' });
      await applyReleaseMigrations({ client: migrationClient, migrations: priorReleaseMigrations });
    } finally {
      await migrationClient.end();
    }

    const parentResult = await pool.query(`
      INSERT INTO public.accounts (name, email, password, role, status, is_archived, session_version, parent_id)
      VALUES ('Synthetic CI Parent', 'parent-930001@example.test', 'unused', 'parent', 'active', false, 0, $1)
      RETURNING id`, [parentCode]);
    parentId = Number(parentResult.rows[0].id);
    const otherParentResult = await pool.query(`
      INSERT INTO public.accounts (name, email, password, role, status, is_archived, session_version, parent_id)
      VALUES ('Synthetic Other Parent', 'parent-930002@example.test', 'unused', 'parent', 'active', false, 0, $1)
      RETURNING id`, [otherParentCode]);
    otherParentId = Number(otherParentResult.rows[0].id);
    const studentResult = await pool.query(`
      INSERT INTO public.accounts
        (name, email, password, role, status, is_archived, session_version, game_student_id,
         grade_level, section, current_learning_cycle_version, current_learning_cycle_started_at)
      VALUES ($1, 'student-24000011@example.test', 'unused', 'student', 'active', false, 0,
              $2, 'Grade 1', 'Section A', 0, NOW() - INTERVAL '1 minute')
      RETURNING id`, [studentName, studentCode]);
    studentId = Number(studentResult.rows[0].id);
    const secondStudentResult = await pool.query(`
      INSERT INTO public.accounts
        (name, email, password, role, status, is_archived, session_version, game_student_id,
         grade_level, section, current_learning_cycle_version, current_learning_cycle_started_at)
      VALUES ($1, 'student-24000012@example.test', 'unused', 'student', 'active', false, 0,
              $2, 'Grade 1', 'Section A', 0, NOW() - INTERVAL '1 minute')
      RETURNING id`, [secondStudentName, secondStudentCode]);
    secondStudentId = Number(secondStudentResult.rows[0].id);
    await pool.query(`
      INSERT INTO public.teacher_student_relationships (teacher_id, student_id, relationship_type)
      VALUES ($1, $2, 'Parent'), ($1, $3, 'Parent')`, [parentId, studentId, secondStudentId]);

    const progressResult = await pool.query(`
      INSERT INTO public.student_game_progress
        (student_id, student_name, score, correct_answers, total_questions, accuracy_rate,
         progress_percentage, lesson_progress, total_quests_completed, total_play_time,
         current_quest, updated_at, created_at)
      VALUES ($1, $2, 1, 1, 2, 50, 10, 10, 0, 15, 'Pre-migration quest',
              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      RETURNING id, student_id, score, current_quest, updated_at`, [studentId, studentName]);
    const activityResult = await pool.query(`
      INSERT INTO public.activity_logs
        (student_id, student_name, activity_description, save_status, event_key, created_at)
      VALUES ($1, $2, $3, 'saved', 'pre-026-fixture-event', '2026-01-01T00:00:00Z')
      RETURNING id, student_id, activity_description, event_key, created_at`,
    [studentId, studentName, migrationFixtureDescription]);
    migrationFixture = {
      progress: progressResult.rows[0],
      activity: activityResult.rows[0],
    };

    await assertDisposablePostgresDatabase({ client: pool, connectionString: databaseUrl, expectedDatabaseName: 'tq_backend_test_ci' });
    const legacyCandidate = await pool.query(`
      INSERT INTO public.accounts (name, email, password, role, status, is_archived, session_version, game_student_id)
      VALUES ('Synthetic legacy migration candidate', 'legacy-240001@example.test', 'unused', 'student', 'active', false, 0, '240001')
      RETURNING id`);
    const legacyCandidateId = Number(legacyCandidate.rows[0].id);
    await assertDisposablePostgresDatabase({ client: pool, connectionString: databaseUrl, expectedDatabaseName: 'tq_backend_test_ci' });
    const pendingBeforeApply = await setReleaseMigrationApproval(pool, {
      migration024Counts: { accounts: 0, gameResults: 0, playtimeSessions: 0 },
    });
    assert.deepEqual(pendingBeforeApply, [24, 25, 26]);

    delete process.env.RELEASE_MIGRATIONS_APPROVED;
    await assert.rejects(runReleaseMigrations(), /set RELEASE_MIGRATIONS_APPROVED=true/);

    await setReleaseMigrationApproval(pool, {
      migration024Counts: { accounts: 0, gameResults: 0, playtimeSessions: 0 },
    });
    process.env.RELEASE_EXPECTED_DATABASE = 'unexpected-disposable-database';
    await assert.rejects(runReleaseMigrations(), /connected database identity does not match/);

    await setReleaseMigrationApproval(pool, {
      migration024Counts: { accounts: 0, gameResults: 0, playtimeSessions: 0 },
    });
    process.env.RELEASE_EXPECTED_PENDING_MIGRATIONS = '26';
    delete process.env.RELEASE_MIGRATION_024_APPROVED;
    await assert.rejects(runReleaseMigrations(), /pending migration list changed/);

    await setReleaseMigrationApproval(pool, {
      migration024Counts: { accounts: 0, gameResults: 0, playtimeSessions: 0 },
    });
    await assert.rejects(runReleaseMigrations(), /migration 024 counts changed/);
    const candidateAfterRejectedCount = await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM public.accounts WHERE id = $1', [legacyCandidateId]);
    assert.equal(candidateAfterRejectedCount.rows[0].count, 1, 'migration 024 count mismatch must leave the synthetic candidate untouched');
    const migrationRowsAfterRejectedGate = await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM public.schema_migrations WHERE version >= 24');
    assert.equal(migrationRowsAfterRejectedGate.rows[0].count, 0, 'a rejected gate must not record or apply pending migrations');

    const approvedPendingVersions = await setReleaseMigrationApproval(pool, {
      migration024Counts: { accounts: 1, gameResults: 0, playtimeSessions: 0 },
    });
    assert.deepEqual(approvedPendingVersions, [24, 25, 26]);
    const approvedMigrationResult = await runReleaseMigrations();
    assert.deepEqual(approvedMigrationResult.appliedVersions, [24, 25, 26]);
    const candidateAfterApprovedMigration = await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM public.accounts WHERE id = $1', [legacyCandidateId]);
    assert.equal(candidateAfterApprovedMigration.rows[0].count, 0, 'approved migration 024 should remove only the synthetic legacy candidate');

    const migrationRowsAfterApprovedRun = await pool.query(
      'SELECT version FROM public.schema_migrations WHERE version >= 24 ORDER BY version');
    assert.deepEqual(migrationRowsAfterApprovedRun.rows.map(({ version }) => Number(version)), [24, 25, 26]);

    appServer = await new Promise((resolve) => {
      const listening = serverExports.app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${appServer.address().port}`;
  });

  test.after(async () => {
    if (appServer) await new Promise((resolve) => appServer.close(resolve));
    if (pool) {
      await assertDisposablePostgresDatabase({ client: pool, connectionString: databaseUrl, expectedDatabaseName: 'tq_backend_test_ci' });
      await pool.query('DROP TRIGGER IF EXISTS tq_test_fail_activity_insert ON public.activity_logs').catch(() => {});
      await pool.query('DROP FUNCTION IF EXISTS public.tq_test_fail_activity_insert()').catch(() => {});
      await assertDisposablePostgresDatabase({ client: pool, connectionString: databaseUrl, expectedDatabaseName: 'tq_backend_test_ci' });
      await pool.query('TRUNCATE public.accounts RESTART IDENTITY CASCADE').catch(() => {});
      await pool.end();
    }
    for (const [key, value] of originalReleaseApprovalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('release migration 026 applies and re-runs safely without changing pre-existing progress or activity rows', async () => {
    const before = await pool.query(`
      SELECT version, filename, checksum FROM public.schema_migrations WHERE version = 26`);
    assert.equal(before.rows.length, 1);
    assert.equal(before.rows[0].filename, '026_game_progress_save_commit_idempotency.sql');
    assert.match(before.rows[0].checksum, /^[0-9a-f]{64}$/);

    const constraints = await pool.query(`
      SELECT conname, contype, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'public.game_progress_save_commits'::regclass`);
    const definitions = new Map(constraints.rows.map((row) => [row.conname, row.definition]));
    assert.match(definitions.get('game_progress_save_commits_pkey'), /PRIMARY KEY \(student_id, learning_cycle_version, save_commit_id_hash\)/i);
    assert.match(definitions.get('game_progress_save_commits_student_id_fkey'), /FOREIGN KEY \(student_id\) REFERENCES accounts\(id\) ON DELETE CASCADE/i);
    assert.match(definitions.get('game_progress_save_commits_activity_event_unique'), /UNIQUE \(student_id, activity_event_key\)/i);

    const indexes = await pool.query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'game_progress_save_commits'
      ORDER BY indexname`);
    assert.ok(indexes.rows.some((row) => row.indexname === 'game_progress_save_commits_pkey'));
    assert.ok(indexes.rows.some((row) => row.indexname === 'game_progress_save_commits_activity_event_unique'));

    await assertDisposablePostgresDatabase({ client: pool, connectionString: databaseUrl, expectedDatabaseName: 'tq_backend_test_ci' });
    const pendingBeforeNoOp = await setReleaseMigrationApproval(pool);
    assert.deepEqual(pendingBeforeNoOp, []);
    await runReleaseMigrations();
    const after = await pool.query(`
      SELECT version, filename, checksum FROM public.schema_migrations WHERE version = 26`);
    assert.deepEqual(after.rows, before.rows, 'a second real runner execution is a checksum-verified no-op');

    const [progress, activity] = await Promise.all([
      pool.query(`SELECT id, student_id, score, current_quest, updated_at
                  FROM public.student_game_progress WHERE id = $1`, [migrationFixture.progress.id]),
      pool.query(`SELECT id, student_id, activity_description, event_key, created_at
                  FROM public.activity_logs WHERE id = $1`, [migrationFixture.activity.id]),
    ]);
    assert.deepEqual(progress.rows[0], migrationFixture.progress);
    assert.deepEqual(activity.rows[0], migrationFixture.activity);
  });

  test('first database-backed save and identical retry return one stored response and one activity', async () => {
    const body = progressPayload('db:identical-retry');
    const first = await requestJson(body);
    assert.equal(first.status, 201);
    assert.deepEqual(Object.keys(first.body).sort(), ['activity_log_id', 'progress_id', 'success']);
    assert.equal(first.body.success, true);
    assert.ok(Number.isInteger(first.body.progress_id));
    assert.ok(Number.isInteger(first.body.activity_log_id));
    const firstProgress = await pool.query(
      'SELECT id, score, updated_at FROM public.student_game_progress WHERE student_id = $1', [studentId]);
    const countsAfterFirst = await rowCountsFor(studentId, body.save_commit_id, 0);
    assert.deepEqual(countsAfterFirst, { receipts: 1, activities: 1 });

    const retry = await requestJson(body);
    assert.equal(retry.status, 201);
    assert.deepEqual(retry.body, first.body);
    const progressAfterRetry = await pool.query(
      'SELECT id, score, updated_at FROM public.student_game_progress WHERE student_id = $1', [studentId]);
    assert.deepEqual(progressAfterRetry.rows, firstProgress.rows, 'matching retry does not rewrite progress');
    assert.deepEqual(await rowCountsFor(studentId, body.save_commit_id, 0), countsAfterFirst);
  });

  test('changed payload is rejected and an unlinked parent cannot retrieve a cached response', async () => {
    const original = progressPayload('db:payload-conflict');
    assert.equal((await requestJson(original)).status, 201);
    const changed = await requestJson({ ...original, score: original.score + 1 });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, 'SAVE_COMMIT_ID_REUSED');
    assert.deepEqual(await rowCountsFor(studentId, original.save_commit_id, 0), { receipts: 1, activities: 1 });

    const unauthorized = await requestJson({ ...original, parent_id: otherParentCode });
    assert.equal(unauthorized.status, 403);
    assert.deepEqual(await rowCountsFor(studentId, original.save_commit_id, 0), { receipts: 1, activities: 1 });
    assert.equal(otherParentId > 0, true);
  });

  test('concurrent identical database requests serialize to one receipt and one activity', async () => {
    const body = progressPayload('db:concurrent-retry');
    const responses = await Promise.all(Array.from({ length: 5 }, () => requestJson(body)));
    assert.ok(responses.every((response) => response.status === 201));
    assert.ok(responses.every((response) => JSON.stringify(response.body) === JSON.stringify(responses[0].body)));
    assert.deepEqual(await rowCountsFor(studentId, body.save_commit_id, 0), { receipts: 1, activities: 1 });
  });

  test('concurrent conflicting payloads yield one 201 and one 409 with no partial transaction state', async () => {
    const commitId = 'db:concurrent-conflict-payload';
    const payloadA = progressPayload(commitId, {
      score: 4,
      current_quest: 'Concurrent accepted quest A',
      activity_description: 'Concurrent accepted activity A',
    });
    const payloadB = progressPayload(commitId, {
      score: 9,
      current_quest: 'Concurrent conflicting quest B',
      activity_description: 'Concurrent conflicting activity B',
    });
    const beforeProgress = await pool.query(
      `SELECT id, score, current_quest, updated_at
       FROM public.student_game_progress
       WHERE student_id = $1 AND current_quest IN ($2, $3)`,
      [studentId, payloadA.current_quest, payloadB.current_quest],
    );
    assert.equal(beforeProgress.rowCount, 0, 'unique concurrent fixture quests are absent before the requests');
    const responses = await Promise.all([requestJson(payloadA), requestJson(payloadB)]);
    assert.deepEqual(responses.map(({ status }) => status).sort((a, b) => a - b), [201, 409]);
    const successIndex = responses.findIndex(({ status }) => status === 201);
    const success = responses[successIndex];
    const conflict = responses[1 - successIndex];
    const accepted = successIndex === 0 ? payloadA : payloadB;
    assert.equal(conflict.body.code, 'SAVE_COMMIT_ID_REUSED');

    assert.deepEqual(await rowCountsFor(studentId, commitId, 0), { receipts: 1, activities: 1 });
    const receipt = await pool.query(
      `SELECT response_status, response_body
       FROM public.game_progress_save_commits
       WHERE student_id = $1 AND learning_cycle_version = 0 AND save_commit_id_hash = $2`,
      [studentId, hashSaveCommitId(commitId)],
    );
    assert.equal(receipt.rowCount, 1);
    assert.equal(receipt.rows[0].response_status, 201);
    assert.deepEqual(receipt.rows[0].response_body, success.body);

    const committedProgress = await pool.query(
      `SELECT id, score, current_quest, updated_at
       FROM public.student_game_progress
       WHERE student_id = $1 AND current_quest IN ($2, $3)`,
      [studentId, payloadA.current_quest, payloadB.current_quest],
    );
    assert.equal(committedProgress.rowCount, 1, 'the conflicting request did not create or update a second progress row');
    assert.equal(Number(committedProgress.rows[0].score), accepted.score);
    assert.equal(committedProgress.rows[0].current_quest, accepted.current_quest);
    assert.notDeepEqual(committedProgress.rows, beforeProgress.rows, 'only the successful request updated progress');

    const committedActivity = await pool.query(
      `SELECT activity_description FROM public.activity_logs
       WHERE student_id = $1 AND event_key = $2`,
      [studentId, eventKeyFor(commitId, 0)],
    );
    assert.deepEqual(committedActivity.rows, [{ activity_description: accepted.activity_description }]);
  });

  test('distinct IDs with identical progress create distinct activities, and IDs are isolated by student', async () => {
    const sharedPayload = { score: 3, correct_answers: 3, total_questions: 5 };
    const first = progressPayload('db:distinct-a', sharedPayload);
    const second = progressPayload('db:distinct-b', sharedPayload);
    assert.equal((await requestJson(first)).status, 201);
    assert.equal((await requestJson(second)).status, 201);
    assert.deepEqual(await rowCountsFor(studentId, first.save_commit_id, 0), { receipts: 1, activities: 1 });
    assert.deepEqual(await rowCountsFor(studentId, second.save_commit_id, 0), { receipts: 1, activities: 1 });

    const otherStudentBody = progressPayload('db:cross-student', {
      student_id: secondStudentCode,
      student_name: secondStudentName,
    });
    const primaryStudentBody = progressPayload('db:cross-student');
    assert.equal((await requestJson(primaryStudentBody)).status, 201);
    assert.equal((await requestJson(otherStudentBody)).status, 201);
    assert.deepEqual(await rowCountsFor(studentId, 'db:cross-student', 0), { receipts: 1, activities: 1 });
    assert.deepEqual(await rowCountsFor(secondStudentId, 'db:cross-student', 0), { receipts: 1, activities: 1 });

    const beforeDelete = await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM public.game_progress_save_commits WHERE student_id = $1',
      [secondStudentId],
    );
    assert.ok(beforeDelete.rows[0].count > 0);
    await assertDisposablePostgresDatabase({ client: pool, connectionString: databaseUrl, expectedDatabaseName: 'tq_backend_test_ci' });
    await pool.query('DELETE FROM public.accounts WHERE id = $1', [secondStudentId]);
    const afterDelete = await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM public.game_progress_save_commits WHERE student_id = $1',
      [secondStudentId],
    );
    assert.equal(afterDelete.rows[0].count, 0, 'account deletion cascades to receipts without orphans');
  });

  test('lost-response retry is idempotent; learning-cycle changes reject stale replay but permit the same ID in the new cycle', async () => {
    const firstBody = progressPayload('db:cycle-scoped');
    const originalJson = serverExports.app.response.json;
    serverExports.app.response.json = function dropPostCommitResponse(body, ...args) {
      if (this.req.originalUrl === '/api/game/progress'
        && this.req.body?.save_commit_id === firstBody.save_commit_id
        && this.statusCode === 201) {
        // This method is reached only after the route's PostgreSQL COMMIT.
        // Closing here gives the real HTTP client no success status or body.
        this.destroy();
        return this;
      }
      return originalJson.call(this, body, ...args);
    };
    try {
      await assert.rejects(fetch(`${baseUrl}/api/game/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(firstBody),
      }));
    } finally {
      serverExports.app.response.json = originalJson;
    }
    assert.deepEqual(await rowCountsFor(studentId, firstBody.save_commit_id, 0), { receipts: 1, activities: 1 });
    const retry = await requestJson(firstBody);
    assert.equal(retry.status, 201);
    assert.deepEqual(await rowCountsFor(studentId, 'db:cycle-scoped', 0), { receipts: 1, activities: 1 });

    await pool.query(`
      UPDATE public.accounts
      SET current_learning_cycle_version = 1, current_learning_cycle_started_at = NOW()
      WHERE id = $1`, [studentId]);
    const staleReplay = await requestJson(firstBody);
    assert.equal(staleReplay.status, 409);
    assert.equal(staleReplay.body.code, 'LEARNING_CYCLE_CHANGED');
    assert.deepEqual(await rowCountsFor(studentId, 'db:cycle-scoped', 0), { receipts: 1, activities: 1 });

    const session = await startCurrentSession();
    assert.equal(session.status, 201);
    const cycleOneBody = progressPayload('db:cycle-scoped', {
      learning_cycle_version: 1,
      playtime_session_id: session.body.session_id,
      playtime_session_credential: session.body.session_credential,
    });
    const cycleOneSave = await requestJson(cycleOneBody);
    assert.equal(cycleOneSave.status, 201);
    assert.deepEqual(await rowCountsFor(studentId, 'db:cycle-scoped', 1), { receipts: 1, activities: 1 });

    const legacyBody = { ...cycleOneBody };
    delete legacyBody.save_commit_id;
    const legacyResponse = await requestJson(legacyBody);
    assert.equal(legacyResponse.status, 201);
    assert.ok(legacyResponse.body.parent);
    assert.ok(legacyResponse.body.student);
    assert.ok(legacyResponse.body.progress);
    assert.ok(legacyResponse.body.activityLog);

    await pool.query(`
      UPDATE public.playtime_sessions
      SET expires_at = NOW() - INTERVAL '1 minute'
      WHERE id = $1`, [session.body.session_id]);
    const expiredBody = progressPayload('db:expired-session', {
      learning_cycle_version: 1,
      playtime_session_id: session.body.session_id,
      playtime_session_credential: session.body.session_credential,
    });
    const expired = await requestJson(expiredBody);
    assert.equal(expired.status, 403);
    assert.deepEqual(await rowCountsFor(studentId, expiredBody.save_commit_id, 1), { receipts: 0, activities: 0 });
  });

  test('failed activity insertion rolls back the actual receipt and progress transaction', async () => {
    const session = await startCurrentSession();
    assert.equal(session.status, 201);
    const before = await pool.query(
      'SELECT id, score, updated_at FROM public.student_game_progress WHERE student_id = $1', [studentId]);
    await pool.query(`
      CREATE OR REPLACE FUNCTION public.tq_test_fail_activity_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.activity_description = 'tq-test-force-activity-failure' THEN
          RAISE EXCEPTION 'synthetic idempotency integration failure';
        END IF;
        RETURN NEW;
      END;
      $$`);
    await pool.query(`
      CREATE TRIGGER tq_test_fail_activity_insert
      BEFORE INSERT ON public.activity_logs
      FOR EACH ROW EXECUTE FUNCTION public.tq_test_fail_activity_insert()`);

    try {
      const body = progressPayload('db:rollback', {
        learning_cycle_version: 1,
        playtime_session_id: session.body.session_id,
        playtime_session_credential: session.body.session_credential,
        score: 99,
        activity_description: 'tq-test-force-activity-failure',
      });
      const failed = await requestJson(body);
      assert.equal(failed.status, 500);
      assert.deepEqual(await rowCountsFor(studentId, body.save_commit_id, 1), { receipts: 0, activities: 0 });
      const after = await pool.query(
        'SELECT id, score, updated_at FROM public.student_game_progress WHERE student_id = $1', [studentId]);
      assert.deepEqual(after.rows, before.rows, 'the attempted progress update rolled back with the receipt');
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS tq_test_fail_activity_insert ON public.activity_logs');
      await pool.query('DROP FUNCTION IF EXISTS public.tq_test_fail_activity_insert()');
    }
  });
}
