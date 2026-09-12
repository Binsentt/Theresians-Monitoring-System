const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { resolveStudentAiInsight } = require('./studentAiInsight.service');
const {
  createInsightQaResultWriter,
  runInsightCacheVerification,
} = require('./studentInsightQaVerification');

const empty = { rows: [] };
const compact = (sql) => String(sql).replace(/\s+/g, ' ').trim().toLowerCase();

const createHarness = () => {
  let saved = null;
  let generatedAt = 0;
  const query = async (rawSql, params = []) => {
    const sql = compact(rawSql);
    if (sql.includes('from public.student_ai_insights')) return { rows: saved ? [structuredClone(saved)] : [] };
    if (sql.includes('insert into public.student_ai_insights')) {
      generatedAt += 1;
      saved = {
        input_fingerprint: params[1],
        insight: JSON.parse(params[2]),
        generated_at: `2026-09-09T00:00:0${generatedAt}.000Z`,
        stale_at: null,
      };
      return { rows: [{ insight: structuredClone(saved.insight), generated_at: saved.generated_at }] };
    }
    return empty;
  };
  return {
    pool: { query, connect: async () => ({ query, release() {} }) },
    getSaved: () => structuredClone(saved),
  };
};

const metrics = {
  validResultCount: 5,
  correctAnswers: 3,
  incorrectAnswers: 2,
  totalQuestions: 5,
  accuracy: 60,
  gameScore: 3,
  totalProgressVerified: false,
  completedQuests: 0,
  currentQuest: 'first-bandit-math-challenge',
  currentDifficulty: 'Easy',
  difficultyBreakdown: { easy: { accuracy: 60 }, medium: { accuracy: null }, hard: { accuracy: null } },
  topicPerformance: [],
  playtimeMinutes: 0,
};

const generatedInsight = {
  performance_insight: 'Recorded overall accuracy is 60%.',
  strengths: [],
  weaknesses: [],
  recommendations: [],
};

test('failed first insight generation skips cache verification and never makes a second provider call', async () => {
  const harness = createHarness();
  let providerCalls = 0;
  const result = await runInsightCacheVerification({
    request: { studentId: 44, gradeLevel: 'Grade 1', metrics: { ...metrics } },
    resolveInsight: (request) => resolveStudentAiInsight({
      ...request,
      aiGenerationEnabled: true,
      pool: harness.pool,
      generateInsight: async () => {
        providerCalls += 1;
        throw new Error('provider unavailable');
      },
    }),
  });

  assert.equal(result.first.status, 'unavailable');
  assert.equal(result.cacheVerification, 'skipped');
  assert.equal(result.second, null);
  assert.equal(providerCalls, 1);
  assert.equal(harness.getSaved(), null);
});

test('successful insight generation persists once and unchanged evidence verifies a cache hit without another provider call', async () => {
  const harness = createHarness();
  let providerCalls = 0;
  const result = await runInsightCacheVerification({
    request: { studentId: 44, gradeLevel: 'Grade 1', metrics: { ...metrics } },
    resolveInsight: (request) => resolveStudentAiInsight({
      ...request,
      aiGenerationEnabled: true,
      pool: harness.pool,
      generateInsight: async () => {
        providerCalls += 1;
        return generatedInsight;
      },
    }),
  });

  assert.equal(result.first.status, 'generated');
  assert.equal(result.second.status, 'cached');
  assert.equal(result.cacheVerification, 'hit');
  assert.equal(providerCalls, 1);
  assert.deepEqual(harness.getSaved().insight, generatedInsight);
});

const withQaArtifact = async (callback) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'student-insight-qa-'));
  const filePath = path.join(directory, 'result.json');
  try {
    return await callback(filePath);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
};

test('QA success flow durably records generation, persistence, cache, and one provider call', async () => {
  await withQaArtifact(async (filePath) => {
    const harness = createHarness();
    const writer = createInsightQaResultWriter({
      filePath,
      testRunId: 'run-success',
      candidateSha: 'a'.repeat(40),
    });
    let providerCalls = 0;
    const result = await runInsightCacheVerification({
      request: { studentId: 44, gradeLevel: 'Grade 1', metrics: { ...metrics } },
      resultWriter: writer,
      resolveInsight: (request) => resolveStudentAiInsight({
        ...request,
        aiGenerationEnabled: true,
        pool: harness.pool,
        generateInsight: async () => {
          providerCalls += 1;
          return generatedInsight;
        },
      }),
    });

    const artifact = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.equal(result.first.status, 'generated');
    assert.equal(result.second.status, 'cached');
    assert.equal(result.cacheVerification, 'hit');
    assert.equal(providerCalls, 1);
    assert.equal(artifact.providerCallCount, 1);
    assert.equal(artifact.httpStatus, null);
    assert.equal(typeof artifact.elapsedMs, 'number');
    assert.equal(artifact.generationSuccess, true);
    assert.equal(artifact.persistenceSuccess, true);
    assert.equal(artifact.cacheCheckPerformed, true);
    assert.equal(artifact.cacheHit, true);
    assert.ok(artifact.providerCallStartedAt);
    assert.ok(artifact.providerCallFinishedAt);
    assert.ok(artifact.finishedAt);
    assert.equal(Object.prototype.hasOwnProperty.call(artifact, 'apiKey'), false);
  });
});

test('QA provider failure records sanitized failure details, skips cache, and keeps one provider call', async () => {
  await withQaArtifact(async (filePath) => {
    const writer = createInsightQaResultWriter({
      filePath,
      testRunId: 'run-failure',
      candidateSha: 'b'.repeat(40),
    });
    let providerCalls = 0;
    const result = await runInsightCacheVerification({
      request: { studentId: 44, gradeLevel: 'Grade 1', metrics: { ...metrics } },
      resultWriter: writer,
      resolveInsight: async () => {
        providerCalls += 1;
        return {
          status: 'unavailable',
          providerDiagnostics: {
            http_status: 503,
            request_id: 'req_sanitized',
            error_type: 'server_error',
            error_code: 'temporarily_unavailable',
          },
          message: 'do not persist this raw message',
        };
      },
    });

    const artifact = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const artifactText = await fs.readFile(filePath, 'utf8');
    assert.equal(result.first.status, 'unavailable');
    assert.equal(result.second, null);
    assert.equal(result.cacheVerification, 'skipped');
    assert.equal(providerCalls, 1);
    assert.equal(artifact.providerCallCount, 1);
    assert.equal(typeof artifact.elapsedMs, 'number');
    assert.equal(artifact.httpStatus, 503);
    assert.equal(artifact.requestId, 'req_sanitized');
    assert.equal(artifact.errorType, 'server_error');
    assert.equal(artifact.errorCode, 'temporarily_unavailable');
    assert.equal(artifact.generationSuccess, false);
    assert.equal(artifact.persistenceSuccess, false);
    assert.equal(artifact.cacheCheckPerformed, false);
    assert.equal(artifact.cacheHit, false);
    assert.equal(artifactText.includes('do not persist this raw message'), false);
  });
});

test('QA interruption after provider start leaves a readable partial artifact and cleanup remains recoverable', async () => {
  await withQaArtifact(async (filePath) => {
    const writer = createInsightQaResultWriter({
      filePath,
      testRunId: 'run-interrupted',
      candidateSha: 'c'.repeat(40),
    });
    await writer.markProviderCallStarted();
    const artifact = await writer.read();
    const entries = await fs.readdir(path.dirname(filePath));
    assert.equal(artifact.providerCallCount, 1);
    assert.ok(artifact.providerCallStartedAt);
    assert.equal(artifact.providerCallFinishedAt, null);
    assert.equal(artifact.finishedAt, null);
    assert.deepEqual(entries, ['result.json']);
  });
});

test('QA cache verification never invokes the provider a second time for unchanged evidence', async () => {
  await withQaArtifact(async (filePath) => {
    const harness = createHarness();
    const writer = createInsightQaResultWriter({
      filePath,
      testRunId: 'run-cache',
      candidateSha: 'd'.repeat(40),
    });
    let resolveCalls = 0;
    let providerCalls = 0;
    const result = await runInsightCacheVerification({
      request: { studentId: 44, gradeLevel: 'Grade 1', metrics: { ...metrics } },
      resultWriter: writer,
      resolveInsight: (request) => {
        resolveCalls += 1;
        return resolveStudentAiInsight({
          ...request,
          aiGenerationEnabled: true,
          pool: harness.pool,
          generateInsight: async () => {
            providerCalls += 1;
            return generatedInsight;
          },
        });
      },
    });

    const artifact = await writer.read();
    assert.equal(result.cacheVerification, 'hit');
    assert.equal(resolveCalls, 2);
    assert.equal(providerCalls, 1);
    assert.equal(artifact.providerCallCount, 1);
    assert.equal(artifact.cacheHit, true);
  });
});
