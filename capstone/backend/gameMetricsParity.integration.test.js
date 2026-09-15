const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { calculateWeightedCompletion } = require('./questGraph.utils');
const { applyReleaseMigrations } = require('./releaseMigrations');

const databaseUrl = process.env.GAME_METRICS_TEST_DATABASE_URL || '';

const isSafeDatabase = (value) => {
  try {
    const url = new URL(value);
    const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase())
      && /^tq_game_metrics_test_[a-z0-9_]+$/i.test(name);
  } catch (_error) {
    return false;
  }
};

if (!isSafeDatabase(databaseUrl)) {
  test('canonical game metrics local PostgreSQL integration', {
    skip: 'GAME_METRICS_TEST_DATABASE_URL must target a loopback tq_game_metrics_test_* database',
  }, () => {});
} else {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousAiEnabled = process.env.AI_GENERATION_ENABLED;
  process.env.DATABASE_URL = databaseUrl;
  process.env.AI_GENERATION_ENABLED = 'false';

  let appServer;
  let pool;
  let adminId;
  let studentId;
  const parentCode = '900001';
  const studentCode = '24000001';
  const studentName = 'Local Metrics Parity Student';

  const token = (id, role) => jwt.sign(
    { userId: id, role, sessionVersion: 0 },
    process.env.JWT_SECRET || 'change-this-in-production',
    { expiresIn: '10m' },
  );

  const json = async (url, options = {}) => {
    const response = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    return { status: response.status, body: await response.json() };
  };

  const assertMetrics = (entry, label, progress) => {
    assert.equal(Number(entry.game_score), 2, `${label} Game Score`);
    assert.equal(Number(entry.correct_answers), 2, `${label} correct`);
    assert.equal(Number(entry.total_questions ?? entry.total_questions_answered), 5, `${label} recorded`);
    assert.equal(Number(entry.accuracy_rate ?? entry.accuracy), 40, `${label} accuracy`);
    assert.equal(Number(entry.progress_percentage ?? entry.completion_percentage), progress, `${label} progress`);
  };

  test.before(async () => {
    const bootstrap = new Pool({ connectionString: databaseUrl });
    await bootstrap.query(`CREATE TABLE IF NOT EXISTS public.accounts (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT, password TEXT,
      role VARCHAR(50) NOT NULL, status VARCHAR(50) DEFAULT 'active'
    )`);
    await bootstrap.end();

    const { app, schemaReady } = require('./server');
    pool = require('./database/db');
    await schemaReady;
    await pool.query(fs.readFileSync(
      path.join(__dirname, 'migrations', '012_add_activity_log_event_idempotency.sql'),
      'utf8',
    ));
    await applyReleaseMigrations({ client: pool });
    await pool.query('TRUNCATE public.accounts RESTART IDENTITY CASCADE');

    const admin = await pool.query(`INSERT INTO public.accounts
      (name, email, password, role, status, is_archived, session_version)
      VALUES ('Local Metrics Admin', 'metrics-admin@example.test', 'unused',
              'admin', 'active', false, 0) RETURNING id`);
    adminId = admin.rows[0].id;
    const parent = await pool.query(`INSERT INTO public.accounts
      (name, email, password, role, status, is_archived, session_version, parent_id)
      VALUES ('Local Metrics Parent', 'metrics-parent@example.test', 'unused',
              'parent', 'active', false, 0, $1) RETURNING id`, [parentCode]);
    const student = await pool.query(`INSERT INTO public.accounts
      (name, email, password, role, status, is_archived, session_version,
       game_student_id, grade_level, section, current_learning_cycle_version,
       current_learning_cycle_started_at)
      VALUES ($1, 'metrics-student@example.test', 'unused', 'student', 'active',
              false, 0, $2, 'Grade 1', 'Section A', 0, NOW() - INTERVAL '1 minute') RETURNING id`,
    [studentName, studentCode]);
    studentId = student.rows[0].id;

    await pool.query(`INSERT INTO public.teacher_student_relationships
      (teacher_id, student_id, relationship_type) VALUES ($1, $2, 'Parent')`,
    [parent.rows[0].id, studentId]);
    await pool.query(`INSERT INTO public.student_ai_insights
      (student_id, input_fingerprint, insight, generated_by)
      VALUES ($1, $2, $3::jsonb, $4)`,
    [studentId, '0'.repeat(64), JSON.stringify({ status: 'no_data', performance_insight: 'No valid gameplay results.' }), adminId]);

    appServer = await new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
  });

  test.after(async () => {
    if (appServer) await new Promise((resolve) => appServer.close(resolve));
    if (pool) {
      await pool.query('TRUNCATE public.accounts RESTART IDENTITY CASCADE').catch(() => {});
      await pool.end();
    }
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousAiEnabled === undefined) delete process.env.AI_GENERATION_ENABLED;
    else process.env.AI_GENERATION_ENABLED = previousAiEnabled;
  });

  test('2 correct and 3 wrong stay identical across stored evidence and every consumer', async () => {
    const base = `http://127.0.0.1:${appServer.address().port}`;
    const adminHeaders = { Authorization: `Bearer ${token(adminId, 'admin')}` };
    const lease = await json(`${base}/api/playtime/start`, {
      method: 'POST',
      body: JSON.stringify({ parent_id: parentCode, student_id: studentCode, student_name: studentName }),
    });
    assert.equal(lease.status, 201);
    assert.equal(lease.body.can_play, true);
    const sessionId = Number(lease.body.session_id);
    const credential = lease.body.session_credential;

    const responseTimes = [15, 18, 42, 38, 30];
    for (const [index, score] of [1, 1, 0, 0, 0].entries()) {
      const eventId = `qa-metrics-question-${index + 1}`;
      const result = await json(`${base}/api/game/result`, {
        method: 'POST',
        body: JSON.stringify({
          parent_id: parentCode, student_id: studentCode, student_name: studentName,
          grade_level: 'Grade 1', difficulty: 'Easy', math_topic: 'Addition',
          score, total_items: 1, playtime_session_id: sessionId,
          playtime_session_credential: credential, result_event_id: eventId,
          telemetry_contract_version: '2.0', quest_graph_version: 'oakleaf-city-pinehill-v1',
          session_id: sessionId, map_id: 'oakleaf_village', canonical_quest_id: 'oakleaf',
          canonical_task_id: 'first-bandit-math-challenge', canonical_battle_id: 'bandits',
          canonical_milestone_id: `oakleaf.bandits.question_${index + 1}`,
          question_presented_at: new Date(Date.parse('2026-01-01T00:10:00.000Z') + (index * 10 * 1000)).toISOString(),
          answer_submitted_at: new Date(Date.parse('2026-01-01T00:10:00.000Z') + ((index * 10 + responseTimes[index]) * 1000)).toISOString(),
          response_time_seconds: responseTimes[index],
          ...(index === 0 ? { played_at: '2000-01-01T00:00:00.000Z' } : {}),
        }),
      });
      assert.equal(result.status, 201, `result ${index + 1}`);
      assert.equal(result.body.resolved, true);
    }

    const cacheAfterEvidence = await pool.query(
      `SELECT stale_at, xmin::TEXT AS row_version
       FROM public.student_ai_insights WHERE student_id = $1`,
      [studentId],
    );
    assert.ok(cacheAfterEvidence.rows[0].stale_at, 'new graded evidence invalidates the prior zero-result insight');
    const duplicate = await json(`${base}/api/game/result`, {
      method: 'POST',
      body: JSON.stringify({
        parent_id: parentCode, student_id: studentCode, student_name: studentName,
        grade_level: 'Grade 1', difficulty: 'Easy', math_topic: 'Addition',
        score: 1, total_items: 1, playtime_session_id: sessionId,
        playtime_session_credential: credential, result_event_id: 'qa-metrics-question-1',
        telemetry_contract_version: '2.0', quest_graph_version: 'oakleaf-city-pinehill-v1',
        session_id: sessionId, map_id: 'oakleaf_village', canonical_quest_id: 'oakleaf',
        canonical_task_id: 'first-bandit-math-challenge', canonical_battle_id: 'bandits',
        canonical_milestone_id: 'oakleaf.bandits.question_1',
      }),
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true);
    const cacheAfterDuplicate = await pool.query(
      `SELECT stale_at, xmin::TEXT AS row_version
       FROM public.student_ai_insights WHERE student_id = $1`,
      [studentId],
    );
    assert.equal(cacheAfterDuplicate.rows[0].row_version, cacheAfterEvidence.rows[0].row_version,
      'an unchanged duplicate result leaves the evidence cache row untouched');

    for (const milestone of [
      ['tutorial', 'tutorial.complete', "Go to the Teacher's House", 90],
      ['go-to-teachers-house', 'oakleaf.go-to-teachers-house.complete', 'Talk to the Teacher', 60],
    ]) {
      const [taskId, milestoneId, currentQuest, durationSeconds] = milestone;
      const activity = await json(`${base}/api/game/activity`, {
        method: 'POST',
        body: JSON.stringify({
          session_id: sessionId, session_credential: credential, learning_cycle_version: 0,
          event_type: 'task_completed', event_key: `qa-metrics-${taskId}`,
          activity_event_id: `qa-metrics-${taskId}`, task_id: taskId,
          canonical_activity_id: taskId, canonical_quest_id: 'oakleaf',
           canonical_task_id: taskId, canonical_milestone_id: milestoneId,
          current_quest: currentQuest,
          map_id: 'oakleaf_village', is_player_facing: true,
          started_at: '2026-01-01T00:00:00.000Z',
          completed_at: new Date(Date.parse('2026-01-01T00:00:00.000Z') + (durationSeconds * 1000)).toISOString(),
          duration_seconds: durationSeconds,
        }),
      });
      assert.equal(activity.status, 201, taskId);
      assert.equal(activity.body.duplicate, false);
    }
    const banditActivity = await json(`${base}/api/game/activity`, {
      method: 'POST',
      body: JSON.stringify({
        session_id: sessionId, session_credential: credential, learning_cycle_version: 0,
        event_type: 'task_completed', event_key: 'qa-metrics-bandit-duration',
        activity_event_id: 'qa-metrics-bandit-duration', task_id: 'Bandit challenge',
        canonical_activity_id: 'first-bandit-math-challenge', canonical_quest_id: 'oakleaf',
        canonical_task_id: 'first-bandit-math-challenge', canonical_milestone_id: 'oakleaf.bandits.duration',
        current_quest: 'Defeat All Bandits', map_id: 'oakleaf_village', is_player_facing: false,
        started_at: '2026-01-01T00:10:00.000Z', completed_at: '2026-01-01T00:14:00.000Z',
        duration_seconds: 240,
      }),
    });
    assert.equal(banditActivity.status, 201);

    const progress = calculateWeightedCompletion(['tutorial', 'go-to-teachers-house']);
    const leaderboard = await json(`${base}/api/game/leaderboard`, {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId, session_credential: credential, learning_cycle_version: 0 }),
    });
    assert.equal(leaderboard.status, 200);
    assert.equal(leaderboard.body.entries.length, 1);
    assert.equal(leaderboard.body.entries[0].display_name, studentName);
    assertMetrics(leaderboard.body.entries[0], 'leaderboard', progress);
    assert.equal(leaderboard.body.entries[0].quests_completed, 2);

    await pool.query(
      `UPDATE public.playtime_sessions
          SET status = 'Offline', end_time = start_time + INTERVAL '53 minutes',
              total_playtime_minutes = 53, total_playtime_seconds = 3180
        WHERE id = $1`,
      [sessionId],
    );

    const stored = await pool.query(`SELECT COUNT(*)::INTEGER AS count,
      COUNT(DISTINCT result_event_id)::INTEGER AS events,
      COALESCE(SUM(score), 0)::INTEGER AS game_score,
      COALESCE(SUM(total_items), 0)::INTEGER AS total_questions
      FROM public.game_results WHERE resolved_student_id = $1`, [studentId]);
    assert.deepEqual(stored.rows[0], { count: 5, events: 5, game_score: 2, total_questions: 5 });
    const timingEvidence = await pool.query(
      `SELECT COUNT(response_time_seconds)::INTEGER AS timed_results,
              ROUND(AVG(response_time_seconds), 1)::FLOAT AS average_response_seconds
         FROM public.game_results WHERE resolved_student_id = $1`, [studentId],
    );
    assert.deepEqual(timingEvidence.rows[0], { timed_results: 5, average_response_seconds: 28.6 });
    const activityEvidence = await pool.query(
      `SELECT canonical_task_id, duration_seconds
         FROM public.activity_logs WHERE student_id = $1
         ORDER BY duration_seconds DESC`, [studentId],
    );
    assert.deepEqual(activityEvidence.rows.map((row) => [row.canonical_task_id, Number(row.duration_seconds)]), [
      ['first-bandit-math-challenge', 240], ['tutorial', 90], ['go-to-teachers-house', 60],
    ]);

    const list = await json(`${base}/api/students/progress?lifecycle=active`, { headers: adminHeaders });
    const listRow = list.body.find((row) => Number(row.student_id) === studentId);
    assert.equal(list.status, 200); assert.ok(listRow); assertMetrics(listRow, 'list', progress);
    assert.equal(listRow.incorrect_answers, 3);
    assert.equal(listRow.current_quest, 'Talk to the Teacher', 'accepted completion stores the authoritative next quest, not the completed task');

    const detail = await json(`${base}/api/student-progress/${studentId}?lifecycle=active`, { headers: adminHeaders });
    assert.equal(detail.status, 200); assertMetrics(detail.body.progress, 'detail', progress);
    assert.deepEqual({
      correct: detail.body.metrics.correctAnswers,
      wrong: detail.body.metrics.incorrectAnswers,
      recorded: detail.body.metrics.totalQuestions,
      accuracy: detail.body.metrics.accuracy,
      gameScore: detail.body.metrics.gameScore,
      quests: detail.body.metrics.completedQuests,
    }, { correct: 2, wrong: 3, recorded: 5, accuracy: 40, gameScore: 2, quests: 2 });

    const top = await json(`${base}/api/top-achievers`, { headers: adminHeaders });
    const topRow = top.body.find((row) => Number(row.student_id) === studentId);
    assert.equal(top.status, 200); assert.ok(topRow); assertMetrics(topRow, 'top', progress);
    assert.equal(topRow.total_quests_completed, 2);
    assert.equal(Number(topRow.total_playtime_seconds), 3180, 'Top Achievers uses the same 53-minute session total');

    const screenTime = await json(`${base}/api/playtime?search=${encodeURIComponent(studentCode)}&limit=20`, { headers: adminHeaders });
    assert.equal(screenTime.status, 200);
    const screenTimeRow = screenTime.body.data.find((row) => Number(row.student_id) === studentId);
    assert.ok(screenTimeRow, 'Screen Time exposes the same student session');
    assert.equal(Number(screenTimeRow.total_playtime_minutes), 53);
    assert.equal(Number(screenTime.body.summary.total_playtime_seconds), 3180);

  });

  test('Admin permanently deletes only the reviewed archived Screen Time row', async () => {
    const base = `http://127.0.0.1:${appServer.address().port}`;
    const adminHeaders = { Authorization: `Bearer ${token(adminId, 'admin')}` };
    const inserted = await pool.query(
      `INSERT INTO public.playtime_sessions
         (student_id, student_name, parent_id, status, date_played, start_time, end_time,
          total_playtime_minutes, total_playtime_seconds, deleted_at, deletion_operation_id)
       VALUES ($1, $2, $3, 'Offline', CURRENT_DATE, NOW() - INTERVAL '10 minutes', NOW(),
               10, 600, NOW(), gen_random_uuid())
       RETURNING id`,
      [studentId, studentName, parentCode],
    );
    const archivedId = Number(inserted.rows[0].id);
    const beforeResults = Number((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM public.game_results WHERE resolved_student_id = $1', [studentId],
    )).rows[0].count);
    const beforeActivities = Number((await pool.query(
      'SELECT COUNT(*)::INTEGER AS count FROM public.activity_logs WHERE student_id = $1', [studentId],
    )).rows[0].count);

    const preview = await json(`${base}/api/playtime/${archivedId}/permanent-delete-preview`, { headers: adminHeaders });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.record_id, archivedId);
    assert.ok(preview.body.preview_token);
    assert.ok(preview.body.target_fingerprint);

    const mismatch = await json(`${base}/api/playtime/${archivedId}/permanent-delete`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({
        reason: 'Disposable local verification fixture', confirmation: 'DELETE',
        preview_token: preview.body.preview_token, target_fingerprint: '0'.repeat(64),
      }),
    });
    assert.equal(mismatch.status, 409, 'target mismatch is rejected transaction-safely');
    assert.equal(Number((await pool.query('SELECT COUNT(*)::INTEGER AS count FROM public.playtime_sessions WHERE id = $1', [archivedId])).rows[0].count), 1);

    const removed = await json(`${base}/api/playtime/${archivedId}/permanent-delete`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({
        reason: 'Disposable local verification fixture', confirmation: 'DELETE',
        preview_token: preview.body.preview_token, target_fingerprint: preview.body.target_fingerprint,
      }),
    });
    assert.equal(removed.status, 200);
    assert.equal(Number((await pool.query('SELECT COUNT(*)::INTEGER AS count FROM public.playtime_sessions WHERE id = $1', [archivedId])).rows[0].count), 0);
    assert.equal(Number((await pool.query('SELECT COUNT(*)::INTEGER AS count FROM public.accounts WHERE id = $1', [studentId])).rows[0].count), 1);
    assert.equal(Number((await pool.query('SELECT COUNT(*)::INTEGER AS count FROM public.game_results WHERE resolved_student_id = $1', [studentId])).rows[0].count), beforeResults);
    assert.equal(Number((await pool.query('SELECT COUNT(*)::INTEGER AS count FROM public.activity_logs WHERE student_id = $1', [studentId])).rows[0].count), beforeActivities);
    assert.equal(Number((await pool.query('SELECT COUNT(*)::INTEGER AS count FROM public.playtime_deletion_tombstones WHERE deleted_record_id = $1', [archivedId])).rows[0].count), 1);
  });
}
