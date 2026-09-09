const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { buildStudentAnalyticsMetrics } = require('./studentAnalyticsMetrics.utils');
const { buildGroundedInsightInput, buildInsightFingerprint } = require('./studentAnalyticsInsight.utils');

const empty = { rows: [] };
const accountRoles = { admin: 'admin', teacher: 'teacher', parent: 'parent', parentTeacher: 'parent_teacher' };
const tokens = Object.fromEntries(Object.keys(accountRoles).map((token, index) => [token, index + 1]));
const accounts = Object.fromEntries(Object.entries(tokens).map(([token, id]) => [id, {
  id, role: accountRoles[token], session_version: 0, is_archived: false,
}]));
let fixture;
const compact = (sql) => String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
const applySqlLimit = (rows, sql) => rows.slice(0, Number(sql.match(/\blimit (\d+)\b/)?.[1] || rows.length));
const query = async (rawSql, params = [], readFixture = fixture) => {
  const sql = compact(rawSql);
  if (sql.startsWith('select * from public.accounts where id = $1')) return { rows: [accounts[params[0]]].filter(Boolean) };
  if (!readFixture) return empty;
  if (sql.startsWith('select 1')) return { rows: [{ linked: true }] };
  if (sql.includes('count(gr.id)::integer as unlinked_count')) return { rows: [{ unlinked_count: 0 }] };
  if (sql.includes('from public.accounts a') && sql.includes('left join lateral') && sql.includes('student_game_progress')) {
    const result = { rows: [readFixture.progress] };
    const afterProgressRead = fixture?.afterProgressRead;
    if (afterProgressRead) {
      delete fixture.afterProgressRead;
      afterProgressRead();
    }
    return result;
  }
  // Exercise the legacy parent-list SQL independently from the canonical reader.
  if (sql.includes('from public.teacher_student_relationships tsr') && sql.includes('sum(gr.score)')) {
    return { rows: [{
      student_id: 44, id: 44, student_name: 'Canonical Student', game_student_id: '00123456',
      grade_level: 'Grade 6', current_quest: readFixture.progress.current_quest,
      completion_percentage: readFixture.progress.progress_percentage,
      accuracy: readFixture.results.length ? 100 * readFixture.results.reduce((n, row) => n + row.score, 0) / readFixture.results.length : null,
      total_quizzes: readFixture.results.length,
    }] };
  }
  if (sql.includes('from public.game_results')) {
    const rows = sql.includes('played_at >=') ? readFixture.results.filter((row) => row.played_at >= readFixture.progress.current_learning_cycle_started_at) : readFixture.results;
    return { rows: applySqlLimit(rows, sql) };
  }
  if (sql.includes('from public.playtime_sessions')) return { rows: readFixture.playtime || [] };
  if (sql.includes('from public.student_ai_insights')) return { rows: readFixture.cached ? [readFixture.cached] : [] };
  if (sql.includes('insert into public.student_ai_insights')) {
    readFixture.cached = {
      input_fingerprint: params[1],
      insight: JSON.parse(params[2]),
      generated_at: '2026-09-09T00:00:00.000Z',
      stale_at: null,
    };
    return { rows: [{ insight: readFixture.cached.insight, generated_at: readFixture.cached.generated_at }] };
  }
  if (sql.includes('from public.activity_logs')) return empty;
  return empty;
};
const dbPath = require.resolve('./database/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  query,
  connect: async () => {
    let repeatableRead = false;
    let capturedFixture;
    return {
      query: async (sql, params) => {
        if (compact(sql).startsWith('begin')) {
          repeatableRead = /repeatable read/i.test(sql);
          return empty;
        }
        if (/^(commit|rollback)$/i.test(compact(sql))) {
          capturedFixture = undefined;
          repeatableRead = false;
          return empty;
        }
        // Model PostgreSQL's transaction snapshot at its first data read.
        if (repeatableRead && !capturedFixture && fixture) {
          capturedFixture = structuredClone({ ...fixture, afterProgressRead: undefined });
        }
        return query(sql, params, capturedFixture || fixture);
      },
      release() {},
    };
  },
} };
const middleware = () => (req, res, next) => next();
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'bcrypt') return { compare: async () => false, hash: async (value) => value };
  if (request === 'cors') return () => middleware();
  if (request === 'jsonwebtoken') return { sign: () => 'token', verify: (token) => ({ userId: tokens[token], sessionVersion: 0 }) };
  if (request === 'multer') return () => ({ single: middleware, array: middleware, fields: middleware });
  if (request === 'pdf-parse') return async () => ({ text: '' });
  return originalLoad.call(this, request, parent, isMain);
};
let app;
try { ({ app } = require('./server')); } finally { Module._load = originalLoad; }

const setup = async (t, answers = [1, 1, 1, 0], { providerSelection = null } = {}) => {
  fixture = {
    progress: {
      student_id: 44, student_name: 'Canonical Student', student_role: 'student', game_student_id: '00123456',
      grade_level: 'Grade 1', section: 'Jade', current_quest: 'first-bandit-math-challenge',
      current_scene: 'res://Scenes/oak_leaf_village.tscn', current_map: 'oak_leaf_village', difficulty_level: 'Easy',
      correct_answers: 1, total_questions: 1, progress_percentage: 0, total_quests_completed: 0,
      current_learning_cycle_started_at: '2026-09-01T00:00:00.000Z', current_learning_cycle_version: 2,
    },
    results: answers.map((score, index) => ({
      id: index + 1, resolved_student_id: 44, score, total_items: 1, difficulty: 'Easy',
      played_at: '2026-09-07T00:00:00.000Z', question_set_id: 77,
    })),
    playtime: [],
  };
  const server = await new Promise((resolve) => { const running = app.listen(0, () => resolve(running)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  let providerCalls = 0;
  if (providerSelection) process.env.OPENAI_API_KEY = 'test-only-provider-key';
  global.fetch = async (url, options) => {
    if (String(url) === 'https://api.openai.com/v1/responses' && providerSelection) {
      providerCalls += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ output_text: JSON.stringify(providerSelection) }),
      };
    }
    assert.ok(String(url).startsWith(base), 'Tests must never contact a live provider');
    return originalFetch(url, options);
  };
  t.after(async () => {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    fixture = null;
    await new Promise((resolve) => server.close(resolve));
  });
  const get = async (route, token = 'admin', method = 'GET') => {
    const response = await global.fetch(`${base}${route}`, { method, headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200, `${token} ${route}`);
    return response.json();
  };
  get.providerCallCount = () => providerCalls;
  return get;
};

test('authorized detail reads automatically share a preliminary grounded insight for four valid results', async (t) => {
  const get = await setup(t, [1, 1, 1, 0], {
    providerSelection: {
      grounding_policy_version: 'grounded-claims-v1',
      performance_claim_ids: ['results_recorded', 'answer_counts', 'overall_accuracy', 'current_difficulty'],
      strength_claim_ids: ['overall_accuracy_strength', 'difficulty_easy_strength'],
      weakness_claim_ids: [],
      recommendation_claim_ids: [],
    },
  });

  const admin = await get('/api/student-progress/44');
  const teacher = await get('/api/student-progress/44', 'teacher');
  const parent = await get('/api/student-progress/44?scope=parent', 'parent');

  assert.equal(admin.metrics.accuracy, 75);
  assert.equal(admin.aiInsight.status, 'generated');
  assert.equal(admin.aiInsight.data_level, 'limited_data');
  assert.equal(admin.aiInsight.preliminary, true);
  assert.equal(teacher.aiInsight.status, 'cached');
  assert.deepEqual(parent.aiInsight.insight, admin.aiInsight.insight);
  assert.equal(get.providerCallCount(), 1);
});

test('Student list uses the same recorded answer counts and difficulty breakdown as detail', async (t) => {
  const get = await setup(t);
  const detail = await get('/api/student-progress/44');
  const [student] = await get('/api/students/progress');
  assert.equal(detail.metrics.totalQuestions, 4);
  assert.equal(student.total_questions, detail.metrics.totalQuestions);
  assert.equal(student.correct_answers, detail.metrics.correctAnswers);
  assert.equal(student.incorrect_answers, detail.metrics.incorrectAnswers);
  assert.equal(student.accuracy_rate, detail.metrics.accuracy);
  assert.deepEqual(student.difficultyBreakdown, detail.metrics.difficultyBreakdown);
});

test('all authorized role contexts receive the same Student metrics', async (t) => {
  const get = await setup(t);
  const expected = await get('/api/student-progress/44');
  for (const [token, scope] of [['teacher', ''], ['parent', '?scope=parent'], ['parentTeacher', ''], ['parentTeacher', '?scope=parent']]) {
    const detail = await get(`/api/student-progress/44${scope}`, token);
    assert.deepEqual(detail.metrics, expected.metrics);
    const [row] = await get(`/api/students/progress${scope}`, token);
    assert.equal(row.accuracy_rate, expected.metrics.accuracy, `${token}${scope} list/detail accuracy`);
    assert.equal(row.current_quest, expected.metrics.currentQuest);
  }
});

test('detail includes every current-cycle answer after the first 100 results', async (t) => {
  const get = await setup(t, [...Array(100).fill(1), 0]);
  fixture.results.unshift({ id: 0, resolved_student_id: 44, score: 0, total_items: 1, difficulty: 'Hard', played_at: '2026-08-01T00:00:00.000Z' });
  const detail = await get('/api/student-progress/44');
  assert.equal(detail.metrics.totalQuestions, 101);
  assert.equal(detail.metrics.correctAnswers, 100);
  assert.equal(detail.metrics.accuracy, 99.01);
  assert.equal(detail.metrics.difficultyBreakdown.hard.accuracy, null);
});

test('detail and AI reuse the same complete evidence fingerprint after 500 results', async (t) => {
  const get = await setup(t, [...Array(500).fill(1), 0]);
  const metrics = buildStudentAnalyticsMetrics({ progress: fixture.progress, quizSessions: fixture.results, playtimeSessions: [] });
  fixture.cached = {
    input_fingerprint: buildInsightFingerprint(buildGroundedInsightInput({ gradeLevel: 'Grade 1', metrics })),
    insight: { performance_insight: 'Backend-rendered cached claim.', strengths: [], weaknesses: [], recommendations: [] },
    generated_at: '2026-09-07T00:00:00.000Z', stale_at: null,
  };
  const detail = await get('/api/student-progress/44');
  assert.equal(detail.aiInsight.status, 'cached');
  const generated = await get('/api/student-progress/44/ai-insight', 'admin', 'POST');
  assert.equal(generated.status, 'cached');
  assert.deepEqual(generated.insight, detail.aiInsight.insight);
});

test('Parent children and Student detail use canonical account Grade and matching answer facts', async (t) => {
  const get = await setup(t);
  const detail = await get('/api/student-progress/44?scope=parent', 'parent');
  const { children: [child] } = await get('/api/parent/children', 'parent');
  assert.equal(child.grade_level, detail.progress.grade_level);
  assert.equal(child.accuracy, detail.metrics.accuracy);
  assert.equal(child.correct_answers, detail.metrics.correctAnswers);
  assert.equal(child.total_questions, detail.metrics.totalQuestions);
  assert.equal(child.current_quest, detail.metrics.currentQuest);
});

test('read aliases and AI evidence never present legacy answer-like percentages as verified game completion', async (t) => {
  const get = await setup(t);
  fixture.progress.progress_percentage = 75;
  const detail = await get('/api/student-progress/44');
  const [row] = await get('/api/students/progress');
  const { children: [child] } = await get('/api/parent/children', 'parent');
  assert.equal(detail.metrics.accuracy, 75);
  assert.equal(detail.metrics.totalProgress, null);
  assert.equal(detail.metrics.reportedTotalProgress, 75);
  assert.equal(detail.progress.progress_percentage, null);
  assert.equal(row.progress_percentage, null);
  assert.equal(child.completion_percentage, null);
  const input = buildGroundedInsightInput({ gradeLevel: 'Grade 1', metrics: detail.metrics });
  assert.equal(input.total_progress, null);
  assert.equal(input.total_progress_verified, false);
  assert.equal(input.accuracy, 75);
});

test('unknown total game progress and unrecorded difficulty remain null in summaries and readiness', async (t) => {
  const get = await setup(t, []);
  fixture.progress.correct_answers = null;
  fixture.progress.total_questions = null;
  const overview = await get('/api/analytics/overview');
  assert.equal(overview.averageProgress, null);
  assert.equal(overview.gradeSummary[0].averageProgress, null);
  assert.equal(overview.gradeSummary[0].averageAccuracy, null);
  assert.equal(overview.gradeSummary[0].difficultyAverage.medium, null);
  const detail = await get('/api/student-progress/44');
  assert.equal(detail.analyticsReadiness.performanceSignals.progressPercentage, null);
  assert.equal(detail.analyticsReadiness.performanceSignals.accuracyRate, null);
});

for (const nextCycleAnswers of [[0, 0], []]) {
  for (const consumer of ['detail', 'list', 'parent', 'overview', 'ai']) {
    test(`${consumer} keeps one learning-cycle snapshot when a reset commits between reads (${nextCycleAnswers.length} new answers)`, async (t) => {
      const get = await setup(t, [1, 1, 1, 0, 0]);
      fixture.progress.score = 120;
      fixture.progress.total_quests_completed = 2;
      fixture.playtime = [{ student_id: 44, total_playtime_minutes: 10, status: 'Completed' }];
      const expected = buildStudentAnalyticsMetrics({ progress: fixture.progress, quizSessions: fixture.results, playtimeSessions: fixture.playtime });
      fixture.cached = {
        input_fingerprint: buildInsightFingerprint(buildGroundedInsightInput({ gradeLevel: 'Grade 1', metrics: expected })),
        insight: { performance_insight: 'Recorded overall accuracy is 60%.', strengths: [], weaknesses: [], recommendations: [] },
        generated_at: '2026-09-07T00:00:00.000Z', stale_at: null,
      };
      fixture.afterProgressRead = () => {
        fixture = {
          ...fixture,
          progress: {
            ...fixture.progress, current_learning_cycle_version: 3, current_learning_cycle_started_at: '2026-09-08T00:00:00.000Z',
            current_quest: 'go-to-teachers-house', score: 0, total_quests_completed: 0,
            correct_answers: 0, total_questions: 0,
          },
          results: nextCycleAnswers.map((score, index) => ({
            id: index + 100, resolved_student_id: 44, score, total_items: 1, difficulty: 'Easy', played_at: '2026-09-08T01:00:00.000Z',
          })),
          playtime: [],
        };
      };
      let actual;
      if (consumer === 'detail') actual = (await get('/api/student-progress/44')).metrics;
      if (consumer === 'list') actual = (await get('/api/students/progress'))[0].metrics;
      if (consumer === 'parent') actual = (await get('/api/parent/children', 'parent')).children[0].metrics;
      if (consumer === 'overview') {
        const overview = await get('/api/analytics/overview');
        assert.equal(overview.averageAccuracy, expected.accuracy);
        assert.equal(overview.gradeSummary[0].averageAccuracy, expected.accuracy);
      } else if (consumer === 'ai') {
        const insight = await get('/api/student-progress/44/ai-insight', 'admin', 'POST');
        assert.equal(insight.status, 'cached');
        assert.equal(insight.insight.performance_insight, 'Recorded overall accuracy is 60%.');
      } else {
        assert.deepEqual(actual, expected);
      }
    });
  }
}
