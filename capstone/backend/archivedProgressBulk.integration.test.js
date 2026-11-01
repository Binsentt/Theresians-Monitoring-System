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

  test('retired progress-only archive and deletion endpoints preserve Student data', async () => {
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

    const teacherClassAssignmentsMigration = fs.readFileSync(
      path.join(__dirname, 'migrations', '008_add_teacher_class_assignments.sql'),
      'utf8',
    );
    await pool.query(teacherClassAssignmentsMigration);

    const migrationSql = fs.readFileSync(path.join(__dirname, 'migrations', '019_playtime_history_removal.sql'), 'utf8');
    const runMigration = async () => {
      for (const statement of migrationSql.split(';').map((part) => part.trim()).filter(Boolean)) await pool.query(`${statement};`);
    };
    await runMigration();
    await runMigration();

    await pool.query('TRUNCATE public.admin_audit_logs, public.activity_logs, public.playtime_sessions, public.student_ai_insights, public.game_results, public.student_game_progress, public.teacher_student_relationships, public.accounts RESTART IDENTITY CASCADE');
    await pool.query(`INSERT INTO public.accounts (id, name, email, password, role, parent_id, game_student_id, grade_level, section, is_archived, current_learning_cycle_version, progress_archived_at)
      VALUES (1, 'Local Admin', 'bulk-admin@example.test', 'unused', 'admin', NULL, NULL, NULL, NULL, false, 0, NULL),
             (2, 'Local Parent', 'bulk-parent@example.test', 'unused', 'parent', '900001', NULL, NULL, NULL, false, 0, NULL),
             (3, 'Local Teacher', 'bulk-teacher@example.test', 'unused', 'teacher', NULL, NULL, NULL, NULL, false, 0, NULL),
             (101, 'Bulk Student', 'bulk-student@example.test', 'unused', 'student', NULL, '00000101', 'Grade 3', 'Oak', false, 2, CURRENT_TIMESTAMP - INTERVAL '1 day')`);
    await pool.query(`INSERT INTO public.student_game_progress (student_id, student_name, grade_level, section, current_quest, score, correct_answers, total_questions, accuracy_rate, progress_percentage, current_scene, current_map, difficulty_level)
      VALUES (101, 'Bulk Student', 'Grade 3', 'Oak', 'Oakleaf', 8, 8, 10, 80, 75, 'oak_scene', 'Oakleaf', 'Easy')`);
    await pool.query(`INSERT INTO public.game_results (parent_id, student_name, resolved_student_id, grade_level, difficulty, math_topic, score, total_items, percentage, is_unlinked)
      VALUES ('900001', 'Bulk Student', 101, 'Grade 3', 'Easy', 'Fractions', 8, 10, 80, false)`);
    await pool.query(`INSERT INTO public.student_ai_insights (student_id, input_fingerprint, insight, generated_by)
      VALUES (101, 'bulk-test-fingerprint', '{"summary":"synthetic test insight"}'::jsonb, 1)`);
    await pool.query(`INSERT INTO public.teacher_student_relationships (teacher_id, student_id, relationship_type) VALUES (2, 101, 'Parent')`);
    await pool.query(`INSERT INTO public.playtime_sessions (student_id, parent_id, student_name, status, total_playtime_minutes, total_playtime_seconds, date_played)
      VALUES (101, '900001', 'Bulk Student', 'Completed', 18, 1080, CURRENT_DATE)`);
    await pool.query(`INSERT INTO public.activity_logs (student_id, student_name, activity_description, role, status)
      VALUES (101, 'Bulk Student', 'historical local activity', 'admin', 'Active')`);

    const appServer = await new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
    activeServers.push(appServer);
    const baseUrl = `http://127.0.0.1:${appServer.address().port}`;
    const makeToken = (userId, role) => jwt.sign({ userId, role, sessionVersion: 0 }, process.env.JWT_SECRET || 'change-this-in-production', { expiresIn: '10m' });
    const adminHeaders = { Authorization: `Bearer ${makeToken(1, 'admin')}`, 'Content-Type': 'application/json' };
    const teacherHeaders = { Authorization: `Bearer ${makeToken(3, 'teacher')}`, 'Content-Type': 'application/json' };
    const request = (url, options = {}) => fetch(`${baseUrl}${url}`, options);
    const snapshot = async () => {
      const result = await pool.query(`SELECT
        (SELECT to_jsonb(a) FROM public.accounts a WHERE a.id = 101) AS account,
        (SELECT to_jsonb(p) FROM public.student_game_progress p WHERE p.student_id = 101) AS progress,
        (SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM public.game_results r WHERE r.resolved_student_id = 101) AS results,
        (SELECT COALESCE(jsonb_agg(to_jsonb(i)), '[]'::jsonb) FROM public.student_ai_insights i WHERE i.student_id = 101) AS insights,
        (SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM public.teacher_student_relationships r WHERE r.student_id = 101) AS relationships,
        (SELECT COALESCE(jsonb_agg(to_jsonb(p)), '[]'::jsonb) FROM public.playtime_sessions p WHERE p.student_id = 101) AS playtime,
        (SELECT COALESCE(jsonb_agg(to_jsonb(a)), '[]'::jsonb) FROM public.activity_logs a WHERE a.student_id = 101) AS activities,
        (SELECT COUNT(*)::INTEGER FROM public.admin_audit_logs) AS audit_log_count`);
      return result.rows[0];
    };

    const before = await snapshot();
    const retiredAdminRequests = [
      ['GET', '/api/student-progress/bulk/permanent-delete/preview?search=Bulk%20Student'],
      ['POST', '/api/student-progress/bulk/archive'],
      ['POST', '/api/student-progress/bulk/permanent-delete'],
      ['POST', '/api/student-progress/101/archive'],
      ['POST', '/api/student-progress/101/permanent-delete'],
    ];
    for (const [method, url] of retiredAdminRequests) {
      const response = await request(url, {
        method,
        headers: adminHeaders,
        ...(method === 'POST' ? { body: JSON.stringify({ reason: 'synthetic contract check', confirmation: 'DELETE' }) } : {}),
      });
      assert.equal(response.status, 410, `${method} ${url} must remain retired`);
    }

    const protectedTeacherRequests = [
      ['GET', '/api/student-progress/bulk/permanent-delete/preview'],
      ['POST', '/api/student-progress/bulk/permanent-delete'],
      ['POST', '/api/student-progress/101/permanent-delete'],
      ['POST', '/api/student-progress/101/archive'],
    ];
    for (const [method, url] of protectedTeacherRequests) {
      const response = await request(url, {
        method,
        headers: teacherHeaders,
        ...(method === 'POST' ? { body: JSON.stringify({ reason: 'synthetic authorization check', confirmation: 'DELETE' }) } : {}),
      });
      assert.equal(response.status, 403, `${method} ${url} must remain unavailable to this unlinked Teacher`);
    }
    assert.deepEqual(await snapshot(), before, 'retired or unauthorized progress-only routes must not mutate any Student-owned evidence');
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
