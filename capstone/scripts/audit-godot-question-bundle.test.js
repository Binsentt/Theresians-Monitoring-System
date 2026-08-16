const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  auditGodotQuestionBundle,
  canonicalDifficulty,
  inferMetadata,
  normalizeQuestion,
} = require('./audit-godot-question-bundle');
const {
  applyClientProvidedImportPlan,
  buildClientProvidedImportPlan,
} = require('./import-godot-question-bundle');

test('dry-run question audit canonicalizes legacy difficulty folders without changing files', () => {
  assert.equal(canonicalDifficulty('Normal'), 'Medium');
  assert.equal(canonicalDifficulty('Difficult'), 'Hard');
  assert.equal(canonicalDifficulty('Easy'), 'Easy');

  const metadata = inferMetadata(
    'C:/Questions',
    path.join('C:/Questions', 'grade 3', 'Normal', 'average.docx')
  );
  assert.equal(metadata.grade, 'Grade 3');
  assert.equal(metadata.difficulty, 'Medium');
});

test('dry-run question audit resolves a letter answer to its supplied choice', () => {
  assert.deepEqual(normalizeQuestion({
    question: 'What is 2 + 2?',
    choices: ['3', '4', '5'],
    correct_answer: 'B. 4',
  }), {
    question: 'What is 2 + 2?',
    choices: ['3', '4', '5'],
    answer: '4',
    topic: null,
  });
});

const withFixtureDirectory = (callback) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'godot-question-manifest-'));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const writeJson = (root, relativePath, payload) => {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(payload));
};

test('manifest strictly classifies client content and proposes only clean, fully scoped sets', () => withFixtureDirectory((root) => {
  const cleanQuestion = {
    question: 'What is 1 + 1?',
    choices: ['1', '2', '3'],
    correct_answer: 'B',
    topic: 'Addition',
  };
  writeJson(root, 'Grade1/Normal/clean.json', { questions: [cleanQuestion] });
  writeJson(root, 'Grade1/Normal/duplicate.json', { questions: [cleanQuestion] });
  writeJson(root, 'Grade1/Easy/missing-topic.json', {
    questions: [{ ...cleanQuestion, question: 'What is 2 + 2?', topic: '' }],
  });
  writeJson(root, 'Grade1/Hard/malformed.json', {
    questions: [{ question: 'Missing answer', choices: ['A', 'B'] }],
  });
  writeJson(root, 'Grade1/Hard/partially-malformed.json', {
    questions: [
      { ...cleanQuestion, question: 'What is 3 + 3?' },
      { question: 'Missing answer', choices: ['A', 'B'] },
    ],
  });

  const audit = auditGodotQuestionBundle(root);
  const clean = audit.records.find((record) => record.file_name === 'clean.json');
  const duplicate = audit.records.find((record) => record.file_name === 'duplicate.json');
  const missingTopic = audit.records.find((record) => record.file_name === 'missing-topic.json');
  const malformed = audit.records.find((record) => record.file_name === 'malformed.json');
  const partiallyMalformed = audit.records.find((record) => record.file_name === 'partially-malformed.json');

  assert.equal(clean.classification, 'READY TO IMPORT');
  assert.equal(clean.difficulty, 'Medium');
  assert.equal(clean.legacy_difficulty, 'Normal');
  assert.equal(clean.topic_identifier, 'Addition');
  assert.match(clean.content_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(duplicate.classification, 'DUPLICATE');
  assert.equal(missingTopic.classification, 'MISSING TOPIC');
  assert.equal(malformed.classification, 'MALFORMED');
  assert.equal(partiallyMalformed.classification, 'MALFORMED');
  assert.equal(audit.malformed_file_count, 2);
  assert.equal(audit.proposed_import_count, 1);
  assert.equal(audit.proposed_import_question_count, 1);

  const plan = buildClientProvidedImportPlan(audit, { actorId: 17 });
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.import_actor_id, 17);
  assert.equal(plan.default_user_facing_status, 'Pending');
  assert.ok(Buffer.isBuffer(plan.operations[0].source_file.bytes));
  assert.deepEqual(plan.operations[0].learning_file, {
    title: 'clean',
    file_name: 'clean.json',
    file_url: `database://client-provided/${clean.content_fingerprint}`,
    grade_level: 'Grade 1',
    difficulty: 'Medium',
    math_topic: 'Addition',
    file_type: 'fixed_questions',
    source: 'restored_import',
    source_label: 'Client Provided',
    uploaded_by: 17,
    file_size: fs.statSync(path.join(root, 'Grade1/Normal/clean.json')).size,
    published: false,
    generation_status: 'not_applicable',
    publish_status: 'staged',
    source_content_fingerprint: clean.content_fingerprint,
    source_file_mime_type: 'application/json',
  });
}));

test('approved importer is transactional and skips an already represented fingerprint', async () => {
  const audit = {
    records: [{
      classification: 'READY TO IMPORT',
      title: 'clean',
      file_name: 'clean.json',
      content_fingerprint: 'a'.repeat(64),
      grade: 'Grade 1',
      difficulty: 'Easy',
      topic_identifier: 'Addition',
      source_size_bytes: 25,
      source_file_bytes: Buffer.from('{"questions":[]}'),
      source_file_mime_type: 'application/json',
      questions: [{ question: '1 + 1?', choices: ['1', '2'], answer: '2', topic: 'Addition' }],
    }],
  };
  const plan = buildClientProvidedImportPlan(audit, { actorId: 17 });
  const calls = [];
  const insertedClient = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/SELECT id, role, is_archived FROM public\.accounts/.test(sql)) {
        return { rows: [{ id: 17, role: 'teacher', is_archived: false }] };
      }
      if (/SELECT id FROM public\.learning_files/.test(sql)) return { rows: [] };
      if (/INSERT INTO public\.learning_files/.test(sql)) return { rows: [{ id: 42 }] };
      return { rows: [] };
    },
    release: () => {},
  };
  const pool = { connect: async () => insertedClient };
  const imported = await applyClientProvidedImportPlan(plan, pool);
  assert.deepEqual(imported, {
    imported_sets: 1,
    skipped_existing_sets: 0,
    skipped_duplicate_sets: 0,
    imported_questions: 1,
  });
  assert.equal(calls[0].sql, 'BEGIN');
  assert.ok(calls.some((call) => /pg_advisory_xact_lock/.test(call.sql)));
  assert.ok(calls.some((call) => /INSERT INTO public\.questions/.test(call.sql)));
  assert.ok(calls.some((call) => /source_file_bytes/.test(call.sql) && Buffer.isBuffer(call.params.at(-2))));
  assert.equal(calls.at(-1).sql, 'COMMIT');

  const skipCalls = [];
  const existingClient = {
    query: async (sql, params = []) => {
      skipCalls.push({ sql, params });
      if (/SELECT id, role, is_archived FROM public\.accounts/.test(sql)) {
        return { rows: [{ id: 17, role: 'parent_teacher', is_archived: false }] };
      }
      if (/SELECT id FROM public\.learning_files/.test(sql)) return { rows: [{ id: 42 }] };
      return { rows: [] };
    },
    release: () => {},
  };
  const skipped = await applyClientProvidedImportPlan(plan, { connect: async () => existingClient });
  assert.deepEqual(skipped, {
    imported_sets: 0,
    skipped_existing_sets: 1,
    skipped_duplicate_sets: 0,
    imported_questions: 0,
  });
  assert.equal(skipCalls.some((call) => /INSERT INTO public\.learning_files/.test(call.sql)), false);

  const duplicateCalls = [];
  const duplicateClient = {
    query: async (sql, params = []) => {
      duplicateCalls.push({ sql, params });
      if (/SELECT id, role, is_archived FROM public\.accounts/.test(sql)) {
        return { rows: [{ id: 17, role: 'admin', is_archived: false }] };
      }
      if (/SELECT id FROM public\.learning_files/.test(sql)) return { rows: [] };
      if (/SELECT id FROM public\.questions/.test(sql)) return { rows: [{ id: 99 }] };
      return { rows: [] };
    },
    release: () => {},
  };
  const duplicateSkipped = await applyClientProvidedImportPlan(plan, { connect: async () => duplicateClient });
  assert.deepEqual(duplicateSkipped, {
    imported_sets: 0,
    skipped_existing_sets: 0,
    skipped_duplicate_sets: 1,
    imported_questions: 0,
  });
  assert.equal(duplicateCalls.some((call) => /INSERT INTO public\.learning_files/.test(call.sql)), false);
});

test('import application requires an active Lesson Manager role and a resolved actor', async () => {
  const actorlessPlan = buildClientProvidedImportPlan({ records: [] });
  await assert.rejects(
    applyClientProvidedImportPlan(actorlessPlan, { connect: async () => ({ query: async () => ({}), release: () => {} }) }),
    /positive importer actor ID/
  );

  const plan = buildClientProvidedImportPlan({ records: [] }, { actorId: 17 });
  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      if (/SELECT id, role, is_archived FROM public\.accounts/.test(sql)) {
        return { rows: [{ id: 17, role: 'parent', is_archived: false }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  await assert.rejects(
    applyClientProvidedImportPlan(plan, { connect: async () => client }),
    /active Admin, Teacher, or Parent\/Teacher/
  );
  assert.ok(calls.includes('ROLLBACK'));
});

test('import application rolls back the entire transaction when a question insert fails', async () => {
  const plan = buildClientProvidedImportPlan({
    records: [{
      classification: 'READY TO IMPORT',
      title: 'clean',
      file_name: 'clean.json',
      content_fingerprint: 'b'.repeat(64),
      grade: 'Grade 1',
      difficulty: 'Easy',
      topic_identifier: 'Addition',
      source_size_bytes: 25,
      source_file_bytes: Buffer.from('{"questions":[]}'),
      source_file_mime_type: 'application/json',
      questions: [{ question: '1 + 1?', choices: ['1', '2'], answer: '2', topic: 'Addition' }],
    }],
  }, { actorId: 17 });
  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      if (/SELECT id, role, is_archived FROM public\.accounts/.test(sql)) {
        return { rows: [{ id: 17, role: 'teacher', is_archived: false }] };
      }
      if (/SELECT id FROM public\.learning_files/.test(sql)) return { rows: [] };
      if (/SELECT id FROM public\.questions/.test(sql)) return { rows: [] };
      if (/INSERT INTO public\.learning_files/.test(sql)) return { rows: [{ id: 42 }] };
      if (/INSERT INTO public\.questions/.test(sql)) throw new Error('injected question insert failure');
      return { rows: [] };
    },
    release: () => {},
  };
  await assert.rejects(
    applyClientProvidedImportPlan(plan, { connect: async () => client }),
    /injected question insert failure/
  );
  assert.ok(calls.includes('ROLLBACK'));
  assert.equal(calls.includes('COMMIT'), false);
});
