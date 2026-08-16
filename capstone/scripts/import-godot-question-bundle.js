#!/usr/bin/env node

// Explicit, approval-gated importer for clean bundled Godot question sets.
// It is never imported by the server and dry-run is the default CLI mode.
const path = require('path');
const { auditGodotQuestionBundle } = require('./audit-godot-question-bundle');

const CLIENT_PROVIDED_SOURCE = 'restored_import';
const CLIENT_PROVIDED_LABEL = 'Client Provided';
const LESSON_MANAGER_IMPORT_ROLES = new Set(['admin', 'teacher', 'parent_teacher']);

const canonicalQuestionSignature = (question) => JSON.stringify({
  question: question.question,
  options: question.choices,
  correct_answer: question.answer,
  topic: question.topic,
});

const buildClientProvidedImportPlan = (audit, { actorId } = {}) => {
  const normalizedActorId = actorId == null ? null : Number(actorId);
  if (normalizedActorId != null && (!Number.isInteger(normalizedActorId) || normalizedActorId <= 0)) {
    throw new Error('A positive importer actor ID is required.');
  }

  const operations = (audit.records || [])
    .filter((record) => record.classification === 'READY TO IMPORT')
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
  return {
    rootPath,
    actorId: actorArgument ? Number(actorArgument.slice('--actor-id='.length)) : null,
    apply: argumentsList.includes('--apply'),
    confirmed: argumentsList.includes('--confirm-client-provided-import'),
  };
};

const runCli = async () => {
  const options = parseCliArguments(process.argv.slice(2));
  if (!options.rootPath) {
    throw new Error('Usage: node scripts/import-godot-question-bundle.js <path-to-Godot-Questions> [--dry-run]');
  }
  const audit = auditGodotQuestionBundle(path.resolve(options.rootPath));
  if (!options.apply) {
    const plan = buildClientProvidedImportPlan(audit);
    console.log(JSON.stringify({
      mode: 'dry-run',
      production_import_performed: false,
      import_actor_id: null,
      files_discovered: audit.files_discovered,
      proposed_import_count: plan.operations.length,
      proposed_import_question_count: plan.operations.reduce((count, operation) => count + operation.questions.length, 0),
      excluded_by_classification: audit.classification_distribution,
      default_user_facing_status: plan.default_user_facing_status,
    }, null, 2));
    return;
  }
  if (!options.confirmed) {
    throw new Error('Apply mode requires --confirm-client-provided-import after explicit approval.');
  }
  if (!process.env.GODOT_QUESTION_IMPORT_DATABASE_URL) {
    throw new Error('Apply mode requires GODOT_QUESTION_IMPORT_DATABASE_URL. Dry-run never opens a database connection.');
  }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.GODOT_QUESTION_IMPORT_DATABASE_URL });
  try {
    const plan = buildClientProvidedImportPlan(audit, { actorId: options.actorId });
    const summary = await applyClientProvidedImportPlan(plan, pool);
    console.log(JSON.stringify({
      mode: 'apply',
      database_import_performed: true,
      default_user_facing_status: plan.default_user_facing_status,
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
  parseCliArguments,
};
