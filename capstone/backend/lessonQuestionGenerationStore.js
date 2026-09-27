const { normalizeQuestion, normalizeQuestionText } = require('./lessonQuestionGenerationWorker');

const GENERATION_LOCK_NAMESPACE = 4819021;
const ACTIVE_GENERATION_STAGES = new Set(['queued', 'extracting', 'generating', 'validating', 'saving']);

const getActualQuestionCount = async (client, learningFileId) => {
  const result = await client.query(
    'SELECT COUNT(*)::INTEGER AS actual_question_count FROM public.questions WHERE learning_file_id = $1',
    [learningFileId],
  );
  return Number(result.rows[0]?.actual_question_count || 0);
};

function createRowBackedQuestionGenerationStore(pool, lockClient) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('a PostgreSQL pool is required');
  if (!lockClient || typeof lockClient.query !== 'function') throw new TypeError('a locked PostgreSQL client is required');

  return {
    async getJob(learningFileId) {
      const result = await lockClient.query(
        `SELECT lf.*, COUNT(q.id)::INTEGER AS actual_question_count
         FROM public.learning_files lf
         LEFT JOIN public.questions q ON q.learning_file_id = lf.id
         WHERE lf.id = $1
         GROUP BY lf.id`,
        [learningFileId],
      );
      return result.rows[0] || null;
    },

    async listQuestions(learningFileId) {
      const result = await lockClient.query(
        `SELECT question, options, correct_answer
         FROM public.questions
         WHERE learning_file_id = $1
         ORDER BY id`,
        [learningFileId],
      );
      return result.rows;
    },

    async setStage(learningFileId, status) {
      if (!ACTIVE_GENERATION_STAGES.has(status)) throw new TypeError('invalid active question generation stage');
      const result = await lockClient.query(
        `WITH actual AS (
          SELECT COUNT(*)::INTEGER AS actual_question_count
          FROM public.questions
          WHERE learning_file_id = $1
        )
        UPDATE public.learning_files lf
        SET generation_status = 'generating',
            generation_stage = $2,
            generation_completed_count = actual.actual_question_count,
            generation_remaining_count = GREATEST(COALESCE(lf.requested_question_count, 0) - actual.actual_question_count, 0),
            generation_retry_count = COALESCE(lf.generation_retry_count, 0) + CASE
              WHEN $2 = 'extracting' AND lf.generation_status IN ('failed', 'partial_failed') THEN 1
              ELSE 0
            END,
            generation_failed_at = NULL,
            generation_error_code = NULL,
            generation_failed_batch_index = NULL
        FROM actual
        WHERE lf.id = $1
          AND lf.source = 'lesson'
          AND lf.content_role = 'question_set'
          AND lf.generation_status <> 'ready_for_review'
        RETURNING lf.*, actual.actual_question_count`,
        [learningFileId, status],
      );
      return result.rows[0] || null;
    },

    async completeIfExact(learningFileId) {
      const result = await lockClient.query(
        `WITH actual AS (
          SELECT COUNT(*)::INTEGER AS actual_question_count
          FROM public.questions
          WHERE learning_file_id = $1
        )
        UPDATE public.learning_files lf
        SET generation_status = 'ready_for_review',
            generation_stage = 'completed',
            generation_completed_count = actual.actual_question_count,
            generation_remaining_count = 0,
            generation_error_code = NULL,
            generation_failed_at = NULL,
            generated_at = COALESCE(lf.generated_at, CURRENT_TIMESTAMP)
        FROM actual
        WHERE lf.id = $1
          AND lf.source = 'lesson'
          AND lf.content_role = 'question_set'
          AND lf.requested_question_count = actual.actual_question_count
        RETURNING lf.*, actual.actual_question_count`,
        [learningFileId],
      );
      return result.rows[0] || null;
    },

    async persistBatchAndProgress(learningFileId, generatedQuestions) {
      const client = lockClient;
      try {
        await client.query('BEGIN');
        const fileResult = await client.query(
          `SELECT id, requested_question_count, grade_level, difficulty, math_topic, topic_id, source, content_role
           FROM public.learning_files
           WHERE id = $1
           FOR UPDATE`,
          [learningFileId],
        );
        const file = fileResult.rows[0];
        if (!file || file.source !== 'lesson' || file.content_role !== 'question_set') {
          throw new Error('Question generation row is unavailable');
        }

        const existingRows = await client.query(
          'SELECT question FROM public.questions WHERE learning_file_id = $1',
          [learningFileId],
        );
        const fingerprints = new Set(existingRows.rows.map((row) => normalizeQuestionText(row.question)).filter(Boolean));
        const actualBefore = existingRows.rows.length;
        const requestedCount = Number(file.requested_question_count);
        const remainingBefore = Math.max(0, requestedCount - actualBefore);
        const accepted = [];
        for (const candidate of generatedQuestions) {
          const question = normalizeQuestion(candidate);
          if (!question) throw new Error('Question batch failed structural validation before persistence');
          const fingerprint = normalizeQuestionText(question.question);
          if (fingerprints.has(fingerprint)) continue;
          if (accepted.length >= remainingBefore) break;
          fingerprints.add(fingerprint);
          accepted.push(question);
        }

        for (const question of accepted) {
          await client.query(
            `INSERT INTO public.questions (
               learning_file_id, question, options, correct_answer, grade_level,
               difficulty, math_topic, topic_id, source, published
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ai', false)`,
            [
              learningFileId,
              question.question,
              JSON.stringify(question.options),
              question.correct_answer,
              file.grade_level,
              file.difficulty,
              file.math_topic || null,
              file.topic_id || null,
            ],
          );
        }

        const actualQuestionCount = await getActualQuestionCount(client, learningFileId);
        if (actualQuestionCount > requestedCount) {
          throw Object.assign(new Error('Saved question count exceeds the requested count'), {
            code: 'QUESTION_AI_COUNT_OVERFLOW',
          });
        }
        const remainingQuestionCount = Math.max(0, requestedCount - actualQuestionCount);
        const generationStatus = actualQuestionCount === requestedCount ? 'ready_for_review' : 'generating';
        const generationStage = actualQuestionCount === requestedCount ? 'completed' : 'generating';
        const updated = await client.query(
          `UPDATE public.learning_files
           SET generation_status = $2,
               generation_stage = $5,
               generation_completed_count = $3,
               generation_remaining_count = $4,
               generation_error_code = NULL,
               generation_failed_at = NULL,
               generation_failed_batch_index = NULL,
               generated_at = CASE WHEN $2 = 'ready_for_review' THEN CURRENT_TIMESTAMP ELSE generated_at END
           WHERE id = $1
           RETURNING id, requested_question_count, generation_completed_count, generation_remaining_count, generation_status`,
          [learningFileId, generationStatus, actualQuestionCount, remainingQuestionCount, generationStage],
        );
        if (!updated.rows[0]) throw new Error('Question generation row disappeared during batch persistence');
        await client.query('COMMIT');
        return {
          actualQuestionCount,
          requestedCount,
          remainingQuestionCount,
          status: generationStatus,
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    },

    async markFailed(learningFileId, failureCode, failedBatchIndex = null) {
      const result = await lockClient.query(
        `WITH actual AS (
          SELECT COUNT(*)::INTEGER AS actual_question_count
          FROM public.questions
          WHERE learning_file_id = $1
        )
        UPDATE public.learning_files lf
        SET generation_status = CASE
              WHEN actual.actual_question_count = lf.requested_question_count THEN 'ready_for_review'
              WHEN actual.actual_question_count > 0 THEN 'partial_failed'
              ELSE 'failed'
            END,
            generation_stage = CASE
              WHEN actual.actual_question_count = lf.requested_question_count THEN 'completed'
              WHEN actual.actual_question_count > 0 THEN 'partial_failed'
              ELSE 'failed'
            END,
            generation_completed_count = actual.actual_question_count,
            generation_remaining_count = GREATEST(COALESCE(lf.requested_question_count, 0) - actual.actual_question_count, 0),
            generation_error_code = CASE
              WHEN actual.actual_question_count = lf.requested_question_count THEN NULL
              ELSE $2
            END,
            generation_failed_at = CASE
              WHEN actual.actual_question_count = lf.requested_question_count THEN NULL
              ELSE CURRENT_TIMESTAMP
            END,
            generation_failed_batch_index = CASE
              WHEN actual.actual_question_count = lf.requested_question_count THEN NULL
              ELSE $3
            END
        FROM actual
        WHERE lf.id = $1
          AND lf.source = 'lesson'
          AND lf.content_role = 'question_set'
        RETURNING lf.*, actual.actual_question_count`,
        [learningFileId, failureCode, failedBatchIndex],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        actualQuestionCount: Number(row.actual_question_count),
        requestedCount: Number(row.requested_question_count),
        remainingQuestionCount: Number(row.generation_remaining_count),
        status: row.generation_status,
        generation_error_code: row.generation_error_code,
      };
    },
  };
}

async function acquireLessonQuestionGenerationLock(pool, learningFileId) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('a PostgreSQL pool is required');
  if (!Number.isSafeInteger(Number(learningFileId)) || Number(learningFileId) < 1) {
    throw new TypeError('learningFileId must be a positive integer');
  }
  const lockClient = await pool.connect();
  try {
    const result = await lockClient.query(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      [GENERATION_LOCK_NAMESPACE, Number(learningFileId)],
    );
    if (result.rows[0]?.acquired !== true) {
      lockClient.release();
      return { acquired: false, store: null, release: async () => {} };
    }
    let released = false;
    return {
      acquired: true,
      store: createRowBackedQuestionGenerationStore(pool, lockClient),
      release: async () => {
        if (released) return;
        released = true;
        try {
          await lockClient.query('SELECT pg_advisory_unlock($1, $2)', [GENERATION_LOCK_NAMESPACE, Number(learningFileId)]);
        } finally {
          lockClient.release();
        }
      },
    };
  } catch (error) {
    lockClient.release();
    throw error;
  }
}

module.exports = {
  ACTIVE_GENERATION_STAGES,
  GENERATION_LOCK_NAMESPACE,
  acquireLessonQuestionGenerationLock,
  createRowBackedQuestionGenerationStore,
};
