const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyTopicOverrides,
  auditGodotQuestionBundle,
  canonicalDifficulty,
  inferMetadata,
  normalizeQuestion,
} = require('./audit-godot-question-bundle');
const {
  applyClientProvidedImportPlan,
  buildClientProvidedImportPlan,
  parseCliArguments,
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

test('manifest infers filename metadata but keeps a single mapped topic confirmation-gated', () => withFixtureDirectory((root) => {
  writeJson(root, 'grade_4_medium.json', {
    questions: [{
      question: 'What is the value of 4 in 4,321?',
      choices: ['4', '40', '400'],
      correct_answer: 'C',
    }],
  });

  const audit = auditGodotQuestionBundle(root);
  const record = audit.records[0];
  assert.equal(record.grade, 'Grade 4');
  assert.equal(record.difficulty, 'Medium');
  assert.equal(record.topic_identifier, 'Place Value of Whole Numbers');
  assert.equal(record.topic_source, 'Existing grade/topic mapping');
  assert.equal(record.topic_classification, 'DERIVABLE WITH HIGH CONFIDENCE');
  assert.equal(record.import_eligibility, 'READY AFTER USER CONFIRMATION');
  assert.equal(buildClientProvidedImportPlan(audit, { actorId: 17 }).operations.length, 0);

  const confirmed = applyTopicOverrides(audit, {
    'grade_4_medium.json': 'Place Value of Whole Numbers',
  });
  const confirmedRecord = confirmed.records[0];
  assert.equal(confirmedRecord.topic_source, 'User-confirmed controlled topic');
  assert.equal(confirmedRecord.topic_classification, 'USER CONFIRMED');
  assert.equal(confirmedRecord.import_eligibility, 'READY FOR IMPORT');
  assert.equal(confirmedRecord.classification, 'READY TO IMPORT');
  assert.equal(buildClientProvidedImportPlan(confirmed, { actorId: 17 }).operations.length, 1);

  const invalidSelection = applyTopicOverrides(audit, {
    'grade_4_medium.json': 'Fractions',
  });
  assert.equal(invalidSelection.records[0].import_eligibility, 'READY AFTER USER CONFIRMATION');
  assert.equal(invalidSelection.records[0].review_error, 'Selected topic must be one of the manifest controlled topic options.');
  assert.equal(buildClientProvidedImportPlan(invalidSelection, { actorId: 17 }).operations.length, 0);
}));

test('manifest exposes malformed reasons and duplicate provenance without repairing client content', () => withFixtureDirectory((root) => {
  const validQuestion = {
    question: 'What is 2 + 2?',
    choices: ['3', '4'],
    correct_answer: 'B',
    topic: 'Basic Addition',
  };
  writeJson(root, 'Grade1/Easy/canonical.json', { questions: [validQuestion] });
  writeJson(root, 'Grade1/Easy/duplicate.json', { questions: [validQuestion] });
  writeJson(root, 'Grade1/Easy/malformed.json', {
    questions: [{ question: 'Missing answer', choices: ['A', 'B'], topic: 'Basic Addition' }],
  });

  const audit = auditGodotQuestionBundle(root);
  const canonical = audit.records.find((record) => record.file_name === 'canonical.json');
  const duplicate = audit.records.find((record) => record.file_name === 'duplicate.json');
  const malformed = audit.records.find((record) => record.file_name === 'malformed.json');
  assert.equal(canonical.import_eligibility, 'READY FOR IMPORT');
  assert.equal(duplicate.import_eligibility, 'DUPLICATE ONLY');
  assert.equal(duplicate.duplicate_details[0].canonical_source_path, canonical.path);
  assert.equal(malformed.import_eligibility, 'NEEDS MANUAL QUESTION REPAIR');
  assert.deepEqual(malformed.malformed_details, [{ question_index: 1, reason: 'Missing correct answer.' }]);
}));

test('manifest topic distribution counts source question metadata rather than one value per file', () => withFixtureDirectory((root) => {
  writeJson(root, 'Grade1/Easy/two-questions.json', {
    questions: [
      { question: 'What is 1 + 1?', choices: ['1', '2'], correct_answer: 'B', topic: 'Basic Addition' },
      { question: 'What is 2 + 2?', choices: ['3', '4'], correct_answer: 'B', topic: 'Basic Addition' },
    ],
  });
  const audit = auditGodotQuestionBundle(root);
  assert.deepEqual(audit.topic_distribution, { 'Basic Addition': 2 });
}));

test('import CLI accepts only an explicit local topic-overrides file option', () => {
  assert.deepEqual(
    parseCliArguments(['C:/Questions', '--topic-overrides=C:/review/topics.json', '--dry-run']),
    {
      rootPath: 'C:/Questions',
      actorId: null,
      apply: false,
      confirmed: false,
      topicOverridesPath: 'C:/review/topics.json',
    }
  );
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
  assert.equal(missingTopic.classification, 'NEEDS MANUAL REVIEW');
  assert.equal(missingTopic.import_eligibility, 'READY AFTER USER CONFIRMATION');
  assert.equal(missingTopic.topic_classification, 'AMBIGUOUS');
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
