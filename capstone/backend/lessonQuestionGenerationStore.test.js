const assert = require('node:assert/strict');
const test = require('node:test');
const { createRowBackedQuestionGenerationStore, acquireLessonQuestionGenerationLock } = require('./lessonQuestionGenerationStore');
const { runQuestionGenerationJob } = require('./lessonQuestionGenerationWorker');

const question = (index) => ({
  question: `What is ${index} + 1?`,
  options: [`${index}`, `${index + 1}`, `${index + 2}`, `${index + 3}`],
  correct_answer: `${index + 1}`,
});

function createFakeDatabase(requestedCount = 3, existing = []) {
  const job = {
    id: 91,
    requested_question_count: requestedCount,
    grade_level: 'Grade 1',
    difficulty: 'Easy',
    math_topic: null,
    topic_id: null,
    source: 'lesson',
    content_role: 'question_set',
    generation_status: 'queued',
    generation_completed_count: existing.length,
    generation_remaining_count: requestedCount - existing.length,
  };
  const questions = existing.map((item) => ({ ...item }));
  const calls = [];
  let failAtQuestionInsert = 0;
  let insertCount = 0;
  let poolConnectionCount = 0;
  let transactionSnapshot = null;
  const result = (rows = []) => ({ rows });

  const createClient = ({ lock = false } = {}) => ({
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      calls.push({ sql: normalized, params });
      if (normalized.includes('pg_try_advisory_lock')) return result([{ acquired: true }]);
      if (normalized.includes('pg_advisory_unlock')) return result([{ pg_advisory_unlock: true }]);
      if (normalized === 'begin') {
        transactionSnapshot = { questions: questions.map((item) => ({ ...item })), job: { ...job } };
        return result();
      }
      if (normalized === 'commit') {
        transactionSnapshot = null;
        return result();
      }
      if (normalized === 'rollback') {
        if (transactionSnapshot) {
          questions.splice(0, questions.length, ...transactionSnapshot.questions);
          Object.assign(job, transactionSnapshot.job);
        }
        transactionSnapshot = null;
        return result();
      }
      if (normalized.includes('select id, requested_question_count') && normalized.includes('for update')) {
        return result([{ ...job }]);
      }
      if (normalized.startsWith('select question from public.questions')) {
        return result(questions.map(({ question: text }) => ({ question: text })));
      }
      if (normalized.startsWith('select count(*)::integer as actual_question_count from public.questions')) {
        return result([{ actual_question_count: questions.length }]);
      }
      if (normalized.startsWith('insert into public.questions')) {
        insertCount += 1;
        if (failAtQuestionInsert === insertCount) throw new Error('synthetic insert failure');
        questions.push({
          question: params[1],
          options: JSON.parse(params[2]),
          correct_answer: params[3],
        });
        return result();
      }
      if (normalized.startsWith('update public.learning_files') && normalized.includes('generation_completed_count = $3')) {
        Object.assign(job, {
          generation_status: params[1],
          generation_completed_count: params[2],
          generation_remaining_count: params[3],
          generation_stage: params[4],
        });
        return result([{ ...job }]);
      }
      if (normalized.includes('count(q.id)::integer as actual_question_count')) {
        return result([{ ...job, actual_question_count: questions.length }]);
      }
      if (normalized.startsWith('select question, options, correct_answer')) {
        return result(questions.map((item) => ({ ...item })));
      }
      if (normalized.startsWith('with actual as')) {
        if (normalized.includes("set generation_status = 'generating'")) {
          Object.assign(job, {
            generation_status: 'generating',
            generation_stage: params[1],
            generation_completed_count: questions.length,
            generation_remaining_count: Math.max(0, requestedCount - questions.length),
          });
          return result([{ ...job, actual_question_count: questions.length }]);
        }
        if (normalized.includes("set generation_status = 'ready_for_review'")) {
          if (questions.length !== requestedCount) return result([]);
          Object.assign(job, {
            generation_status: 'ready_for_review',
            generation_stage: 'completed',
            generation_completed_count: questions.length,
            generation_remaining_count: 0,
          });
          return result([{ ...job, actual_question_count: questions.length }]);
        }
        if (normalized.includes('set generation_status = case')) {
          job.generation_status = questions.length === requestedCount ? 'ready_for_review' : questions.length ? 'partial_failed' : 'failed';
          job.generation_stage = job.generation_status === 'ready_for_review' ? 'completed' : job.generation_status;
          job.generation_completed_count = questions.length;
          job.generation_remaining_count = Math.max(0, requestedCount - questions.length);
          job.generation_error_code = job.generation_status === 'ready_for_review' ? null : params[1];
          return result([{ ...job, actual_question_count: questions.length }]);
        }
        return result([]);
      }
      return result();
    },
    release() {},
  });

  return {
    job,
    questions,
    calls,
    setInsertFailure(number) {
      failAtQuestionInsert = number;
      insertCount = 0;
    },
    pool: {
      async connect() {
        poolConnectionCount += 1;
        return createClient();
      },
      get connectionCount() { return poolConnectionCount; },
    },
    lockClient: createClient({ lock: true }),
  };
}

test('each persisted batch uses one transaction and updates counters from the actual saved question count', async () => {
  const db = createFakeDatabase(3);
  const store = createRowBackedQuestionGenerationStore(db.pool, db.lockClient);
  const saved = await store.persistBatchAndProgress(91, [question(1), question(2)]);

  assert.equal(saved.actualQuestionCount, 2);
  assert.equal(saved.remainingQuestionCount, 1);
  assert.equal(saved.status, 'generating');
  assert.equal(db.job.generation_completed_count, 2);
  assert.equal(db.job.generation_remaining_count, 1);
  assert.equal(db.job.generation_status, 'generating');
  assert.equal(db.job.generation_stage, 'generating');
  const statements = db.calls.map(({ sql }) => sql);
  assert.ok(statements.includes('begin'));
  assert.ok(statements.includes('commit'));
  assert.equal(statements.filter((sql) => sql === 'rollback').length, 0);
});

test('batch transactions reuse the row advisory-lock connection instead of borrowing a second pool connection', async () => {
  const db = createFakeDatabase(1);
  const store = createRowBackedQuestionGenerationStore(db.pool, db.lockClient);
  await store.persistBatchAndProgress(91, [question(1)]);

  assert.equal(db.pool.connectionCount, 0);
  const transactionCalls = db.calls.filter(({ sql }) => ['begin', 'commit', 'rollback'].includes(sql));
  assert.deepEqual(transactionCalls.map(({ sql }) => sql), ['begin', 'commit']);
});

test('store rejects duplicate saved question text and readies a row only at exact count', async () => {
  const db = createFakeDatabase(2, [question(1)]);
  const store = createRowBackedQuestionGenerationStore(db.pool, db.lockClient);
  const persisted = await store.persistBatchAndProgress(91, [
    { ...question(1), question: ' WHAT IS 1 + 1? ' },
    question(2),
  ]);

  assert.equal(db.questions.length, 2);
  assert.equal(persisted.actualQuestionCount, 2);
  assert.equal(persisted.remainingQuestionCount, 0);
  assert.equal(persisted.status, 'ready_for_review');
  assert.equal(db.job.generation_completed_count, 2);
  assert.equal(db.job.generation_status, 'ready_for_review');
  assert.equal(db.job.generation_stage, 'completed');
});

test('stage updates keep the job active while counters use the actual row question count', async () => {
  const db = createFakeDatabase(4, [question(1), question(2)]);
  const store = createRowBackedQuestionGenerationStore(db.pool, db.lockClient);
  const row = await store.setStage(91, 'extracting');

  assert.equal(row.generation_status, 'generating');
  assert.equal(row.generation_stage, 'extracting');
  assert.equal(row.generation_completed_count, 2);
  assert.equal(row.generation_remaining_count, 2);
});

test('failure state reports persisted partial count and retry remainder without deleting saved questions', async () => {
  const db = createFakeDatabase(4, [question(1), question(2)]);
  const store = createRowBackedQuestionGenerationStore(db.pool, db.lockClient);
  const failed = await store.markFailed(91, 'QUESTION_AI_BATCH_FAILED', 1);

  assert.equal(failed.status, 'partial_failed');
  assert.equal(failed.actualQuestionCount, 2);
  assert.equal(failed.remainingQuestionCount, 2);
  assert.equal(db.questions.length, 2);
  assert.equal(db.job.generation_stage, 'partial_failed');
});

test('worker resumes from the exact row and requeries persisted database counts after each batch', async () => {
  const db = createFakeDatabase(7);
  const store = createRowBackedQuestionGenerationStore(db.pool, db.lockClient);
  const calls = [];
  let nextQuestion = 1;

  const result = await runQuestionGenerationJob({
    learningFileId: 91,
    store,
    batchSize: 5,
    generateBatch: async (count, _batchIndex, context) => {
      calls.push({ count, persistedBeforeCall: context.existingQuestions.length });
      return Array.from({ length: count }, () => question(nextQuestion++));
    },
  });

  assert.deepEqual(calls, [
    { count: 5, persistedBeforeCall: 0 },
    { count: 2, persistedBeforeCall: 5 },
  ]);
  assert.equal(db.questions.length, 7);
  assert.equal(db.job.generation_completed_count, 7);
  assert.equal(db.job.generation_remaining_count, 0);
  assert.equal(db.job.generation_status, 'ready_for_review');
  assert.equal(db.job.generation_stage, 'completed');
  assert.equal(result.completedCount, 7);
});

test('a failed batch rolls back its questions and does not advance the saved count', async () => {
  const db = createFakeDatabase(3);
  db.setInsertFailure(2);
  const store = createRowBackedQuestionGenerationStore(db.pool, db.lockClient);

  await assert.rejects(store.persistBatchAndProgress(91, [question(1), question(2)]), /synthetic insert failure/);
  assert.equal(db.questions.length, 0);
  assert.equal(db.job.generation_completed_count, 0);
  assert.ok(db.calls.some(({ sql }) => sql === 'rollback'));
  assert.equal(db.calls.some(({ sql }) => sql === 'commit'), false);
});

test('advisory lock acquisition is scoped to the exact row and releases after a collision', async () => {
  let released = false;
  const pool = {
    async connect() {
      return {
        async query(sql, params) {
          assert.match(sql, /pg_try_advisory_lock/);
          assert.deepEqual(params, [4819021, 91]);
          return { rows: [{ acquired: false }] };
        },
        release() { released = true; },
      };
    },
  };
  const lock = await acquireLessonQuestionGenerationLock(pool, 91);
  assert.equal(lock.acquired, false);
  assert.equal(lock.store, null);
  assert.equal(released, true);
});
