const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const databaseUrl = process.env.ARCHIVED_PROGRESS_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('archived progress bulk local PostgreSQL integration (set ARCHIVED_PROGRESS_TEST_DATABASE_URL to run)', { skip: 'isolated local PostgreSQL URL not provided' }, () => {});
} else {
  const activeServers = [];
  test.after(async () => {
    await Promise.all(activeServers.map((server) => new Promise((resolve) => server.close(resolve))));
  });

  test('archived progress bulk deletion is target-bound, transactional, and preserves non-gameplay data', async () => {
    assert.match(databaseUrl, /^postgres(?:ql)?:\/\/[^/]+\/tq_archived_progress_test_[a-z0-9_]+$/i, 'integration DB must be an isolated tq_archived_progress_test_* database');
    process.env.DATABASE_URL = databaseUrl;
    process.env.AI_RUNTIME_ENABLED = 'false';
    const bootstrapPool = new Pool({ connectionString: databaseUrl });
    await bootstrapPool.query(`CREATE TABLE IF NOT EXISTS public.accounts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      password TEXT,
      role VARCHAR(50) NOT NULL
    )`);
    await bootstrapPool.end();
    const { app, schemaReady } = require('./server');
    const pool = require('./database/db');
    await schemaReady;

    const migrationSql = fs.readFileSync(path.join(__dirname, 'migrations', '019_playtime_history_removal.sql'), 'utf8');
    const runMigration = async () => {
      for (const statement of migrationSql.split(';').map((part) => part.trim()).filter(Boolean)) await pool.query(`${statement};`);
    };
    await runMigration();
    await runMigration();

    await pool.query('TRUNCATE public.admin_audit_logs, public.activity_logs, public.playtime_sessions, public.student_ai_insights, public.game_results, public.student_game_progress, public.teacher_student_relationships, public.accounts RESTART IDENTITY CASCADE');
    await pool.query(`INSERT INTO public.accounts (id, name, email, password, role, parent_id, game_student_id, grade_level, section, is_archived, current_learning_cycle_version)
      VALUES (1, 'Local Admin', 'bulk-admin@example.test', 'unused', 'admin', NULL, NULL, NULL, NULL, false, 0),
             (2, 'Local Parent', 'bulk-parent@example.test', 'unused', 'parent', '900001', NULL, NULL, NULL, false, 0),
             (3, 'Local Teacher', 'bulk-teacher@example.test', 'unused', 'teacher', NULL, NULL, NULL, NULL, false, 0)`);

    const archivedStudentIds = [];
    for (let index = 1; index <= 17; index += 1) {
      const id = 100 + index;
      archivedStudentIds.push(id);
      await pool.query(
        `INSERT INTO public.accounts (id, name, email, password, role, game_student_id, grade_level, section, is_archived, current_learning_cycle_version, progress_archived_at)
         VALUES ($1, $2, $3, 'unused', 'student', $4, 'Grade 3', 'Oak', false, 2, CURRENT_TIMESTAMP - INTERVAL '1 day')`,
        [id, `Bulk Student ${String(index).padStart(2, '0')}`, `bulk-student-${index}@example.test`, String(index).padStart(8, '0')]
      );
      await pool.query(
        `INSERT INTO public.student_game_progress (student_id, student_name, grade_level, section, current_quest, score, correct_answers, total_questions, accuracy_rate, progress_percentage, current_scene, current_map, difficulty_level)
         VALUES ($1, $2, 'Grade 3', 'Oak', 'Oakleaf', 8, 8, 10, 80, 75, 'oak_scene', 'Oakleaf', 'Easy')`,
        [id, `Bulk Student ${String(index).padStart(2, '0')}`]
      );
      await pool.query(
        `INSERT INTO public.game_results (parent_id, student_name, resolved_student_id, grade_level, difficulty, math_topic, score, total_items, percentage, is_unlinked)
         VALUES ('900001', $1, $2, 'Grade 3', 'Easy', 'Fractions', 8, 10, 80, false)`,
        [`Bulk Student ${String(index).padStart(2, '0')}`, id]
      );
      await pool.query(
        `INSERT INTO public.student_ai_insights (student_id, input_fingerprint, insight, generated_by)
         VALUES ($1, $2, $3::jsonb, 1)`,
        [id, `fingerprint-${index}`, JSON.stringify({ summary: 'local test insight' })]
      );
    }
    await pool.query(`INSERT INTO public.teacher_student_relationships (teacher_id, student_id, relationship_type) VALUES (2, $1, 'Parent')`, [archivedStudentIds[0]]);
    await pool.query(`INSERT INTO public.playtime_sessions (student_id, parent_id, student_name, status, total_playtime_minutes, total_playtime_seconds, date_played) VALUES ($1, '900001', 'Bulk Student 01', 'Completed', 18, 1080, CURRENT_DATE)`, [archivedStudentIds[0]]);
    await pool.query(`INSERT INTO public.activity_logs (student_id, student_name, activity_description, role, status) VALUES ($1, 'Bulk Student 01', 'historical local activity', 'admin', 'Active')`, [archivedStudentIds[0]]);

    await pool.query(`INSERT INTO public.accounts (id, name, email, password, role, game_student_id, grade_level, section, is_archived, current_learning_cycle_version, progress_archived_at) VALUES
      (300, 'Other Active Student', 'other-active@example.test', 'unused', 'student', '00000300', 'Grade 4', 'Pine', false, 1, NULL),
      (301, 'Other Archived Student', 'other-archived@example.test', 'unused', 'student', '00000301', 'Grade 4', 'Pine', false, 1, CURRENT_TIMESTAMP)`);
    await pool.query(`INSERT INTO public.student_game_progress (student_id, student_name, grade_level, section, current_quest, score, correct_answers, total_questions) VALUES (300, 'Other Active Student', 'Grade 4', 'Pine', 'Active Quest', 4, 4, 5), (301, 'Other Archived Student', 'Grade 4', 'Pine', 'Other Quest', 4, 4, 5)`);

    const appServer = await new Promise((resolve) => {
      const server = app.listen(0, () => resolve(server));
    });
    activeServers.push(appServer);
    const baseUrl = `http://127.0.0.1:${appServer.address().port}`;
    const makeToken = (userId, role) => jwt.sign({ userId, role, sessionVersion: 0 }, process.env.JWT_SECRET || 'change-this-in-production', { expiresIn: '10m' });
    const adminHeaders = { Authorization: `Bearer ${makeToken(1, 'admin')}`, 'Content-Type': 'application/json' };
    const teacherHeaders = { Authorization: `Bearer ${makeToken(3, 'teacher')}`, 'Content-Type': 'application/json' };

    const previewResponse = await fetch(`${baseUrl}/api/student-progress/bulk/permanent-delete/preview?search=Bulk%20Student` , { headers: adminHeaders });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.affected_count, 17);
    assert.equal(preview.targets.length, 17);
    assert.ok(preview.preview_token);
    assert.equal(preview.scope.search, 'Bulk Student');

    const teacherResponse = await fetch(`${baseUrl}/api/student-progress/bulk/permanent-delete/preview`, { headers: teacherHeaders });
    assert.equal(teacherResponse.status, 403);
    const badTokenResponse = await fetch(`${baseUrl}/api/student-progress/bulk/permanent-delete`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ preview_token: `${preview.preview_token}tampered`, reason: 'test', confirmation: 'DELETE' }),
    });
    assert.equal(badTokenResponse.status, 409);
    const decodedPreview = jwt.decode(preview.preview_token);
    const expiredToken = jwt.sign({ ...decodedPreview, iat: Math.floor(Date.now() / 1000) - 120, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET || 'change-this-in-production', { noTimestamp: true });
    const expiredTokenResponse = await fetch(`${baseUrl}/api/student-progress/bulk/permanent-delete`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ preview_token: expiredToken, reason: 'expired', confirmation: 'DELETE' }),
    });
    assert.equal(expiredTokenResponse.status, 409);
    const blankReasonResponse = await fetch(`${baseUrl}/api/student-progress/bulk/permanent-delete`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ preview_token: preview.preview_token, reason: '', confirmation: 'DELETE' }),
    });
    assert.equal(blankReasonResponse.status, 400);
    const wrongConfirmationResponse = await fetch(`${baseUrl}/api/student-progress/bulk/permanent-delete`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ preview_token: preview.preview_token, reason: 'test', confirmation: 'REMOVE' }),
    });
    assert.equal(wrongConfirmationResponse.status, 400);

    const finalResponse = await fetch(`${baseUrl}/api/student-progress/bulk/permanent-delete`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ preview_token: preview.preview_token, reason: 'Approved local fixture cleanup', confirmation: 'DELETE' }),
    });
    assert.equal(finalResponse.status, 200);
    const finalPayload = await finalResponse.json();
    assert.equal(finalPayload.affected_count, 17);
    const replayResponse = await fetch(`${baseUrl}/api/student-progress/bulk/permanent-delete`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ preview_token: preview.preview_token, reason: 'Replay', confirmation: 'DELETE' }),
    });
    assert.equal(replayResponse.status, 409);

    const preserved = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM public.accounts WHERE id = $1 AND role = 'student' AND progress_archived_at IS NULL) AS account_count,
      (SELECT COUNT(*)::int FROM public.teacher_student_relationships WHERE student_id = $1) AS relationship_count,
      (SELECT COUNT(*)::int FROM public.playtime_sessions WHERE student_id = $1 AND total_playtime_minutes = 18) AS playtime_count,
      (SELECT COUNT(*)::int FROM public.activity_logs WHERE student_id = $1 AND activity_description = 'historical local activity') AS activity_count,
      (SELECT COUNT(*)::int FROM public.student_game_progress WHERE student_id = $1) AS progress_count,
      (SELECT COUNT(*)::int FROM public.game_results WHERE resolved_student_id = $1) AS result_count,
      (SELECT COUNT(*)::int FROM public.student_ai_insights WHERE student_id = $1) AS insight_count`, [archivedStudentIds[0]]);
    assert.deepEqual(preserved.rows[0], { account_count: 1, relationship_count: 1, playtime_count: 1, activity_count: 1, progress_count: 0, result_count: 0, insight_count: 0 });
    const untouched = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM public.student_game_progress WHERE student_id = 300) AS active_progress,
      (SELECT COUNT(*)::int FROM public.student_game_progress WHERE student_id = 301) AS nonmatching_progress,
      (SELECT COUNT(*)::int FROM public.accounts WHERE id = 301 AND progress_archived_at IS NOT NULL) AS nonmatching_archive`);
    assert.deepEqual(untouched.rows[0], { active_progress: 1, nonmatching_progress: 1, nonmatching_archive: 1 });

    await pool.query('UPDATE public.accounts SET progress_archived_at = CURRENT_TIMESTAMP WHERE id = 301');
    const replacementPreviewResponse = await fetch(`${baseUrl}/api/student-progress/bulk/permanent-delete/preview?search=Other%20Archived`, { headers: adminHeaders });
    const replacementPreview = await replacementPreviewResponse.json();
    await pool.query('UPDATE public.accounts SET progress_archived_at = NULL WHERE id = 301');
    const conflictResponse = await fetch(`${baseUrl}/api/student-progress/bulk/permanent-delete`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ preview_token: replacementPreview.preview_token, reason: 'conflict', confirmation: 'DELETE' }),
    });
    assert.equal(conflictResponse.status, 409);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM public.student_game_progress WHERE student_id = 301')).rows[0].count, 1);

    const rollbackName = `Rollback Target ${'x'.repeat(120)}`;
    await pool.query(
      `INSERT INTO public.accounts (id, name, email, password, role, game_student_id, grade_level, section, is_archived, current_learning_cycle_version, progress_archived_at)
       VALUES (302, $1, 'rollback-target@example.test', 'unused', 'student', '00000302', 'Grade 4', 'Pine', false, 1, CURRENT_TIMESTAMP)`,
      [rollbackName]
    );
    await pool.query(
      `INSERT INTO public.student_game_progress (student_id, student_name, grade_level, section, current_quest, score, correct_answers, total_questions)
       VALUES (302, 'Rollback Target', 'Grade 4', 'Pine', 'Rollback Quest', 4, 4, 5)`
    );
    const rollbackPreviewResponse = await fetch(`${baseUrl}/api/student-progress/bulk/permanent-delete/preview?search=Rollback%20Target`, { headers: adminHeaders });
    const rollbackPreview = await rollbackPreviewResponse.json();
    assert.equal(rollbackPreview.affected_count, 1);
    await pool.query(`CREATE OR REPLACE FUNCTION public.test_archived_bulk_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'local rollback probe'; END; $$`);
    await pool.query(`CREATE TRIGGER test_archived_bulk_rollback BEFORE DELETE ON public.student_game_progress FOR EACH ROW EXECUTE FUNCTION public.test_archived_bulk_rollback()`);
    const rollbackResponse = await fetch(`${baseUrl}/api/student-progress/bulk/permanent-delete`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ preview_token: rollbackPreview.preview_token, reason: 'rollback probe', confirmation: 'DELETE' }),
    });
    assert.equal(rollbackResponse.status, 500);
    const rollbackState = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM public.student_game_progress WHERE student_id = 302) AS progress_count,
      (SELECT COUNT(*)::int FROM public.accounts WHERE id = 302 AND progress_archived_at IS NOT NULL) AS archive_count,
      (SELECT current_learning_cycle_version FROM public.accounts WHERE id = 302) AS cycle_version`);
    assert.deepEqual(rollbackState.rows[0], { progress_count: 1, archive_count: 1, cycle_version: 1 });

  });

  test('migration 019 is repeatable and preserves its soft-delete columns and index', async () => {
    process.env.DATABASE_URL = databaseUrl;
    const pool = require('./database/db');
    const migrationSql = fs.readFileSync(path.join(__dirname, 'migrations', '019_playtime_history_removal.sql'), 'utf8');
    await pool.query(`BEGIN; ${migrationSql} COMMIT;`);
    await pool.query(`BEGIN; ${migrationSql} COMMIT;`);
    const columns = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'playtime_sessions' AND column_name IN ('deleted_at', 'deleted_by', 'deletion_reason', 'deletion_operation_id') ORDER BY column_name`);
    assert.deepEqual(columns.rows.map((row) => row.column_name), ['deleted_at', 'deleted_by', 'deletion_operation_id', 'deletion_reason']);
    const index = await pool.query(`SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_playtime_sessions_visible_history'`);
    assert.equal(index.rowCount, 1);
    await pool.query('BEGIN');
    await pool.query('ALTER TABLE public.playtime_sessions ADD COLUMN IF NOT EXISTS local_rollback_probe INTEGER');
    await pool.query('ROLLBACK');
    const rollbackProbe = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'playtime_sessions' AND column_name = 'local_rollback_probe'`);
    assert.equal(rollbackProbe.rowCount, 0);
    await pool.end();
  });
}
