#!/usr/bin/env node

// Explicit, approval-gated importer for clean bundled Godot question sets.
// It is never imported by the server and dry-run is the default CLI mode.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { applyTopicOverrides, auditGodotQuestionBundle } = require('./audit-godot-question-bundle');

const CLIENT_PROVIDED_SOURCE = 'restored_import';
const CLIENT_PROVIDED_LABEL = 'Client Provided';
const LESSON_MANAGER_IMPORT_ROLES = new Set(['admin', 'teacher', 'parent_teacher']);
const GAME_LOCATION_BY_DIFFICULTY = Object.freeze({
  Easy: 'Oakleaf Village',
  Medium: 'City of Knowledge',
  Hard: 'Pinehill Village',
});

const canonicalQuestionSignature = (question) => JSON.stringify({
  question: question.question,
  options: question.choices,
  correct_answer: question.answer,
  topic: question.math_topic || question.topic,
});

const reviewedManifestError = (question, message) => {
  const source = `${question?.source_file || '<unknown source>'}:${question?.source_index || '?'}`;
  throw new Error(`Reviewed import manifest entry ${source} ${message}`);
};

const reviewedGroupKey = (question) => [
  question.grade,
  question.canonical_difficulty,
  question.confirmed_topic,
].join('::');

const reviewedGroupFingerprint = (group) => crypto.createHash('sha256')
  .update(JSON.stringify({
    grade: group.grade,
    canonical_difficulty: group.canonical_difficulty,
    confirmed_topic: group.confirmed_topic,
    question_fingerprints: group.questions.map((question) => question.stable_fingerprint).sort(),
  }))
  .digest('hex');

const slugify = (value) => String(value)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/(^-|-$)/g, '');

const normalizeReviewedManifestQuestion = (rawQuestion) => {
  const question = rawQuestion && typeof rawQuestion === 'object' ? rawQuestion : {};
  if (typeof question.source_file !== 'string' || !question.source_file.trim()) {
    reviewedManifestError(question, 'is missing its stable source file.');
  }
  if (!Number.isInteger(question.source_index) || question.source_index < 1) {
    reviewedManifestError(question, 'is missing a positive source question index.');
  }
  if (typeof question.stable_fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(question.stable_fingerprint)) {
    reviewedManifestError(question, 'is missing a stable fingerprint.');
  }
  if (!/^Grade [1-6]$/.test(question.grade || '')) {
    reviewedManifestError(question, 'has an invalid Grade.');
  }
  if (!Object.hasOwn(GAME_LOCATION_BY_DIFFICULTY, question.canonical_difficulty)) {
    reviewedManifestError(question, 'has an invalid canonical Difficulty.');
  }
  if (question.game_location !== GAME_LOCATION_BY_DIFFICULTY[question.canonical_difficulty]) {
    reviewedManifestError(question, 'has a Location that does not match the authoritative location mapping.');
  }
  if (typeof question.confirmed_topic !== 'string' || !question.confirmed_topic.trim()) {
    reviewedManifestError(question, 'is missing its one confirmed controlled Topic.');
  }
  if (typeof question.question_text !== 'string' || !question.question_text.trim()) {
    reviewedManifestError(question, 'has an empty question text.');
  }
  if (!Array.isArray(question.choices) || question.choices.length < 2
    || question.choices.some((choice) => typeof choice !== 'string' || !choice.trim())) {
    reviewedManifestError(question, 'has invalid answer choices.');
  }
  if (typeof question.correct_answer !== 'string' || !question.correct_answer.trim()
    || !question.choices.some((choice) => choice.trim() === question.correct_answer.trim())) {
    reviewedManifestError(question, 'has a correct answer that is not one of its choices.');
  }
  return {
    source_file: question.source_file,
    source_index: question.source_index,
    stable_fingerprint: question.stable_fingerprint.toLowerCase(),
    grade: question.grade,
    canonical_difficulty: question.canonical_difficulty,
    game_location: question.game_location,
    confirmed_topic: question.confirmed_topic.trim(),
    question_text: question.question_text.trim(),
    choices: question.choices.map((choice) => choice.trim()),
    correct_answer: question.correct_answer.trim(),
  };
};

const buildReviewedManifestImportPlan = (reviewedManifest, { actorId } = {}) => {
  if (!reviewedManifest || typeof reviewedManifest !== 'object' || Array.isArray(reviewedManifest)) {
    throw new Error('Reviewed import manifest must be a JSON object.');
  }
  if (reviewedManifest.mode !== 'reviewed-import-manifest'
    || reviewedManifest.production_import_performed !== false
    || reviewedManifest.topic_inference_performed_during_apply !== false) {
    throw new Error('Reviewed import manifest must be an unimported no-inference reviewed manifest.');
  }
  if (!Array.isArray(reviewedManifest.questions) || reviewedManifest.questions.length === 0) {
    throw new Error('Reviewed import manifest must include at least one approved question.');
  }
  if (Number(reviewedManifest.question_count) !== reviewedManifest.questions.length) {
    throw new Error('Reviewed import manifest question_count does not match its approved questions.');
  }

  const normalizedActorId = actorId == null ? null : Number(actorId);
  if (normalizedActorId != null && (!Number.isInteger(normalizedActorId) || normalizedActorId <= 0)) {
    throw new Error('A positive importer actor ID is required.');
  }
  const seenFingerprints = new Set();
  const groups = new Map();
  reviewedManifest.questions.map(normalizeReviewedManifestQuestion).forEach((question) => {
    if (seenFingerprints.has(question.stable_fingerprint)) {
      reviewedManifestError(question, 'duplicates another approved stable fingerprint.');
    }
    seenFingerprints.add(question.stable_fingerprint);
    const key = reviewedGroupKey(question);
    const group = groups.get(key) || {
      grade: question.grade,
      canonical_difficulty: question.canonical_difficulty,
      game_location: question.game_location,
      confirmed_topic: question.confirmed_topic,
      questions: [],
    };
    group.questions.push(question);
    groups.set(key, group);
  });
  if (Number(reviewedManifest.question_set_count) !== groups.size) {
    throw new Error('Reviewed import manifest question_set_count does not match Grade + Difficulty + Topic grouping.');
  }

  const operations = Array.from(groups.values())
    .sort((left, right) => reviewedGroupKey(left).localeCompare(reviewedGroupKey(right)))
    .map((group) => {
      const fingerprint = reviewedGroupFingerprint(group);
      const sourcePayload = {
        source: 'reviewed-import-manifest',
        schema_version: reviewedManifest.schema_version,
        grade: group.grade,
        canonical_difficulty: group.canonical_difficulty,
        game_location: group.game_location,
        confirmed_topic: group.confirmed_topic,
        questions: group.questions,
      };
      const sourceBytes = Buffer.from(JSON.stringify(sourcePayload));
      const fileStem = [
        'client-provided',
        slugify(group.grade),
        slugify(group.canonical_difficulty),
        slugify(group.confirmed_topic),
        fingerprint.slice(0, 12),
      ].join('-');
      return {
        learning_file: {
          title: `Client Provided — ${group.grade} — ${group.canonical_difficulty} — ${group.confirmed_topic}`,
          file_name: `${fileStem}.json`,
          file_url: `database://client-provided/${fingerprint}`,
          grade_level: group.grade,
          difficulty: group.canonical_difficulty,
          math_topic: group.confirmed_topic,
          game_location: group.game_location,
          file_type: 'fixed_questions',
          source: CLIENT_PROVIDED_SOURCE,
          source_label: CLIENT_PROVIDED_LABEL,
          uploaded_by: normalizedActorId,
          file_size: sourceBytes.length,
          published: false,
          generation_status: 'not_applicable',
          publish_status: 'staged',
          source_content_fingerprint: fingerprint,
          source_file_mime_type: 'application/json',
        },
        source_file: {
          bytes: sourceBytes,
          mime_type: 'application/json',
        },
        questions: group.questions.map((question) => ({
          question: question.question_text,
          options: question.choices,
          correct_answer: question.correct_answer,
          grade_level: question.grade,
          difficulty: question.canonical_difficulty,
          math_topic: question.confirmed_topic,
          source: CLIENT_PROVIDED_SOURCE,
          stable_fingerprint: question.stable_fingerprint,
        })),
      };
    });

  return {
    mode: 'reviewed-manifest-import-only',
    production_import_performed: false,
    require_exact_import: true,
    import_actor_id: normalizedActorId,
    proposed_source_label: CLIENT_PROVIDED_LABEL,
    default_user_facing_status: 'Pending',
    operations,
  };
};

const buildClientProvidedImportPlan = (audit, { actorId } = {}) => {
  const normalizedActorId = actorId == null ? null : Number(actorId);
  if (normalizedActorId != null && (!Number.isInteger(normalizedActorId) || normalizedActorId <= 0)) {
    throw new Error('A positive importer actor ID is required.');
  }

  const operations = (audit.records || [])
    .filter((record) => record.import_eligibility === 'READY FOR IMPORT'
      || (record.import_eligibility === undefined && record.classification === 'READY TO IMPORT'))
    .map((record) => ({
      learning_file: {
        title: record.title,
        file_name: record.file_name,
        file_url: `database://client-provided/${record.content_fingerprint}`,
        grade_level: record.grade,
        difficulty: record.difficulty,
        math_topic: record.topic_identifier,
        file_type: 'fixed_questions',
        source: CLIENT_PROVIDED_SOURCE,
        source_label: CLIENT_PROVIDED_LABEL,
        uploaded_by: normalizedActorId,
        file_size: record.source_size_bytes,
        published: false,
        generation_status: 'not_applicable',
        publish_status: 'staged',
        source_content_fingerprint: record.content_fingerprint,
        source_file_mime_type: record.source_file_mime_type || 'application/octet-stream',
      },
      source_file: {
        bytes: record.source_file_bytes || Buffer.from(JSON.stringify(record.questions || [])),
        mime_type: record.source_file_mime_type || 'application/octet-stream',
      },
      questions: (record.questions || []).map((question) => ({
        question: question.question,
        options: question.choices,
        correct_answer: question.answer,
        grade_level: record.grade,
        difficulty: record.difficulty,
        math_topic: record.topic_identifier,
        source: CLIENT_PROVIDED_SOURCE,
      })),
    }));

  return {
    mode: 'explicit-import-only',
    production_import_performed: false,
    import_actor_id: normalizedActorId,
    proposed_source_label: CLIENT_PROVIDED_LABEL,
    default_user_facing_status: 'Pending',
    operations,
  };
};

const inspectClientProvidedImportPlan = async (plan, pool) => {
  if (!pool || typeof pool.connect !== 'function') throw new Error('A PostgreSQL pool is required.');
  const client = await pool.connect();
  const summary = {
    proposed_sets: (plan?.operations || []).length,
    proposed_questions: (plan?.operations || []).reduce((count, operation) => count + operation.questions.length, 0),
    eligible_sets: 0,
    eligible_questions: 0,
    skipped_existing_sets: 0,
    skipped_duplicate_sets: 0,
  };

  try {
    await client.query('BEGIN READ ONLY');
    for (const operation of plan?.operations || []) {
      const existingSet = await client.query(
        'SELECT id FROM public.learning_files WHERE file_url = $1 LIMIT 1',
        [operation.learning_file.file_url]
      );
      if (existingSet.rows.length > 0) {
        summary.skipped_existing_sets += 1;
        continue;
      }

      let duplicateExists = false;
      for (const question of operation.questions) {
        const existingQuestion = await client.query(
          `SELECT id FROM public.questions
           WHERE grade_level = $1 AND difficulty = $2 AND math_topic = $3
             AND question = $4 AND options = $5::jsonb AND correct_answer = $6
           LIMIT 1`,
          [
            question.grade_level,
            question.difficulty,
            question.math_topic,
            question.question,
            JSON.stringify(question.options),
            question.correct_answer,
          ]
        );
        if (existingQuestion.rows.length > 0) {
          duplicateExists = true;
          break;
        }
      }
      if (duplicateExists) {
        summary.skipped_duplicate_sets += 1;
        continue;
      }
      summary.eligible_sets += 1;
      summary.eligible_questions += operation.questions.length;
    }
    await client.query('COMMIT');
    return summary;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const applyClientProvidedImportPlan = async (plan, pool) => {
  if (!pool || typeof pool.connect !== 'function') throw new Error('A PostgreSQL pool is required.');
  const importActorId = Number(plan?.import_actor_id);
  if (!Number.isInteger(importActorId) || importActorId <= 0) {
    throw new Error('A positive importer actor ID is required before applying an import.');
  }
  const client = await pool.connect();
  const summary = {
    imported_sets: 0,
    skipped_existing_sets: 0,
    skipped_duplicate_sets: 0,
    imported_questions: 0,
  };

  try {
    await client.query('BEGIN');
    const actorResult = await client.query(
      `SELECT id, role, is_archived FROM public.accounts
       WHERE id = $1
       LIMIT 1 FOR SHARE`,
      [importActorId]
    );
    const actor = actorResult.rows[0];
    const actorRole = String(actor?.role || '').trim().toLowerCase().replace(/[\s/-]+/g, '_');
    if (!actor || actor.is_archived || !LESSON_MANAGER_IMPORT_ROLES.has(actorRole)) {
      throw new Error('Importer must be an active Admin, Teacher, or Parent/Teacher account.');
    }
    for (const operation of plan.operations || []) {
      const questionSignatures = operation.questions
        .map((question) => canonicalQuestionSignature(question))
        .sort();
      const lockKeys = [operation.learning_file.file_url, ...questionSignatures].sort();
      for (const lockKey of lockKeys) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`client-provided-import:${lockKey}`]);
      }

      const existingSet = await client.query(
        'SELECT id FROM public.learning_files WHERE file_url = $1 LIMIT 1 FOR UPDATE',
        [operation.learning_file.file_url]
      );
      if (existingSet.rows.length > 0) {
        if (plan.require_exact_import) {
          throw new Error(`Reviewed question set ${operation.learning_file.title} is already represented after its approved dry run.`);
        }
        summary.skipped_existing_sets += 1;
        continue;
      }

      let duplicateExists = false;
      for (const question of operation.questions) {
        const existingQuestion = await client.query(
          `SELECT id FROM public.questions
           WHERE grade_level = $1 AND difficulty = $2 AND math_topic = $3
             AND question = $4 AND options = $5::jsonb AND correct_answer = $6
           LIMIT 1`,
          [
            question.grade_level,
            question.difficulty,
            question.math_topic,
            question.question,
            JSON.stringify(question.options),
            question.correct_answer,
          ]
        );
        if (existingQuestion.rows.length > 0) {
          duplicateExists = true;
          break;
        }
      }
      if (duplicateExists) {
        if (plan.require_exact_import) {
          throw new Error(`Reviewed question set ${operation.learning_file.title} has a duplicate question after its approved dry run.`);
        }
        summary.skipped_duplicate_sets += 1;
        continue;
      }

      const file = operation.learning_file;
      const insertedFile = await client.query(
        `INSERT INTO public.learning_files (
          title, file_name, file_url, grade_level, difficulty, math_topic,
          file_type, subject, published, source, uploaded_by, file_size,
          generation_status, publish_status, source_content_fingerprint,
          source_file_bytes, source_file_mime_type
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Mathematics', false, $8, $9, $10, 'not_applicable', 'staged', $11, $12, $13)
        RETURNING id`,
        [
          file.title,
          file.file_name,
          file.file_url,
          file.grade_level,
          file.difficulty,
          file.math_topic,
          file.file_type,
          file.source,
          importActorId,
          file.file_size,
          file.source_content_fingerprint,
          operation.source_file.bytes,
          operation.source_file.mime_type,
        ]
      );
      const learningFileId = insertedFile.rows[0].id;
      for (const question of operation.questions) {
        await client.query(
          `INSERT INTO public.questions (
            learning_file_id, question, options, correct_answer, grade_level,
            difficulty, math_topic, source, published
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)`,
          [
            learningFileId,
            question.question,
            JSON.stringify(question.options),
            question.correct_answer,
            question.grade_level,
            question.difficulty,
            question.math_topic,
            question.source,
          ]
        );
      }
      summary.imported_sets += 1;
      summary.imported_questions += operation.questions.length;
    }
    await client.query('COMMIT');
    return summary;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const parseCliArguments = (argumentsList) => {
  const rootPath = argumentsList.find((argument) => !argument.startsWith('--'));
  const actorArgument = argumentsList.find((argument) => argument.startsWith('--actor-id='));
  const topicOverridesArgument = argumentsList.find((argument) => argument.startsWith('--topic-overrides='));
  const reviewedManifestArgument = argumentsList.find((argument) => argument.startsWith('--reviewed-manifest='));
  return {
    rootPath,
    actorId: actorArgument ? Number(actorArgument.slice('--actor-id='.length)) : null,
    apply: argumentsList.includes('--apply'),
    confirmed: argumentsList.includes('--confirm-client-provided-import'),
    databaseCheck: argumentsList.includes('--database-check'),
    topicOverridesPath: topicOverridesArgument ? topicOverridesArgument.slice('--topic-overrides='.length) : null,
    reviewedManifestPath: reviewedManifestArgument ? reviewedManifestArgument.slice('--reviewed-manifest='.length) : null,
  };
};

const loadTopicOverrides = (topicOverridesPath) => {
  if (!topicOverridesPath) return {};
  const resolvedPath = path.resolve(topicOverridesPath);
  if (!fs.existsSync(resolvedPath)) throw new Error('Topic overrides file does not exist.');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch {
    throw new Error('Topic overrides file must contain valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Topic overrides file must be a JSON object keyed by manifest source path.');
  }
  return parsed;
};

const loadReviewedImportManifest = (reviewedManifestPath) => {
  if (!reviewedManifestPath) throw new Error('A reviewed import manifest path is required.');
  const resolvedPath = path.resolve(reviewedManifestPath);
  if (!fs.existsSync(resolvedPath)) throw new Error('Reviewed import manifest file does not exist.');
  try {
    return JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch {
    throw new Error('Reviewed import manifest must contain valid JSON.');
  }
};

const importDatabaseConnectionString = () => process.env.GODOT_QUESTION_IMPORT_DATABASE_URL
  || process.env.DATABASE_PUBLIC_URL
  || process.env.DATABASE_URL;

const createImportPool = () => {
  const connectionString = importDatabaseConnectionString();
  if (!connectionString) {
    throw new Error('Database inspection or apply requires GODOT_QUESTION_IMPORT_DATABASE_URL or DATABASE_URL.');
  }
  const { Pool } = require('pg');
  return new Pool({ connectionString });
};

const runCli = async () => {
  const options = parseCliArguments(process.argv.slice(2));
  if (options.rootPath && options.reviewedManifestPath) {
    throw new Error('Choose either a Godot Questions path or --reviewed-manifest, not both.');
  }
  if (!options.rootPath && !options.reviewedManifestPath) {
    throw new Error('Usage: node scripts/import-godot-question-bundle.js <path-to-Godot-Questions> [--dry-run] | --reviewed-manifest=<path> [--dry-run]');
  }

  let plan;
  let dryRunMetadata;
  if (options.reviewedManifestPath) {
    const reviewedManifest = loadReviewedImportManifest(options.reviewedManifestPath);
    plan = buildReviewedManifestImportPlan(reviewedManifest, { actorId: options.apply ? options.actorId : null });
    dryRunMetadata = {
      import_source: 'reviewed-manifest',
      manifest_question_count: reviewedManifest.question_count,
      manifest_question_set_count: reviewedManifest.question_set_count,
      topic_inference_performed_during_apply: false,
    };
  } else {
    let audit = auditGodotQuestionBundle(path.resolve(options.rootPath));
    const overrides = loadTopicOverrides(options.topicOverridesPath);
    if (options.topicOverridesPath) audit = applyTopicOverrides(audit, overrides);
    plan = buildClientProvidedImportPlan(audit, { actorId: options.apply ? options.actorId : null });
    dryRunMetadata = {
      import_source: 'bundle-audit',
      files_discovered: audit.files_discovered,
      topic_overrides_applied: Boolean(options.topicOverridesPath),
      excluded_by_classification: audit.classification_distribution,
    };
  }

  if (!options.apply) {
    const result = {
      mode: 'dry-run',
      production_import_performed: false,
      import_actor_id: null,
      proposed_import_count: plan.operations.length,
      proposed_import_question_count: plan.operations.reduce((count, operation) => count + operation.questions.length, 0),
      default_user_facing_status: plan.default_user_facing_status,
      ...dryRunMetadata,
    };
    if (options.databaseCheck) {
      const pool = createImportPool();
      try {
        result.database_check = await inspectClientProvidedImportPlan(plan, pool);
      } finally {
        await pool.end();
      }
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (options.databaseCheck) {
    throw new Error('--database-check is only valid with dry-run mode.');
  }
  if (!options.confirmed) {
    throw new Error('Apply mode requires --confirm-client-provided-import after explicit approval.');
  }
  const pool = createImportPool();
  try {
    const summary = await applyClientProvidedImportPlan(plan, pool);
    console.log(JSON.stringify({
      mode: 'apply',
      database_import_performed: true,
      default_user_facing_status: plan.default_user_facing_status,
      ...dryRunMetadata,
      ...summary,
    }, null, 2));
  } finally {
    await pool.end();
  }
};

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  applyClientProvidedImportPlan,
  buildClientProvidedImportPlan,
  buildReviewedManifestImportPlan,
  importDatabaseConnectionString,
  inspectClientProvidedImportPlan,
  loadReviewedImportManifest,
  loadTopicOverrides,
  parseCliArguments,
};
