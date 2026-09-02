const express = require('express');
const cors = require('cors');
const path = require('path');
const dns = require('dns');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const pdfParse = require('pdf-parse');

dns.setDefaultResultOrder('ipv4first');

require('dotenv').config({ path: path.join(__dirname, '.env') });
const pool = require('./database/db');
const {
  normalizeParentCode,
  normalizeStudentCode,
  normalizeGameStudentName,
  buildGameStudentEmail,
  toNullableNumber,
  resolveProgressPercentage,
  resolveAccuracyRate,
} = require('./parentIdGame.utils');
const {
  buildAnnouncementSchemaRepairStatements,
  normalizeAnnouncementPayload,
  normalizeAnnouncementTarget,
  normalizeAnnouncementRole,
  normalizeAnnouncementManagementPayload,
  normalizeAnnouncementActorPayload,
  canManageAnnouncement,
} = require('./announcements.utils');
const {
  buildAccountCreationResponse,
  buildCredentialsEmail,
  resolveCredentialEmailDelivery,
  resolveGeneratedAccountPassword,
} = require('./accountCreation.utils');
const {
  createTemporaryPassword,
  getTemporaryPasswordExpiry,
  isTemporaryPasswordExpired,
} = require('./temporaryPassword.utils');
const {
  buildLoginDeviceSkipLookup,
  buildLoginDeviceSkipUpsert,
  buildLoginAccountLookup,
  buildLoginOtpResponse,
  buildResendOtpResponse,
  normalizeLoginDeviceId,
  normalizeLoginEmail,
  resolveOtpEmailDelivery,
} = require('./loginOtp.utils');
const {
  buildAccountHealthCheckResponse,
  hasTemporaryPasswordCredentialMetadata,
  requiresInitialPasswordSetup,
  serializeUser,
} = require('./accountResponse.utils');
const {
  isValidDifficulty,
  isValidGradeLevel,
  normalizeDifficultyValue,
  parseLessonQuestionCount,
  resolveQuestionPoolScope,
} = require('./learningContentRules.utils');
const {
  CANONICAL_DIFFICULTIES,
  CANONICAL_GRADES,
  getPublicRegistrySnapshot,
  getTopicById,
  normalizeDifficulty,
  normalizeGradeLevel,
  normalizeTopicId,
  resolveLegacyDisplayTopic,
} = require('./curriculumScopeRegistry');
const {
  getPublicSectionRegistrySnapshot,
  resolveCanonicalSection,
} = require('./sectionRegistry');
const {
  QuestionGenerationError,
  generateLessonQuestions,
} = require('./lessonQuestionGeneration');
const {
  LessonTextExtractionError,
  extractLessonText,
  validateLessonUploadFile,
} = require('./lessonTextExtraction');
const {
  detectFixedQuestionDocumentFormat,
  extractFixedQuestionDocument,
  resolveFixedQuestionDocumentMetadata,
  validateFixedQuestionUploadFile,
  validateFixedQuestions,
  validateQuestionSetForReview,
  validateQuestionSetForPublication,
} = require('./fixedQuestionDocument');
const {
  toQuestionSetResponse,
} = require('./questionSetLifecycle.utils');
const {
  buildLearningFileApprovalFingerprint,
  buildPublicationApprovalEligibility,
  isApprovalCurrent,
} = require('./learningFileApproval.utils');
const {
  buildMailDiagnostics,
  buildResendEmailConfig,
  resolveAppUrl,
} = require('./emailTransport.utils');
const {
  buildSafeEmailLogDetails,
  getEmailSendTimeoutMs,
  sendEmailWithProviders,
} = require('./emailDelivery.utils');
const {
  normalizePlaytimeStatus: normalizeMonitoringStatus,
  resolveDifficultyFromScene,
  sortRowsByStudentName,
} = require('./progressScene.utils');
const {
  buildStudentAnalyticsMetrics,
} = require('./studentAnalyticsMetrics.utils');
const {
  buildGroundedInsightInput,
  buildInsightFingerprint,
  generateGroundedStudentInsight,
} = require('./studentAnalyticsInsight.utils');

const app = express();
const port = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production';

const getValidatedActiveParentAccount = async (parentCode) => {
  const result = await pool.query(
    `SELECT id, name, parent_id, role, is_archived
     FROM public.accounts
     WHERE parent_id = $1
       AND LOWER(role) IN ('parent', 'parent_teacher')
     LIMIT 1`,
    [parentCode]
  );

  if (result.rows.length === 0) {
    return { parent: null, error: { status: 404, message: 'Parent ID does not exist.' } };
  }

  const parent = result.rows[0];
  if (Boolean(parent.is_archived)) {
    return { parent: null, error: { status: 403, message: 'Parent account is no longer active.' } };
  }

  return { parent, error: null };
};

app.use(cors());
app.use(express.json());

const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

const upload = multer({ dest: uploadsDir, limits: { fileSize: 30 * 1024 * 1024 } });

const resendEmailConfig = buildResendEmailConfig(process.env);

const logEmailSendEvent = (level, event, { message, options = {}, result = {} }) => {
  const log = typeof console[level] === 'function' ? console[level] : console.log;
  log(event, buildSafeEmailLogDetails({
    env: process.env,
    emailType: options.emailType,
    role: options.role,
    message,
    result,
  }));
};

const sendSystemEmail = async (message, options = {}) => {
  if (options.emailType) {
    logEmailSendEvent('info', 'Email send started', { message, options });
  }

  const result = await sendEmailWithProviders({
    env: process.env,
    message,
    timeoutMs: options.timeoutMs || getEmailSendTimeoutMs(process.env),
    logger: console,
  });

  if (options.emailType) {
    logEmailSendEvent(result.sent ? 'info' : 'warn', result.sent ? 'Email send succeeded' : 'Email send failed', {
      message,
      options,
      result,
    });
  }

  return result.sent;
};

const generateSixDigitCode = () => String(Math.floor(100000 + Math.random() * 900000));

const generateUniqueParentCode = async () => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const code = generateSixDigitCode();
    const existing = await pool.query('SELECT 1 FROM public.accounts WHERE parent_id = $1 LIMIT 1', [code]);
    if (existing.rows.length === 0) return code;
  }
  throw new Error('Unable to generate unique Parent ID');
};

const backfillParentCodes = async () => {
  const result = await pool.query(
    `SELECT id
     FROM public.accounts
     WHERE LOWER(role) IN ('parent', 'parent_teacher')
       AND (parent_id IS NULL OR parent_id = '')`
  );

  for (const row of result.rows) {
    const code = await generateUniqueParentCode();
    await pool.query('UPDATE public.accounts SET parent_id = $1 WHERE id = $2', [code, row.id]);
  }
};

if (resendEmailConfig.enabled) {
  console.log('Resend email delivery configured', buildMailDiagnostics(process.env));
} else if (!resendEmailConfig.enabled) {
  console.error('Email delivery disabled:', resendEmailConfig.reason, buildMailDiagnostics(process.env));
}

const ensureSchema = async () => {
  try {
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS employee_id VARCHAR(50)');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT false');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS temporary_password_issued_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS temporary_password_expires_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS parent_id VARCHAR(6)');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS game_student_id VARCHAR(6)');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS first_name VARCHAR(100)');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS last_name VARCHAR(100)');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS middle_initial VARCHAR(5)');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS grade_level VARCHAR(20)');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS section VARCHAR(50)');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS current_learning_cycle_started_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS current_learning_cycle_version INTEGER NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS progress_archived_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS progress_archived_by INTEGER REFERENCES public.accounts(id) ON DELETE SET NULL');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS progress_archive_reason VARCHAR(1000)');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS session_version INTEGER DEFAULT 0');
    await pool.query('UPDATE public.accounts SET is_archived = false WHERE is_archived IS NULL');
    await pool.query('UPDATE public.accounts SET session_version = 0 WHERE session_version IS NULL');
    await pool.query('UPDATE public.accounts SET current_learning_cycle_version = 0 WHERE current_learning_cycle_version IS NULL');
    await pool.query(`CREATE TABLE IF NOT EXISTS public.login_otp_device_skips (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
      device_id VARCHAR(160) NOT NULL,
      otp_skipped_until TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT login_otp_device_skips_user_device_unique UNIQUE (user_id, device_id)
    );`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_login_otp_device_skips_expiry ON public.login_otp_device_skips(otp_skipped_until)');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS accounts_employee_id_key ON public.accounts(employee_id)');
    await pool.query("UPDATE public.accounts SET parent_id = NULL WHERE parent_id IS NOT NULL AND parent_id !~ '^\\d{6}$'");
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS accounts_parent_id_key ON public.accounts(parent_id) WHERE parent_id IS NOT NULL');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS accounts_game_student_id_key ON public.accounts(game_student_id) WHERE game_student_id IS NOT NULL');
    await backfillParentCodes();
    await pool.query(`CREATE TABLE IF NOT EXISTS public.student_game_progress (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
      student_name VARCHAR(100) NOT NULL,
      grade_level VARCHAR(20),
      current_quest VARCHAR(100),
      score INTEGER DEFAULT 0,
      correct_answers INTEGER DEFAULT 0,
      total_questions INTEGER DEFAULT 0,
      accuracy_rate DECIMAL(5, 2) DEFAULT 0.00,
      progress_percentage DECIMAL(5, 2) DEFAULT 0.00,
      last_played TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`);
    await pool.query('ALTER TABLE public.student_game_progress ADD COLUMN IF NOT EXISTS section CHARACTER VARYING(50)');
    await pool.query('ALTER TABLE public.student_game_progress ADD COLUMN IF NOT EXISTS lesson_progress DECIMAL(5, 2) DEFAULT 0.00');
    await pool.query('ALTER TABLE public.student_game_progress ADD COLUMN IF NOT EXISTS total_quests_completed INTEGER DEFAULT 0');
    await pool.query('ALTER TABLE public.student_game_progress ADD COLUMN IF NOT EXISTS total_play_time INTEGER DEFAULT 0');
    await pool.query('ALTER TABLE public.student_game_progress ADD COLUMN IF NOT EXISTS current_scene TEXT');
    await pool.query('ALTER TABLE public.student_game_progress ADD COLUMN IF NOT EXISTS current_map TEXT');
    await pool.query("ALTER TABLE public.student_game_progress ADD COLUMN IF NOT EXISTS difficulty_level CHARACTER VARYING(20) DEFAULT 'Unknown'");
    await pool.query('CREATE INDEX IF NOT EXISTS idx_student_game_progress_student_id ON public.student_game_progress(student_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_student_game_progress_score ON public.student_game_progress(score DESC)');
    await pool.query(`CREATE TABLE IF NOT EXISTS public.game_results (
      id SERIAL PRIMARY KEY,
      parent_id CHARACTER VARYING(6) NOT NULL,
      student_name CHARACTER VARYING(100) NOT NULL,
      resolved_student_id INTEGER REFERENCES public.accounts(id) ON DELETE SET NULL,
      grade_level CHARACTER VARYING(20),
      difficulty CHARACTER VARYING(20),
      math_topic CHARACTER VARYING(255),
      score INTEGER NOT NULL,
      total_items INTEGER NOT NULL,
      percentage DECIMAL(5, 2) NOT NULL,
      played_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      question_set_id INTEGER,
      is_unlinked BOOLEAN NOT NULL DEFAULT true
    );`);
    await pool.query('ALTER TABLE public.game_results ADD COLUMN IF NOT EXISTS question_set_id INTEGER');
    await pool.query('ALTER TABLE public.game_results ADD COLUMN IF NOT EXISTS playtime_session_id INTEGER');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_game_results_parent_id ON public.game_results(parent_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_game_results_resolved_student_id ON public.game_results(resolved_student_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_game_results_question_set_id ON public.game_results(question_set_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_game_results_playtime_session_id ON public.game_results(playtime_session_id)');
    await pool.query(`CREATE TABLE IF NOT EXISTS public.student_ai_insights (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
      input_fingerprint VARCHAR(64) NOT NULL,
      insight JSONB NOT NULL,
      generated_by INTEGER REFERENCES public.accounts(id) ON DELETE SET NULL,
      generated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      stale_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT student_ai_insights_student_unique UNIQUE (student_id)
    );`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_student_ai_insights_student_stale ON public.student_ai_insights(student_id, stale_at)');
    await pool.query(`CREATE TABLE IF NOT EXISTS public.teacher_student_relationships (
      id SERIAL PRIMARY KEY,
      teacher_id INTEGER NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
      relationship_type VARCHAR(50) NOT NULL DEFAULT 'Parent',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT teacher_student_relationships_unique UNIQUE (teacher_id, student_id, relationship_type)
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS public.activity_logs (
      id SERIAL PRIMARY KEY,
      student_id INTEGER REFERENCES public.accounts(id) ON DELETE CASCADE,
      student_name VARCHAR(255) NOT NULL,
      grade_level VARCHAR(50),
      section VARCHAR(50),
      current_quest VARCHAR(255),
      save_status VARCHAR(50) DEFAULT 'pending',
      total_play_time INTEGER DEFAULT 0,
      last_played TIMESTAMPTZ,
      quest_progress INTEGER DEFAULT 0,
      difficulty_level VARCHAR(50) DEFAULT 'Unknown',
      login_time TIMESTAMPTZ,
      logout_time TIMESTAMPTZ,
      session_date DATE,
      activity_timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      activity_description TEXT,
      role VARCHAR(50),
      status VARCHAR(50),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`);
    await pool.query('ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS lesson_progress DECIMAL(5, 2) DEFAULT 0.00');
    await pool.query('ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS current_scene TEXT');
    await pool.query('ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS current_map TEXT');
    await pool.query('ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS actor_account_id INTEGER REFERENCES public.accounts(id) ON DELETE SET NULL');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_activity_logs_timestamp ON public.activity_logs(activity_timestamp DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_activity_logs_student_name ON public.activity_logs(student_name)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_activity_logs_grade_section ON public.activity_logs(grade_level, section)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_activity_logs_actor_account_id ON public.activity_logs(actor_account_id)');

    await pool.query(`CREATE TABLE IF NOT EXISTS public.playtime_sessions (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL,
      parent_id CHARACTER VARYING(20),
      student_name CHARACTER VARYING(100) NOT NULL,
      grade_level CHARACTER VARYING(50),
      section CHARACTER VARYING(50),
      date_played DATE DEFAULT CURRENT_DATE,
      start_time TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      end_time TIMESTAMPTZ,
      total_playtime_minutes INTEGER DEFAULT 0,
      status CHARACTER VARYING(50) DEFAULT 'Playing',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`);
    await pool.query('ALTER TABLE public.playtime_sessions ADD COLUMN IF NOT EXISTS parent_id CHARACTER VARYING(20)');
    await pool.query('ALTER TABLE public.playtime_sessions ADD COLUMN IF NOT EXISTS section CHARACTER VARYING(50)');
    await pool.query('ALTER TABLE public.playtime_sessions ADD COLUMN IF NOT EXISTS total_playtime_minutes INTEGER DEFAULT 0');
    await pool.query('ALTER TABLE public.playtime_sessions ADD COLUMN IF NOT EXISTS total_playtime_seconds INTEGER DEFAULT 0');
    await pool.query('ALTER TABLE public.playtime_sessions ADD COLUMN IF NOT EXISTS server_started_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.playtime_sessions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.playtime_sessions ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.playtime_sessions ADD COLUMN IF NOT EXISTS session_credential_hash VARCHAR(64)');
    await pool.query('ALTER TABLE public.playtime_sessions ADD COLUMN IF NOT EXISTS learning_cycle_version INTEGER NOT NULL DEFAULT 0');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_playtime_sessions_student_date ON public.playtime_sessions(student_id, date_played)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_playtime_sessions_parent_id ON public.playtime_sessions(parent_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_playtime_sessions_status ON public.playtime_sessions(status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_playtime_sessions_expiry ON public.playtime_sessions(status, expires_at)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_playtime_sessions_student_cycle ON public.playtime_sessions(student_id, learning_cycle_version, status)');

    await pool.query(`CREATE TABLE IF NOT EXISTS public.announcements (
      id SERIAL PRIMARY KEY,
      title VARCHAR(150) NOT NULL,
      message TEXT NOT NULL,
      created_by INTEGER REFERENCES public.accounts(id) ON DELETE SET NULL,
      created_by_role VARCHAR(50) NOT NULL,
      target_role VARCHAR(50) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`);
    for (const statement of buildAnnouncementSchemaRepairStatements()) {
      await pool.query(statement);
    }
    await pool.query('CREATE INDEX IF NOT EXISTS idx_announcements_target_created ON public.announcements(target_role, created_at DESC)');

    await pool.query(`CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
      id SERIAL PRIMARY KEY,
      admin_name VARCHAR(255) NOT NULL,
      action VARCHAR(100) NOT NULL,
      target_user VARCHAR(255) NOT NULL,
      reason TEXT,
      target_account_id INTEGER,
      operation_type VARCHAR(32),
      admin_account_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`);
    await pool.query('ALTER TABLE public.admin_audit_logs ADD COLUMN IF NOT EXISTS reason TEXT');
    await pool.query('ALTER TABLE public.admin_audit_logs ADD COLUMN IF NOT EXISTS target_account_id INTEGER');
    await pool.query('ALTER TABLE public.admin_audit_logs ADD COLUMN IF NOT EXISTS operation_type VARCHAR(32)');
    await pool.query('ALTER TABLE public.admin_audit_logs ADD COLUMN IF NOT EXISTS admin_account_id INTEGER');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at ON public.admin_audit_logs(created_at DESC)');

    await pool.query(`CREATE TABLE IF NOT EXISTS public.folders (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`);
    await pool.query('ALTER TABLE public.folders ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.folders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ');
    await pool.query('UPDATE public.folders SET deleted_at = trashed_at WHERE deleted_at IS NULL AND trashed_at IS NOT NULL');
    await pool.query(`CREATE TABLE IF NOT EXISTS public.learning_files (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_url TEXT NOT NULL,
      grade_level VARCHAR(50) NOT NULL,
      difficulty VARCHAR(20),
      math_topic VARCHAR(100),
      topic_id VARCHAR(100),
      document_topic TEXT,
      file_type VARCHAR(50) NOT NULL,
      subject VARCHAR(50) NOT NULL DEFAULT 'Mathematics',
      folder_id INTEGER REFERENCES public.folders(id) ON DELETE SET NULL,
      published BOOLEAN DEFAULT false,
      source VARCHAR(50) NOT NULL,
      uploaded_by INTEGER REFERENCES public.accounts(id) ON DELETE SET NULL,
      uploaded_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`);
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS file_size BIGINT');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS difficulty VARCHAR(20)');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS topic_id VARCHAR(100)');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS requested_question_count INTEGER');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS generation_status VARCHAR(32)');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS publish_status VARCHAR(32)');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS generation_failed_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS generation_error_code VARCHAR(100)');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS published_by INTEGER REFERENCES public.accounts(id) ON DELETE SET NULL');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS last_fetched_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS source_content_fingerprint VARCHAR(64)');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS source_file_bytes BYTEA');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS source_file_mime_type VARCHAR(100)');
    await pool.query("ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS content_role VARCHAR(32) NOT NULL DEFAULT 'question_set'");
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS source_learning_file_id INTEGER REFERENCES public.learning_files(id) ON DELETE RESTRICT');
    await pool.query(`UPDATE public.learning_files
      SET generation_status = CASE WHEN LOWER(file_type) = 'lesson' THEN 'ready_for_review' ELSE 'not_applicable' END
      WHERE generation_status IS NULL OR BTRIM(generation_status) = ''`);
    await pool.query(`UPDATE public.learning_files
      SET publish_status = CASE WHEN published THEN 'active' ELSE 'staged' END
      WHERE publish_status IS NULL OR BTRIM(publish_status) = ''`);
    await pool.query("ALTER TABLE public.learning_files ALTER COLUMN generation_status SET DEFAULT 'not_applicable'");
    await pool.query("ALTER TABLE public.learning_files ALTER COLUMN publish_status SET DEFAULT 'staged'");
    await pool.query('UPDATE public.learning_files SET deleted_at = trashed_at WHERE deleted_at IS NULL AND trashed_at IS NOT NULL');
    await pool.query(`DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'game_results_question_set_id_fkey'
          AND conrelid = 'public.game_results'::regclass
      ) THEN
        ALTER TABLE public.game_results
          ADD CONSTRAINT game_results_question_set_id_fkey
          FOREIGN KEY (question_set_id)
          REFERENCES public.learning_files(id)
          ON DELETE RESTRICT;
      END IF;
    END $$;`);
    await pool.query(`CREATE TABLE IF NOT EXISTS public.questions (
      id SERIAL PRIMARY KEY,
      learning_file_id INTEGER REFERENCES public.learning_files(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      options JSONB,
      correct_answer TEXT NOT NULL,
      grade_level VARCHAR(50),
      difficulty VARCHAR(20),
      math_topic VARCHAR(100),
      topic_id VARCHAR(100),
      source VARCHAR(50) NOT NULL,
      published BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`);
    await pool.query('ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS difficulty VARCHAR(20)');
    await pool.query('ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS topic_id VARCHAR(100)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_learning_files_published ON public.learning_files(published)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_questions_published ON public.questions(published)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_learning_files_grade_difficulty_topic ON public.learning_files(grade_level, difficulty, math_topic)');
    await pool.query('CREATE INDEX IF NOT EXISTS learning_files_scope_topic_id_index ON public.learning_files(grade_level, difficulty, topic_id) WHERE topic_id IS NOT NULL');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_learning_files_lifecycle ON public.learning_files(generation_status, publish_status)');
    await pool.query('CREATE INDEX IF NOT EXISTS learning_files_source_learning_file_id_index ON public.learning_files(source_learning_file_id) WHERE source_learning_file_id IS NOT NULL');
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_files_client_provided_fingerprint
      ON public.learning_files (source_content_fingerprint)
      WHERE source_content_fingerprint IS NOT NULL
        AND source IN ('restored_import', 'client_provided')`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_questions_grade_difficulty_topic ON public.questions(grade_level, difficulty, math_topic)');
    await pool.query('CREATE INDEX IF NOT EXISTS questions_learning_file_topic_id_index ON public.questions(learning_file_id, topic_id) WHERE topic_id IS NOT NULL');
  } catch (err) {
    console.error('Schema initialization failed:', err.message);
  }
};

ensureSchema();

const generateRandomPassword = () => createTemporaryPassword();

const THIRTY_DAY_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

const normalizeOptionalIsoDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const isExpiredIsoDate = (value, now = new Date()) => {
  if (!value) return false;
  const expiresAt = new Date(value);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt <= now;
};

const createRememberToken = (user, options = {}) => {
  const issuedAt = options.now instanceof Date ? options.now : new Date();
  const sessionExpiresAt = new Date(issuedAt.getTime() + THIRTY_DAY_SESSION_MS);
  return jwt.sign({
    userId: user.id,
    email: user.email,
    role: user.role,
    sessionVersion: Number(user.session_version || 0),
    sessionIssuedAt: issuedAt.toISOString(),
    sessionExpiresAt: sessionExpiresAt.toISOString(),
    otpVerifiedAt: issuedAt.toISOString(),
    otpTrustExpiresAt: normalizeOptionalIsoDate(options.otpTrustExpiresAt),
  }, JWT_SECRET, { expiresIn: '30d' });
};

const SALT_ROUNDS = 10;
const hashPassword = async (plainPassword) => {
  return await bcrypt.hash(plainPassword, SALT_ROUNDS);
};

const comparePassword = async (plainPassword, hashedPassword) => {
  if (!plainPassword || !hashedPassword) return false;
  const isBcryptHash = typeof hashedPassword === 'string' && hashedPassword.startsWith('$2');
  if (isBcryptHash) {
    return await bcrypt.compare(plainPassword, hashedPassword);
  }
  return plainPassword === hashedPassword;
};

const generateDefaultEmail = (name) => {
  const cleaned = (name || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  const suffix = Math.floor(100 + Math.random() * 900);
  return `${cleaned || 'user'}${suffix}@gmail.com`;
};

const generateCredentialsEmail = async (email, password, role, name) => {
  const appUrl = resolveAppUrl(process.env);
  const message = buildCredentialsEmail({ email, password, role, name, appUrl });
  return sendSystemEmail({
    to: email,
    subject: message.subject,
    html: message.html,
  }, {
    emailType: 'credential',
    role,
    timeoutMs: getCredentialEmailTimeoutMs(),
  });
};

const getCredentialEmailTimeoutMs = () => {
  const value = Number(process.env.CREDENTIAL_EMAIL_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 30000;
};

const getOtpEmailTimeoutMs = () => {
  const value = Number(process.env.OTP_EMAIL_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 12000;
};

const verifyRememberToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
};

const extractBearerToken = (req) => {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
};

const resolveAuthenticatedAccountFromToken = async (token) => {
  const payload = verifyRememberToken(token);
  if (!payload?.userId) {
    return { ok: false, reason: 'invalid_token' };
  }
  if (isExpiredIsoDate(payload.sessionExpiresAt)) {
    return { ok: false, reason: 'session_expired' };
  }

  const result = await pool.query('SELECT * FROM public.accounts WHERE id = $1', [payload.userId]);
  const account = result.rows[0];
  if (!account || account.is_archived) {
    return { ok: false, reason: 'account_inactive' };
  }
  if (account.must_change_password === true
    && hasTemporaryPasswordCredentialMetadata(account)
    && isTemporaryPasswordExpired(account.temporary_password_expires_at)) {
    return { ok: false, reason: 'temporary_password_expired' };
  }

  const tokenVersion = Number(payload.sessionVersion || 0);
  const accountVersion = Number(account.session_version || 0);
  if (tokenVersion !== accountVersion) {
    return { ok: false, reason: 'session_version_mismatch' };
  }

  return { ok: true, account, payload };
};

const attachAuthenticatedAccount = async (req, res, next) => {
  const token = extractBearerToken(req);
  if (!token) return next();

  try {
    const authResult = await resolveAuthenticatedAccountFromToken(token);
    if (!authResult.ok) {
      if (authResult.reason === 'temporary_password_expired') {
        return res.status(401).json({
          error: 'Temporary password expired. Contact an administrator to issue a new temporary password.',
        });
      }
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    req.authenticatedUser = authResult.account;
    next();
  } catch (err) {
    console.error('Session token validation failed:', err.message);
    res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
};

const sendOtpEmail = async (email, otp, subject = 'Login Verification Code', role = 'unknown') => {
  return sendSystemEmail({
    to: email,
    subject,
    html: `<div style="font-family: Arial, sans-serif; border: 1px solid #ddd; padding: 20px; border-radius: 10px; background: #f8f9fa;">
              <h2 style="color: #0b2447;">Security Verification</h2>
              <p>Your verification code is:</p>
              <p style="font-size: 32px; font-weight: 700; letter-spacing: 6px; margin: 12px 0;">${otp}</p>
              <p style="color: #444;">This code expires in 3 minutes.</p>
            </div>`,
  }, {
    emailType: 'otp',
    role,
  });
};

const calculateAge = (birthday) => {
  if (!birthday) return 0;
  const birthDate = new Date(birthday);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age -= 1;
  }
  return age;
};

const normalizeAccountRole = (role) => {
  const value = String(role || '').trim().toLowerCase();
  if (['parent/teacher', 'parent-teacher', 'parent teacher', 'parent_teacher'].includes(value)) {
    return 'parent_teacher';
  }
  return value;
};

const WEBSITE_MANAGED_ACCOUNT_ROLES = ['admin', 'teacher', 'parent', 'parent_teacher'];
const isWebsiteManagedAccountRole = (role) => (
  WEBSITE_MANAGED_ACCOUNT_ROLES.includes(normalizeAccountRole(role))
);

const accountHasTeacherAccess = (role) => ['teacher', 'parent_teacher'].includes(normalizeAccountRole(role));
const accountHasParentAccess = (role) => ['parent', 'parent_teacher'].includes(normalizeAccountRole(role));
const PLAYTIME_DAILY_LIMIT_MINUTES = 60;
const PLAYTIME_DAILY_LIMIT_SECONDS = PLAYTIME_DAILY_LIMIT_MINUTES * 60;
const PLAYTIME_SESSION_CREDENTIAL_BYTES = 32;
// A session is only considered present while the game continues to prove it is
// alive. This is deliberately shorter than the 15-second client heartbeat so a
// disconnected client cannot remain "Playing" or consume the daily cap forever.
const PLAYTIME_HEARTBEAT_FRESHNESS_SECONDS = 45;
const PLAYTIME_HEARTBEAT_FRESHNESS_INTERVAL_SQL = `INTERVAL '${PLAYTIME_HEARTBEAT_FRESHNESS_SECONDS} seconds'`;

const getPlaytimeHeartbeatReferenceSql = (tableAlias = '') => (
  `COALESCE(${tableAlias}last_heartbeat_at, ${tableAlias}server_started_at, ${tableAlias}start_time, NOW())`
);

const getPlaytimeHeartbeatStaleSql = (tableAlias = '') => (
  `${getPlaytimeHeartbeatReferenceSql(tableAlias)} < NOW() - ${PLAYTIME_HEARTBEAT_FRESHNESS_INTERVAL_SQL}`
);

const getPlaytimeEffectiveEndSql = (tableAlias = '') => (
  `LEAST(
    NOW(),
    COALESCE(${tableAlias}expires_at, NOW()),
    ${getPlaytimeHeartbeatReferenceSql(tableAlias)} + ${PLAYTIME_HEARTBEAT_FRESHNESS_INTERVAL_SQL}
  )`
);

const getPlaytimePresenceStatusSql = (tableAlias = '') => (
  `CASE
    WHEN ${tableAlias}status = 'Playing'
     AND ${tableAlias}end_time IS NULL
     AND COALESCE(${tableAlias}expires_at, NOW()) > NOW()
     AND NOT (${getPlaytimeHeartbeatStaleSql(tableAlias)})
    THEN 'Playing'
    ELSE 'Offline'
  END`
);

const createPlaytimeSessionCredential = () => crypto
  .randomBytes(PLAYTIME_SESSION_CREDENTIAL_BYTES)
  .toString('hex');

const hashPlaytimeSessionCredential = (credential) => crypto
  .createHash('sha256')
  .update(String(credential || ''))
  .digest('hex');

const hasMatchingPlaytimeSessionCredential = (providedCredential, expectedHash) => {
  if (!providedCredential || !expectedHash) return false;
  const providedHash = Buffer.from(hashPlaytimeSessionCredential(providedCredential), 'hex');
  const storedHash = Buffer.from(String(expectedHash), 'hex');
  return providedHash.length === storedHash.length && crypto.timingSafeEqual(providedHash, storedHash);
};

const toPlaytimeResponse = ({
  session,
  totalPlaytimeSeconds,
  sessionCredential,
  remainingSeconds: remainingSecondsOverride,
  message,
}) => {
  const boundedTotalSeconds = Math.max(0, Math.min(PLAYTIME_DAILY_LIMIT_SECONDS, Number(totalPlaytimeSeconds) || 0));
  const dailyRemainingSeconds = Math.max(0, PLAYTIME_DAILY_LIMIT_SECONDS - boundedTotalSeconds);
  const remainingSeconds = Number.isFinite(Number(remainingSecondsOverride))
    ? Math.max(0, Math.min(dailyRemainingSeconds, Number(remainingSecondsOverride)))
    : dailyRemainingSeconds;
  return {
    success: true,
    session_id: session?.id,
    session,
    total_playtime_today: Math.floor(boundedTotalSeconds / 60),
    total_playtime_seconds: boundedTotalSeconds,
    remaining_minutes: Math.ceil(remainingSeconds / 60),
    remaining_seconds: remainingSeconds,
    daily_limit_minutes: PLAYTIME_DAILY_LIMIT_MINUTES,
    can_play: remainingSeconds > 0,
    expires_at: session?.expires_at || null,
    ...(sessionCredential ? { session_credential: sessionCredential } : {}),
    message,
  };
};

const normalizePlaytimeStatus = (status, fallback = 'Playing') => {
  return normalizeMonitoringStatus(status, fallback);
};

const resolvePositiveInteger = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : NaN;
};

const requireAuthenticatedRoles = (allowedRoles) => (req, res, next) => {
  if (!req.authenticatedUser) {
    return res.status(401).json({ error: 'Authentication is required.' });
  }

  const role = normalizeAccountRole(req.authenticatedUser.role);
  if (!allowedRoles.includes(role)) {
    return res.status(403).json({ error: 'This account cannot access this playtime view.' });
  }

  req.authenticatedRole = role;
  next();
};

const requireLessonQuestionManagerAccess = (req, res, next) => {
  requireAuthenticatedRoles(['admin', 'teacher', 'parent_teacher'])(req, res, () => {
    if (req.authenticatedRole !== 'parent_teacher') return next();

    const scope = String(req.query?.scope || '').trim().toLowerCase();
    if (scope !== 'teacher') {
      return res.status(403).json({
        error: 'Lesson and Question Manager is available only in Teacher scope.',
        code: 'LESSON_MANAGER_TEACHER_SCOPE_REQUIRED',
      });
    }

    next();
  });
};
const requireAnalyticsAccess = requireAuthenticatedRoles(['admin', 'teacher', 'parent', 'parent_teacher']);
const requireParentAnalyticsAccess = requireAuthenticatedRoles(['parent', 'parent_teacher']);

const resolveAnalyticsScope = (req) => {
  const accountId = Number(req.authenticatedUser?.id);
  const role = req.authenticatedRole || normalizeAccountRole(req.authenticatedUser?.role);
  if (!Number.isInteger(accountId) || accountId <= 0) return null;
  if (role === 'admin') return { type: 'all' };
  if (role === 'teacher') return { type: 'teacher', teacherId: accountId };
  if (role === 'parent') return { type: 'parent', parentId: accountId };
  if (role === 'parent_teacher') {
    return String(req.query?.scope || '').trim().toLowerCase() === 'parent'
      ? { type: 'parent', parentId: accountId }
      : { type: 'teacher', teacherId: accountId };
  }
  return null;
};

const appendAnalyticsScopeFilter = ({ scope, params, studentColumn }) => {
  if (scope?.type === 'teacher') return appendTeacherScopeFilter({ teacherId: scope.teacherId, params, studentColumn });
  if (scope?.type === 'parent') return appendParentScopeFilter({ parentId: scope.parentId, params, studentColumn });
  return '';
};

const LEARNING_CYCLE_RESET_REASONS = new Set([
  'New Lesson',
  'Completed Current Lesson',
  'New Grading Period',
  'Testing Data Cleanup',
  'Other',
]);
const MAX_LEARNING_CYCLE_RESET_REASON_LENGTH = 1000;
const resolveLearningCycleResetReason = (body = {}) => {
  const reason = String(body.reason || '').trim();
  const customReason = String(body.custom_reason || '').trim();
  if (!LEARNING_CYCLE_RESET_REASONS.has(reason)) {
    return { error: 'Select a valid reason for reset.' };
  }
  if (reason === 'Other' && !customReason) {
    return { error: 'Provide a reason for Other.' };
  }
  if (customReason.length > MAX_LEARNING_CYCLE_RESET_REASON_LENGTH) {
    return { error: `Reason for reset must be ${MAX_LEARNING_CYCLE_RESET_REASON_LENGTH} characters or fewer.` };
  }
  return {
    reason,
    auditReason: reason === 'Other' ? `Other: ${customReason}` : reason,
  };
};

const LEARNING_CYCLE_ARCHIVE_REASONS = new Set([
  'Graduated',
  'End of School Year',
  'Transferred',
  'No Longer Enrolled',
  'Testing Data Cleanup',
  'Other',
]);
const resolveLearningCycleArchiveReason = (body = {}) => {
  const reason = String(body.reason || '').trim();
  const customReason = String(body.custom_reason || '').trim();
  if (reason === 'New Lesson') {
    return { error: 'Use Reset Progress to start a new lesson.' };
  }
  if (!LEARNING_CYCLE_ARCHIVE_REASONS.has(reason)) {
    return { error: 'Select a valid reason for archive.' };
  }
  if (reason === 'Other' && !customReason) {
    return { error: 'Provide a reason for Other.' };
  }
  if (customReason.length > MAX_LEARNING_CYCLE_RESET_REASON_LENGTH) {
    return { error: `Reason for archive must be ${MAX_LEARNING_CYCLE_RESET_REASON_LENGTH} characters or fewer.` };
  }
  return {
    reason,
    auditReason: reason === 'Other' ? `Other: ${customReason}` : reason,
  };
};

const toLearningCycleDescriptor = (row = {}) => ({
  version: Math.max(0, Number(row.current_learning_cycle_version ?? row.learning_cycle_version ?? 0) || 0),
  started_at: row.current_learning_cycle_started_at || null,
});

const resolveStudentProgressLifecycle = (value) => {
  const lifecycle = String(value || 'active').trim().toLowerCase();
  return ['active', 'archived'].includes(lifecycle) ? lifecycle : null;
};

const getStudentProgressArchivePredicate = (lifecycle = 'active', alias = 'a') => (
  lifecycle === 'archived'
    ? `${alias}.progress_archived_at IS NOT NULL`
    : `${alias}.progress_archived_at IS NULL`
);

const getLifecycleMutationScope = (req, { allowParentSingle = false } = {}) => {
  const scope = resolveAnalyticsScope(req);
  if (scope?.type === 'all' || scope?.type === 'teacher') return scope;
  if (allowParentSingle && scope?.type === 'parent') return scope;
  return null;
};

const resolveBulkLifecycleConfirmation = (body = {}, operation) => {
  const expectedCount = Number(body.expected_count);
  const confirmationPhrase = String(body.confirmation || body.confirmation_phrase || '').trim();
  const requiredPhrase = operation === 'archive' ? 'ARCHIVE' : 'RESET';
  if (!Number.isInteger(expectedCount) || expectedCount < 0) {
    return { error: 'The affected student count is required.' };
  }
  if (confirmationPhrase !== requiredPhrase) {
    return { error: `Type ${requiredPhrase} to confirm this action.` };
  }
  return { expectedCount };
};

const getScopedLifecycleStudents = async (client, scope, { lifecycle = 'active', forUpdate = false } = {}) => {
  const params = [];
  let query = `SELECT a.id, a.name, a.grade_level, a.section,
                      a.current_learning_cycle_version, a.current_learning_cycle_started_at,
                      a.progress_archived_at, a.progress_archive_reason
               FROM public.accounts a
               WHERE LOWER(a.role) = 'student'
                 AND COALESCE(a.is_archived, false) = false
                 AND ${getStudentProgressArchivePredicate(lifecycle, 'a')}`;
  query += appendAnalyticsScopeFilter({ scope, params, studentColumn: 'a.id' });
  query += ' ORDER BY a.id ASC';
  if (forUpdate) query += ' FOR UPDATE';
  return client.query(query, params);
};

const writeStudentLifecycleAudit = async (client, {
  student,
  actor,
  role,
  action,
  reason,
  description,
}) => client.query(
  `INSERT INTO public.activity_logs (
     student_id, student_name, grade_level, section, activity_description,
     actor_account_id, role, status, activity_timestamp
   ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Active', CURRENT_TIMESTAMP)`,
  [
    student.id,
    student.name || 'Student',
    student.grade_level || null,
    student.section || null,
    `${action} — Reason: ${reason}${description ? ` — ${description}` : ''}`,
    actor.id,
    role,
  ]
);

const startFreshLearningCycle = async (client, studentId) => {
  const result = await client.query(
    `UPDATE public.accounts
     SET current_learning_cycle_started_at = CURRENT_TIMESTAMP,
         current_learning_cycle_version = COALESCE(current_learning_cycle_version, 0) + 1,
         progress_archived_at = NULL,
         progress_archived_by = NULL,
         progress_archive_reason = NULL
     WHERE id = $1
     RETURNING current_learning_cycle_started_at, current_learning_cycle_version`,
    [studentId]
  );
  await client.query('DELETE FROM public.student_game_progress WHERE student_id = $1', [studentId]);
  await markStudentInsightStale(client, studentId);
  return toLearningCycleDescriptor(result.rows[0]);
};

const validateProgressLearningCycleLease = async (client, { studentId, sessionId, sessionCredential }) => {
  const accountResult = await client.query(
    `SELECT COALESCE(current_learning_cycle_version, 0) AS current_learning_cycle_version
     FROM public.accounts
     WHERE id = $1
     LIMIT 1`,
    [studentId]
  );
  const currentVersion = Number(accountResult.rows[0]?.current_learning_cycle_version ?? 0);
  // Legacy cycle-zero clients did not attach a lease to progress writes. They
  // remain compatible until the Student's lifecycle has advanced.
  if (currentVersion === 0 && (!sessionId || !sessionCredential)) return { ok: true };
  if (!sessionId || !sessionCredential) {
    return {
      ok: false,
      status: 409,
      body: {
        code: 'LEARNING_CYCLE_CHANGED',
        error: 'Progress must be saved from a current learning-cycle playtime session.',
      },
    };
  }
  const sessionResult = await client.query(
    `SELECT id,
            session_credential_hash,
            COALESCE(learning_cycle_version, 0) AS learning_cycle_version,
            (${getPlaytimeHeartbeatStaleSql()}) AS heartbeat_stale
     FROM public.playtime_sessions
     WHERE id = $1
       AND student_id = $2
       AND status = 'Playing'
       AND expires_at > NOW()
     LIMIT 1`,
    [sessionId, studentId]
  );
  const session = sessionResult.rows[0];
  if (!session || !hasMatchingPlaytimeSessionCredential(sessionCredential, session.session_credential_hash)) {
    return { ok: false, status: 403, body: { error: 'The active playtime session is invalid.' } };
  }
  if (session.heartbeat_stale) {
    return {
      ok: false,
      status: 409,
      staleSessionId: sessionId,
      body: {
        code: 'PLAYTIME_HEARTBEAT_STALE',
        error: 'The playtime session is no longer active. Start a new session to continue.',
      },
    };
  }
  if (Number(session.learning_cycle_version ?? 0) !== currentVersion) {
    return {
      ok: false,
      status: 409,
      body: {
        code: 'LEARNING_CYCLE_CHANGED',
        error: 'This progress belongs to a previous learning cycle. Start a new game for the current cycle.',
      },
    };
  }
  return { ok: true };
};

const requireAccountManagementAdmin = (req, res, next) => {
  if (!req.authenticatedUser) {
    return res.status(401).json({ error: 'Authentication is required.' });
  }

  if (normalizeAccountRole(req.authenticatedUser.role) !== 'admin') {
    return res.status(403).json({ error: 'Only admins can manage accounts.' });
  }

  req.authenticatedRole = 'admin';
  next();
};

const isSameAccount = (authenticatedAccount, targetAccount, fallbackTargetId) => {
  const authenticatedId = String(authenticatedAccount?.id ?? '').trim();
  const targetId = String(targetAccount?.id ?? fallbackTargetId ?? '').trim();
  const authenticatedEmail = String(authenticatedAccount?.email || '').trim().toLowerCase();
  const targetEmail = String(targetAccount?.email || '').trim().toLowerCase();

  return Boolean(
    (authenticatedId && targetId && authenticatedId === targetId) ||
    (authenticatedEmail && targetEmail && authenticatedEmail === targetEmail)
  );
};

const countActiveAdminAccounts = async () => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM public.accounts
     WHERE LOWER(role) = 'admin'
       AND COALESCE(is_archived, false) = false`
  );
  return Number(result.rows[0]?.count || 0);
};

const formatAuditTargetUser = (account) => {
  const name = String(account?.name || '').trim();
  const email = String(account?.email || '').trim();
  const id = account?.id !== undefined && account?.id !== null ? String(account.id) : '';
  return name || email || (id ? `Account ${id}` : 'Unknown Account');
};

const writeAdminAuditLog = async (adminAccount, action, targetAccount, options = {}) => {
  const adminName = String(adminAccount?.name || adminAccount?.email || '').trim() || 'Unknown Admin';
  const adminAccountId = Number.isInteger(Number(adminAccount?.id)) ? Number(adminAccount.id) : null;
  const targetUser = formatAuditTargetUser(targetAccount);
  const targetAccountId = Number.isInteger(Number(targetAccount?.id)) ? Number(targetAccount.id) : null;
  const reason = options.reason ? String(options.reason).trim() : null;
  const operationType = options.operationType ? String(options.operationType).trim() : null;
  await pool.query(
    `INSERT INTO public.admin_audit_logs (admin_name, action, target_user, reason, target_account_id, operation_type, admin_account_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [adminName, action, targetUser, reason, targetAccountId, operationType, adminAccountId]
  );
};

const MAX_ACCOUNT_REMOVAL_REASON_LENGTH = 1000;
const resolveAccountRemovalReason = (value) => {
  const reason = String(value || '').trim();
  if (!reason) return { error: 'Reason for deletion is required.' };
  if (reason.length > MAX_ACCOUNT_REMOVAL_REASON_LENGTH) {
    return { error: `Reason for deletion must be ${MAX_ACCOUNT_REMOVAL_REASON_LENGTH} characters or fewer.` };
  }
  return { reason };
};
const normalizeOptionalText = (value) => {
  const normalized = String(value ?? '').trim();
  return normalized || null;
};

const normalizePhilippineMobile = (value) => {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return { mobileNumber: null };
  if (!/^09\d{9}$/.test(normalized)) {
    return { error: 'Mobile number must be in the format 09XXXXXXXXX.' };
  }
  return { mobileNumber: normalized };
};

const resolveMobileNumberForUpdate = (value, storedValue) => {
  if (value === undefined || value === storedValue) {
    return { mobileNumber: storedValue };
  }
  return normalizePhilippineMobile(value);
};

const PARENT_CHILD_GRADE_LEVELS = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'];

const normalizeSchoolSection = (value, { required = false } = {}) => {
  const section = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!section) return required ? { error: 'Section is required.' } : { section: null, sectionKey: null };
  if (section.length > 50) return { error: 'Section must be 50 characters or fewer.' };
  if (!/^[A-Za-z0-9][A-Za-z0-9 .'-]*$/.test(section)) {
    return { error: 'Section may only contain letters, numbers, spaces, periods, apostrophes, or hyphens.' };
  }
  return { section, sectionKey: section.toLowerCase() };
};

const normalizeChildNamePart = (value, label, { required = false, initial = false } = {}) => {
  const normalized = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!normalized) return required ? { error: `${label} is required.` } : { value: null };
  const initialValue = initial ? normalized.replace(/\.$/, '') : normalized;
  if (initial && !/^[A-Za-z]$/.test(initialValue)) {
    return { error: 'Middle initial must be one letter.' };
  }
  if (!initial && (!/^[A-Za-z][A-Za-z' -]*$/.test(initialValue) || initialValue.length > 100)) {
    return { error: `${label} may only contain letters, spaces, apostrophes, or hyphens.` };
  }
  return { value: initialValue };
};

const resolveParentChildProfile = (payload = {}) => {
  const firstName = normalizeChildNamePart(payload.first_name ?? payload.firstName, 'First name', { required: true });
  if (firstName.error) return firstName;
  const lastName = normalizeChildNamePart(payload.last_name ?? payload.lastName, 'Last name', { required: true });
  if (lastName.error) return lastName;
  const middleInitial = normalizeChildNamePart(payload.middle_initial ?? payload.middleInitial, 'Middle initial', { initial: true });
  if (middleInitial.error) return middleInitial;

  const gradeLevel = String(payload.grade_level ?? payload.gradeLevel ?? '').trim();
  if (!gradeLevel) return { error: 'Grade is required.' };
  if (!PARENT_CHILD_GRADE_LEVELS.includes(gradeLevel)) return { error: 'Grade must be between Grade 1 and Grade 6.' };

  const sectionResult = normalizeSchoolSection(payload.section, { required: true });
  if (sectionResult.error) return sectionResult;
  const canonicalSection = resolveCanonicalSection(gradeLevel, sectionResult.section);
  if (!canonicalSection) return { error: `Section is not available for ${gradeLevel}.` };

  const studentId = normalizeStudentCode(payload.student_id ?? payload.studentId ?? payload.game_student_id);
  if (!studentId) {
    return { error: String(payload.student_id ?? payload.studentId ?? payload.game_student_id ?? '').trim()
      ? 'Student ID must be exactly 6 digits.'
      : 'Student ID is required.' };
  }

  const fullName = [firstName.value, middleInitial.value, lastName.value].filter(Boolean).join(' ');
  if (fullName.length > 100) return { error: 'Child name must be 100 characters or fewer.' };

  return {
    firstName: firstName.value,
    lastName: lastName.value,
    middleInitial: middleInitial.value,
    gradeLevel,
    section: canonicalSection,
    studentId,
    fullName,
  };
};

const resolveOptionalBirthday = (birthday) => {
  const normalizedBirthday = normalizeOptionalText(birthday);
  if (normalizedBirthday && calculateAge(normalizedBirthday) < 18) {
    return { error: 'Users must be at least 18 years old' };
  }
  return { birthday: normalizedBirthday };
};

const resolveEmployeeIdForRole = (role, employeeId) => {
  const normalizedEmployeeId = normalizeOptionalText(employeeId);
  if (accountHasTeacherAccess(role) && !normalizedEmployeeId) {
    return { error: 'Employee ID is required for teachers and Parent/Teacher users' };
  }
  if (normalizedEmployeeId && !/^\d+$/.test(normalizedEmployeeId)) {
    return { error: 'Employee ID must contain digits only.' };
  }
  if (normalizedEmployeeId && normalizedEmployeeId.length > 10) {
    return { error: 'Employee ID must be 10 digits or fewer.' };
  }
  return { employeeId: normalizedEmployeeId };
};

const getDefaultSection = (gradeLevel, studentId) => {
  const letters = ['A', 'B', 'C'];
  const gradeKey = String(gradeLevel || '').trim().toLowerCase();
  if (!gradeKey) return 'Section A';
  const index = studentId ? studentId % letters.length : 0;
  return `Section ${letters[index]}`;
};

const normalizeStudentProgressRow = (row) => {
  const totalQuestions = toNullableNumber(row.total_questions);
  const correctAnswers = toNullableNumber(row.correct_answers);
  const incorrectAnswers = totalQuestions === null || correctAnswers === null
    ? null
    : Math.max(0, totalQuestions - correctAnswers);
  const difficultyLevel = resolveDifficultyFromScene(row);
  return {
    ...row,
    section: row.section || null,
    incorrect_answers: incorrectAnswers,
    difficulty: difficultyLevel,
    difficulty_level: difficultyLevel,
  };
};

const normalizeTeacherClassAssignment = (payload = {}) => {
  const gradeLevel = String(payload.grade_level ?? payload.gradeLevel ?? '').trim();
  if (!PARENT_CHILD_GRADE_LEVELS.includes(gradeLevel)) {
    return { error: 'Grade must be between Grade 1 and Grade 6.' };
  }
  const sectionResult = normalizeSchoolSection(payload.section, { required: true });
  if (sectionResult.error) return sectionResult;

  return {
    gradeLevel,
    section: sectionResult.section,
    sectionKey: sectionResult.sectionKey,
  };
};

const buildCanonicalStudentProgressQuery = (lifecycle = 'active') => `
  SELECT p.*,
         a.id AS student_id,
         a.name AS student_name,
         a.email AS student_email,
         a.role AS student_role,
         a.game_student_id,
         a.current_learning_cycle_started_at,
         a.current_learning_cycle_version,
         a.progress_archived_at,
         a.progress_archived_by,
         a.progress_archive_reason,
         COALESCE(NULLIF(a.grade_level, ''), p.grade_level) AS grade_level,
         CASE
           WHEN EXISTS (
             SELECT 1
             FROM public.teacher_student_relationships parent_relationship
             WHERE parent_relationship.student_id = a.id
               AND LOWER(parent_relationship.relationship_type) = 'parent'
           ) THEN NULLIF(a.section, '')
           ELSE COALESCE(NULLIF(a.section, ''), p.section)
         END AS section
  FROM public.accounts a
  LEFT JOIN LATERAL (
    SELECT progress.*
    FROM public.student_game_progress progress
    WHERE progress.student_id = a.id
      AND (
        a.current_learning_cycle_started_at IS NULL
        OR progress.updated_at >= a.current_learning_cycle_started_at
      )
    ORDER BY progress.updated_at DESC NULLS LAST, progress.id DESC
    LIMIT 1
  ) p ON true
  WHERE LOWER(a.role) = 'student'
    AND COALESCE(a.is_archived, false) = false
    AND ${getStudentProgressArchivePredicate(lifecycle, 'a')}
`;

const calculateGameResultPercentage = ({ score, totalItems }) => {
  const scoreValue = toNullableNumber(score);
  const totalItemsValue = toNullableNumber(totalItems);
  if (scoreValue === null || totalItemsValue === null || totalItemsValue <= 0) return null;

  return Math.min(100, Math.max(0, Number(((scoreValue / totalItemsValue) * 100).toFixed(2))));
};

const normalizeGameGradeLevel = (value) => {
  return normalizeGradeLevel(value);
};

const QUESTION_GRADE_LEVELS = CANONICAL_GRADES;
const QUESTION_DIFFICULTIES = CANONICAL_DIFFICULTIES;
const GAME_QUESTION_SET_SIZE = 5;

const resolveCanonicalQuestionScope = ({
  grade_level,
  grade,
  difficulty,
  topic_id,
  math_topic,
  topic,
} = {}) => {
  const poolScope = resolveQuestionPoolScope({ grade_level, grade, difficulty });
  if (!poolScope) return null;
  const rawTopicId = String(topic_id || '').trim();
  const canonicalTopicId = rawTopicId
    ? normalizeTopicId(rawTopicId)
    : resolveLegacyDisplayTopic(poolScope.grade_level, poolScope.difficulty, math_topic || topic);
  return {
    ...poolScope,
    topic_id: canonicalTopicId || null,
    math_topic: canonicalTopicId
      ? getTopicById(canonicalTopicId).display_label
      : String(math_topic || topic || '').trim() || null,
  };
};

const buildQuestionFolderStructure = () => ({
  root: { name: 'Questions', path: 'Questions/' },
  grades: QUESTION_GRADE_LEVELS.map((grade) => ({
    name: grade,
    path: `Questions/${grade}/`,
    godotFolderName: grade.replace(/\s+/g, ''),
    difficulties: QUESTION_DIFFICULTIES.map((difficulty) => ({
      name: difficulty,
      path: `Questions/${grade}/${difficulty}`,
      godotFolderName: difficulty,
    })),
  })),
});

const buildQuestionFolderPath = (gradeLevel, difficulty) => {
  const grade = normalizeGameGradeLevel(gradeLevel);
  const level = normalizeDifficultyValue(difficulty);
  if (!grade) return 'Questions/';
  if (!level) return `Questions/${grade}/`;
  return `Questions/${grade}/${level}`;
};

const canonicalDifficultySql = (columnName) => (
  `CASE
     WHEN LOWER(COALESCE(${columnName}, '')) IN ('normal', 'average', 'medium', 'normal / average') THEN 'Normal'
     WHEN LOWER(COALESCE(${columnName}, '')) IN ('difficult', 'hard') THEN 'Difficult'
     WHEN LOWER(COALESCE(${columnName}, '')) = 'easy' THEN 'Easy'
     ELSE COALESCE(${columnName}, '')
   END`
);

const normalizeLearningFileRow = (row) => {
  const { source_file_bytes, ...safeRow } = row || {};
  const difficulty = normalizeDifficultyValue(safeRow.difficulty);
  return toQuestionSetResponse({
    ...safeRow,
    difficulty,
    folder_name: isLessonSourceRecord(safeRow) ? null : buildQuestionFolderPath(safeRow.grade_level, difficulty),
  });
};

const requireWebsiteManagedAccount = requireAuthenticatedRoles(WEBSITE_MANAGED_ACCOUNT_ROLES);

const validateWebsitePassword = (value) => {
  const password = String(value || '');
  if (password.trim().length < 12) {
    return 'Password must be at least 12 characters.';
  }
  return null;
};

const replaceAccountPassword = async ({ account, newPassword, requireTemporaryPassword }) => {
  const passwordError = validateWebsitePassword(newPassword);
  if (passwordError) {
    const error = new Error(passwordError);
    error.statusCode = 400;
    throw error;
  }

  if (requireTemporaryPassword) {
    if (!requiresInitialPasswordSetup(account)) {
      if (account.must_change_password === true
        && hasTemporaryPasswordCredentialMetadata(account)
        && isTemporaryPasswordExpired(account.temporary_password_expires_at)) {
        const error = new Error('Temporary password expired. Contact an administrator to issue a new temporary password.');
        error.statusCode = 401;
        throw error;
      }
      const error = new Error('Password setup is not required for this account.');
      error.statusCode = 400;
      throw error;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hashedPassword = await hashPassword(newPassword);
    const updateResult = await client.query(
      `UPDATE public.accounts
       SET password = $1,
           must_change_password = false,
           temporary_password_issued_at = NULL,
           temporary_password_expires_at = NULL,
           otp_code = NULL,
           otp_expires_at = NULL,
           session_version = COALESCE(session_version, 0) + 1
       WHERE id = $2
       RETURNING *`,
      [hashedPassword, account.id]
    );
    if (updateResult.rows.length === 0) {
      const error = new Error('User not found.');
      error.statusCode = 404;
      throw error;
    }
    await client.query('DELETE FROM public.login_otp_device_skips WHERE user_id = $1', [account.id]);
    await client.query('COMMIT');
    return updateResult.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const resolveScopeId = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? NaN : parsed;
};

const resolveGameResultQuestionSet = async ({ rawQuestionSetId, gradeLevel, difficulty }) => {
  if (rawQuestionSetId === undefined || rawQuestionSetId === null || rawQuestionSetId === '') {
    return { questionSetId: null };
  }

  // Do not let parseInt coerce values such as "77junk" into a valid question-set ID.
  const serializedQuestionSetId = String(rawQuestionSetId).trim();
  if (!/^[1-9]\d*$/.test(serializedQuestionSetId)) {
    return { error: 'question_set_id must be a positive integer.' };
  }
  const questionSetId = Number(serializedQuestionSetId);
  if (!Number.isSafeInteger(questionSetId)) {
    return { error: 'question_set_id must be a positive integer.' };
  }

  const result = await pool.query(
    `SELECT id, grade_level, difficulty, topic_id, math_topic, publish_status
     FROM public.learning_files
     WHERE id = $1
     LIMIT 1`,
    [questionSetId]
  );
  const questionSet = result.rows[0];
  if (!questionSet) return { error: 'Question set was not found.' };

  const setStatus = String(questionSet.publish_status || '').trim().toLowerCase();
  if (!['active', 'superseded'].includes(setStatus)) {
    return { error: 'Question set is not an active or replaced production set.' };
  }

  const submittedScope = resolveQuestionPoolScope({
    grade_level: gradeLevel,
    difficulty,
  });
  const storedScope = resolveQuestionPoolScope(questionSet);
  const matchingScope = submittedScope && storedScope
    && submittedScope.grade_level === storedScope.grade_level
    && submittedScope.difficulty === storedScope.difficulty;
  if (!matchingScope) return { error: 'Question set does not match the submitted result scope.' };

  return { questionSetId };
};

const resolveParentScopeId = (value) => resolveScopeId(value);

const resolveTeacherScopeId = (value) => resolveScopeId(value);

const resolveParentAccountId = async (value) => {
  if (value === undefined || value === null || value === '') return null;

  const valueText = String(value).trim();
  if (!valueText) return null;

  // Godot submits the public six-digit Parent ID.  Resolve that authoritative
  // code before considering the legacy internal numeric account key; otherwise
  // a code that happens to look like an account id can select another parent.
  const parentCode = normalizeParentCode(valueText);
  if (parentCode) {
    const codeMatch = await pool.query(
      `SELECT id
       FROM public.accounts
       WHERE parent_id = $1
         AND LOWER(role) IN ('parent', 'parent_teacher')
         AND COALESCE(is_archived, false) = false
       LIMIT 1`,
      [parentCode]
    );

    return codeMatch.rows[0]?.id ?? null;
  }

  const numericValue = Number.parseInt(valueText, 10);
  if (!Number.isNaN(numericValue)) {
    const directMatch = await pool.query(
      `SELECT id
       FROM public.accounts
       WHERE id = $1
         AND LOWER(role) IN ('parent', 'parent_teacher')
         AND COALESCE(is_archived, false) = false
       LIMIT 1`,
      [numericValue]
    );
    if (directMatch.rows.length > 0) {
      return directMatch.rows[0].id;
    }
  }

  return null;
};

const ensureParentStudentRelationship = async (client, { teacherId, studentId, relationshipType = 'parent' }) => {
  if (!teacherId || !studentId) return null;

  const normalizedRelationshipType = String(relationshipType || 'parent').trim().toLowerCase() || 'parent';
  const existing = await client.query(
    `SELECT id
     FROM public.teacher_student_relationships
     WHERE teacher_id = $1
       AND student_id = $2
       AND LOWER(relationship_type) = $3
     LIMIT 1`,
    [teacherId, studentId, normalizedRelationshipType]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const inserted = await client.query(
    `INSERT INTO public.teacher_student_relationships (teacher_id, student_id, relationship_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (teacher_id, student_id, relationship_type) DO NOTHING
     RETURNING *`,
    [teacherId, studentId, normalizedRelationshipType]
  );

  return inserted.rows[0] ?? { teacher_id: teacherId, student_id: studentId, relationship_type: normalizedRelationshipType };
};

const buildTeacherStudentScopePredicate = ({ teacherPlaceholder, studentColumn }) => `
  EXISTS (
    SELECT 1
    FROM public.accounts scoped_student
    JOIN public.accounts scope_owner
      ON scope_owner.id = ${teacherPlaceholder}
     AND COALESCE(scope_owner.is_archived, false) = false
    WHERE scoped_student.id = ${studentColumn}
      AND COALESCE(scoped_student.is_archived, false) = false
      AND (
        EXISTS (
          SELECT 1
          FROM public.teacher_class_assignments tca
          WHERE tca.teacher_account_id = ${teacherPlaceholder}
            AND tca.grade_level = scoped_student.grade_level
            AND tca.section_key = LOWER(REGEXP_REPLACE(BTRIM(COALESCE(scoped_student.section, '')), '\\s+', ' ', 'g'))
        )
        OR EXISTS (
          SELECT 1
          FROM public.teacher_student_relationships tsr
          WHERE tsr.teacher_id = ${teacherPlaceholder}
            AND tsr.student_id = scoped_student.id
            AND LOWER(tsr.relationship_type) = 'teacher'
        )
      )
  )
`;

const appendTeacherScopeFilter = ({ teacherId, params, studentColumn }) => {
  if (!teacherId) return '';
  params.push(teacherId);
  const teacherPlaceholder = `$${params.length}`;
  return ` AND ${buildTeacherStudentScopePredicate({ teacherPlaceholder, studentColumn })}`;
};

const appendParentScopeFilter = ({ parentId, params, studentColumn, relationshipType = 'parent' }) => {
  if (!parentId) return '';
  params.push(parentId);
  return `
    AND ${studentColumn} IN (
      SELECT tsr.student_id
      FROM public.teacher_student_relationships tsr
      JOIN public.accounts scope_owner
        ON scope_owner.id = tsr.teacher_id
       AND COALESCE(scope_owner.is_archived, false) = false
      WHERE tsr.teacher_id = $${params.length}
        AND LOWER(tsr.relationship_type) = '${relationshipType}'
    )
  `;
};

const normalizeTopAchieverRow = (row, index = 0) => {
  const completion = Number(row.completion_percentage ?? row.progress_percentage ?? 0);
  const accuracy = Number(row.accuracy ?? row.accuracy_rate ?? 0);
  const correctAnswers = Number(row.total_correct_answers ?? row.correct_answers ?? 0);
  const totalQuestions = Number(row.total_questions_answered ?? row.total_questions ?? 0);
  const questsCompleted = Number(row.quests_completed ?? row.total_quests_completed ?? 0);
  const totalPlayTime = Number(row.total_play_time ?? row.duration_seconds ?? 0);

  return {
    ...row,
    rank: index + 1,
    rank_no: index + 1,
    student_name: row.student_name || row.account_student_name || 'Unknown',
    grade_level: row.grade_level || row.grade || null,
    grade: row.grade || row.grade_level || null,
    section: row.section || null,
    completion_percentage: Number.isFinite(completion) ? completion : 0,
    progress_percentage: Number.isFinite(completion) ? completion : 0,
    accuracy: Number.isFinite(accuracy) ? accuracy : 0,
    accuracy_rate: Number.isFinite(accuracy) ? accuracy : 0,
    total_correct_answers: Number.isFinite(correctAnswers) ? correctAnswers : 0,
    correct_answers: Number.isFinite(correctAnswers) ? correctAnswers : 0,
    total_questions_answered: Number.isFinite(totalQuestions) ? totalQuestions : 0,
    total_questions: Number.isFinite(totalQuestions) ? totalQuestions : 0,
    quests_completed: Number.isFinite(questsCompleted) ? questsCompleted : 0,
    total_quests_completed: Number.isFinite(questsCompleted) ? questsCompleted : 0,
    total_play_time: Number.isFinite(totalPlayTime) ? totalPlayTime : 0,
    duration_seconds: Number.isFinite(totalPlayTime) ? totalPlayTime : 0,
  };
};

const verifyParentChildAccess = async (req, res, next) => {
  if (!req.authenticatedUser) {
    return res.status(401).json({ error: 'Authentication is required.' });
  }
  if (!accountHasParentAccess(req.authenticatedUser.role)) {
    return res.status(403).json({ error: 'This account cannot access child analytics.' });
  }

  const parentId = Number(req.authenticatedUser.id);
  const studentId = resolveScopeId(req.params.studentId);

  if (!studentId || Number.isNaN(studentId)) {
    return res.status(400).json({ error: 'A valid student ID is required.' });
  }

  try {
    const relationResult = await pool.query(
      `SELECT 1
       FROM public.teacher_student_relationships tsr
       JOIN public.accounts parent
         ON parent.id = tsr.teacher_id
        AND COALESCE(parent.is_archived, false) = false
       JOIN public.accounts child
         ON child.id = tsr.student_id
        AND COALESCE(child.is_archived, false) = false
       WHERE tsr.teacher_id = $1
         AND tsr.student_id = $2
         AND LOWER(tsr.relationship_type) = 'parent'
       LIMIT 1`,
      [parentId, studentId]
    );

    if (relationResult.rows.length === 0) {
      return res.status(403).json({ error: 'Parent cannot access this child.' });
    }

    req.parentChildAccess = { parentId, studentId };
    next();
  } catch (err) {
    console.error('Parent child access verification failed:', err.message);
    res.status(500).json({ error: 'Failed to verify parent child access.' });
  }
};

const announcementSelectSql = `
  SELECT an.id,
         an.title,
         an.message,
         an.created_by,
         an.created_by_role,
         an.target_role,
         an.created_at,
         COALESCE(a.name, INITCAP(an.created_by_role)) AS posted_by
  FROM public.announcements an
  LEFT JOIN public.accounts a ON a.id = an.created_by
`;

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const shuffleArray = (array) => array.sort(() => Math.random() - 0.5);
const normalizeTopic = (topic) => String(topic || '').toLowerCase();

const ALLOWED_FILE_TYPES = ['lesson', 'fixed_questions'];

const isValidFileType = (value) => ALLOWED_FILE_TYPES.includes(String(value || '').trim().toLowerCase());
const hasAllowedMimeType = (file, allowedTypes) => allowedTypes.includes(String(file?.mimetype || '').toLowerCase());

const validateUploadedLearningFile = (file, fileType) => {
  const originalName = String(file?.originalname || '').toLowerCase();
  if (fileType === 'lesson') {
    try {
      return validateLessonUploadFile(file, fs.readFileSync(file.path));
    } catch {
      return 'The uploaded Lesson source could not be read.';
    }
  }

  if (fileType === 'fixed_questions') {
    const jsonFile = originalName.endsWith('.json')
      && hasAllowedMimeType(file, ['application/json', 'text/json']);
    const csvFile = originalName.endsWith('.csv')
      && hasAllowedMimeType(file, ['text/csv', 'application/csv', 'application/vnd.ms-excel']);
    try {
      const documentValidationError = validateFixedQuestionUploadFile(file, fs.readFileSync(file.path));
      if (!documentValidationError) return '';
      return jsonFile || csvFile ? '' : documentValidationError;
    } catch {
      return 'The uploaded Fixed Question document could not be read.';
    }
  }

  return 'Invalid file type for the selected upload type.';
};

const verifyScopedStudentAnalyticsAccess = async (req, res, next) => {
  const scope = resolveAnalyticsScope(req);
  const studentId = resolveScopeId(req.params.studentId ?? req.params.student_id);

  if (!studentId || Number.isNaN(studentId)) {
    return res.status(400).json({ error: 'A valid student ID is required.' });
  }
  if (scope?.type === 'all') return next();
  if (!scope || !['teacher', 'parent'].includes(scope.type)) {
    return res.status(403).json({ error: 'This account cannot access student analytics.' });
  }

  try {
    const relationResult = scope.type === 'teacher'
      ? await pool.query(
        `SELECT 1
         FROM public.accounts child
         WHERE child.id = $2
           AND ${buildTeacherStudentScopePredicate({ teacherPlaceholder: '$1', studentColumn: 'child.id' })}
         LIMIT 1`,
        [scope.teacherId, studentId]
      )
      : await pool.query(
        `SELECT 1
         FROM public.teacher_student_relationships tsr
         JOIN public.accounts scope_owner
           ON scope_owner.id = tsr.teacher_id
          AND COALESCE(scope_owner.is_archived, false) = false
         JOIN public.accounts child
           ON child.id = tsr.student_id
          AND COALESCE(child.is_archived, false) = false
         WHERE tsr.teacher_id = $1
           AND tsr.student_id = $2
           AND LOWER(tsr.relationship_type) = 'parent'
         LIMIT 1`,
        [scope.parentId, studentId]
      );

    if (relationResult.rows.length === 0) {
      return res.status(403).json({ error: 'This account cannot access this student.' });
    }

    req.scopedStudentAnalyticsAccess = { scope, studentId };
    next();
  } catch (err) {
    console.error('Student analytics access verification failed:', err.message);
    res.status(500).json({ error: 'Failed to verify student analytics access.' });
  }
};

const gradeNumber = (gradeLevel) => {
  const match = String(gradeLevel || '').trim().match(/^Grade\s*(\d+)$/i);
  return match ? Number(match[1]) : null;
};

const buildMathQuestionTemplates = (grade_level, math_topic) => {
  const topic = normalizeTopic(math_topic);
  const gradeNum = gradeNumber(grade_level) || 1;
  const templates = [];

  const pushQuestion = (question, correct, options) => {
    const set = new Set([correct, ...(options || [])]);
    const choices = Array.from(set).slice(0, 4);
    return {
      question,
      options: shuffleArray(choices),
      correct_answer: String(correct),
      grade_level,
      math_topic,
      source: 'ai',
    };
  };

  if (topic.includes('addition')) {
    const maxAdd = gradeNum <= 2 ? 10 : gradeNum <= 4 ? 20 : 30;
    for (let i = 0; i < 5; i += 1) {
      const a = randomInt(1, maxAdd);
      const b = randomInt(1, maxAdd);
      const correct = a + b;
      templates.push(pushQuestion(`What is ${a} + ${b}?`, correct, [correct + 2, Math.max(0, correct - 1), correct + 5]));
    }
  } else if (topic.includes('subtraction')) {
    const maxSub = gradeNum <= 2 ? 10 : gradeNum <= 4 ? 20 : 30;
    for (let i = 0; i < 5; i += 1) {
      const a = randomInt(1, maxSub);
      const b = randomInt(1, Math.min(a, 10));
      const correct = a - b;
      templates.push(pushQuestion(`What is ${a} - ${b}?`, correct, [Math.max(0, correct + 1), Math.max(0, correct - 2), correct + 5]));
    }
  } else if (topic.includes('multiplication')) {
    const maxMul = gradeNum <= 3 ? 6 : gradeNum <= 5 ? 10 : 12;
    for (let i = 0; i < 5; i += 1) {
      const a = randomInt(2, maxMul);
      const b = randomInt(2, maxMul);
      const correct = a * b;
      templates.push(pushQuestion(`What is ${a} × ${b}?`, correct, [correct + a, Math.max(0, correct - b), correct + 4]));
    }
  } else if (topic.includes('division')) {
    const maxDiv = gradeNum <= 3 ? 6 : gradeNum <= 5 ? 10 : 12;
    for (let i = 0; i < 5; i += 1) {
      const b = randomInt(2, maxDiv);
      const correct = randomInt(2, 10);
      const a = correct * b;
      templates.push(pushQuestion(`What is ${a} ÷ ${b}?`, correct, [correct + 1, Math.max(0, correct - 1), correct + 2]));
    }
  } else if (topic.includes('fractions')) {
    templates.push(pushQuestion('Which of these fractions is equal to 1/2?', '2/4', ['1/3', '3/4', '2/3']));
    templates.push(pushQuestion('What is 1/4 + 1/4?', '1/2', ['1/4', '3/4', '2/3']));
    templates.push(pushQuestion('Which fraction is greater: 3/5 or 4/7?', '3/5', ['4/7', '2/5', '1/2']));
  } else if (topic.includes('decimals')) {
    templates.push(pushQuestion('What is 0.5 + 0.25?', '0.75', ['0.65', '0.85', '1.25']));
    templates.push(pushQuestion('Which decimal is largest?', '0.9', ['0.7', '0.65', '0.8']));
    templates.push(pushQuestion('What is 0.2 + 0.3?', '0.5', ['0.4', '0.6', '0.7']));
  } else if (topic.includes('geometry')) {
    templates.push(pushQuestion('How many sides does a rectangle have?', '4', ['3', '5', '6']));
    templates.push(pushQuestion('What is the area formula for a rectangle?', 'length × width', ['2 × width', 'base × height', 'side + side']));
    templates.push(pushQuestion('How many corners does a triangle have?', '3', ['4', '2', '5']));
  } else if (topic.includes('algebra')) {
    templates.push(pushQuestion('Solve for x: x + 5 = 9', '4', ['3', '5', '6']));
    templates.push(pushQuestion('If x = 3 and y = 4, what is x + y?', '7', ['6', '8', '5']));
    templates.push(pushQuestion('What is the value of x if 2x = 10?', '5', ['4', '6', '7']));
  } else if (topic.includes('word') || topic.includes('problem')) {
    const a = randomInt(1, 10);
    const b = randomInt(1, 10);
    templates.push(pushQuestion(`Mia has ${a} apples and buys ${b} more. How many apples does she have now?`, `${a + b}`, [`${a + b + 1}`, `${Math.max(0, a + b - 1)}`, `${a + b + 2}`]));
    templates.push(pushQuestion(`John has ${a + b} toy cars and gives ${b} to his friend. How many cars does he have left?`, `${a}`, [`${a + 1}`, `${Math.max(0, a - 1)}`, `${a + 2}`]));
    templates.push(pushQuestion(`A box contains ${a} red balls and ${b} blue balls. How many balls are there in total?`, `${a + b}`, [`${a + b - 1}`, `${a + b + 1}`, `${a + b + 2}`]));
  } else {
    const a = randomInt(1, 10);
    const b = randomInt(1, 10);
    const c = a + b;
    templates.push(pushQuestion(`What is ${a} + ${b}?`, `${c}`, [`${c + 1}`, `${Math.max(0, c - 1)}`, `${c + 2}`]));
    templates.push(pushQuestion(`What is ${c} - ${a}?`, `${b}`, [`${Math.max(0, b - 1)}`, `${b + 1}`, `${b + 2}`]));
    templates.push(pushQuestion(`What is ${a} × ${b}?`, `${a * b}`, [`${a * b + 2}`, `${Math.max(0, a * b - 1)}`, `${a * b + 3}`]));
  }

  return shuffleArray(templates).slice(0, 6);
};

const saveQuestionsForFile = async (learningFileId, questions, queryClient = pool) => {
  if (!Array.isArray(questions) || questions.length === 0) return;
  const insertPromises = questions.map((item) => queryClient.query(
    `INSERT INTO public.questions (learning_file_id, question, options, correct_answer, grade_level, difficulty, math_topic, topic_id, source, published)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [learningFileId, item.question, JSON.stringify(item.options || []), item.correct_answer, item.grade_level, item.difficulty || null, item.math_topic, item.topic_id || null, item.source || 'ai', false]
  ));
  await Promise.all(insertPromises);
};

const parseFixedQuestionsFile = async (file) => {
  const lowerName = String(file.originalname).toLowerCase();
  if (lowerName.endsWith('.docx') || lowerName.endsWith('.pdf')) {
    const extracted = await extractFixedQuestionDocument(file);
    return extracted.questions;
  }

  const buffer = fs.readFileSync(file.path);
  const content = buffer.toString('utf8');
  if (lowerName.endsWith('.json')) {
    const payload = JSON.parse(content);
    if (!Array.isArray(payload)) throw new Error('JSON must contain an array of questions');
    return payload.map((item) => ({
      question: String(item.question || '').trim(),
      options: Array.isArray(item.options) ? item.options : [],
      correct_answer: String(item.correct_answer || item.answer || '').trim(),
      grade_level: String(item.grade_level || '').trim(),
      math_topic: String(item.math_topic || '').trim(),
      topic_id: String(item.topic_id || '').trim() || null,
      source: 'fixed',
    }));
  }
  if (lowerName.endsWith('.csv')) {
    const rows = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return rows.map((line) => {
      const [question, ...rest] = line.split(',').map((cell) => cell.trim());
      const options = rest.slice(0, 4);
      return {
        question,
        options,
        correct_answer: rest[4] || '',
        grade_level: '',
        math_topic: '',
        topic_id: null,
        source: 'fixed',
      };
    });
  }
  throw new Error('Unsupported fixed question file format');
};

const extractAndValidateFixedQuestionsFile = async (file) => {
  const documentContent = fs.readFileSync(file.path);
  if (detectFixedQuestionDocumentFormat(file, documentContent)) {
    return extractFixedQuestionDocument({ ...file, buffer: documentContent });
  }
  return validateFixedQuestions(await parseFixedQuestionsFile(file));
};

const removeFileFromDisk = (fileUrl) => {
  if (!fileUrl) return;
  const filePath = fileUrl.startsWith('http') ? null : path.join(__dirname, fileUrl.replace('/uploads/', 'uploads/'));
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      console.warn('Failed to delete file from disk:', error.message);
    }
  }
};

const buildLearningFileResponse = (row) => ({
  ...row,
  folder_name: row.folder_name || 'Unassigned',
});

const generateUploadFileName = (originalName) => {
  const timestamp = Date.now();
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${timestamp}_${safeName}`;
};

const buildFileUrl = (fileName) => `/uploads/${fileName}`;
const MAX_LESSON_UPLOAD_BYTES = 30 * 1024 * 1024;
const LESSON_GENERATION_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

const getLessonGenerationIdempotencyKey = (req) => {
  const key = String(req.get('Idempotency-Key') || '').trim();
  return LESSON_GENERATION_IDEMPOTENCY_KEY_PATTERN.test(key) ? key : null;
};

const buildLessonGenerationRequestFingerprint = ({
  actorId,
  sourceLearningFileId = null,
  sourceContentFingerprint,
  gradeLevel,
  difficulty,
  questionCount,
}) => crypto.createHash('sha256').update(JSON.stringify({
  actor_id: Number(actorId),
  source_learning_file_id: Number.isSafeInteger(Number(sourceLearningFileId))
    ? Number(sourceLearningFileId)
    : null,
  source_content_fingerprint: sourceContentFingerprint,
  grade_level: gradeLevel,
  difficulty,
  requested_question_count: questionCount,
})).digest('hex');

const getLessonGenerationWithQuestionCount = async (whereClause, params) => {
  const result = await pool.query(
    `SELECT lf.*, COUNT(q.id)::INTEGER AS question_count
     FROM public.learning_files lf
     LEFT JOIN public.questions q ON q.learning_file_id = lf.id
     WHERE ${whereClause}
     GROUP BY lf.id
     ORDER BY lf.id DESC
     LIMIT 1`,
    params
  );
  return result.rows[0] || null;
};

const getLessonGenerationByIdempotencyKey = (actorId, idempotencyKey) => getLessonGenerationWithQuestionCount(
  `lf.uploaded_by = $1
   AND lf.source = 'lesson'
   AND lf.generation_idempotency_key = $2`,
  [actorId, idempotencyKey]
);

const getInProgressLessonGenerationByFingerprint = (actorId, requestFingerprint) => getLessonGenerationWithQuestionCount(
  `lf.uploaded_by = $1
   AND lf.source = 'lesson'
   AND lf.generation_request_fingerprint = $2
   AND lf.generation_status = 'generating'`,
  [actorId, requestFingerprint]
);

const buildLessonGenerationResponse = (learningFile, { idempotent = false } = {}) => ({
  success: true,
  ...(idempotent ? { idempotent: true } : {}),
  learningFile: normalizeLearningFileRow(learningFile),
});

const respondToExistingLessonGeneration = ({ res, learningFile, requestFingerprint }) => {
  if (learningFile.generation_request_fingerprint !== requestFingerprint) {
    return res.status(409).json({
      error: 'This upload request key is already associated with a different lesson generation request.',
      code: 'AI_GENERATION_IDEMPOTENCY_CONFLICT',
    });
  }
  if (learningFile.generation_status === 'generating') {
    return res.status(202).json({
      ...buildLessonGenerationResponse(learningFile, { idempotent: true }),
      code: 'AI_GENERATION_IN_PROGRESS',
      message: 'Question generation is already in progress for this lesson.',
    });
  }
  if (learningFile.generation_status === 'ready_for_review') {
    return res.status(200).json(buildLessonGenerationResponse(learningFile, { idempotent: true }));
  }
  return res.status(409).json({
    error: 'The previous question generation attempt failed. Submit again to start a new attempt.',
    code: 'AI_GENERATION_RETRY_REQUIRED',
  });
};

const extractLessonTextForGeneration = async ({ filePath, fileName, mimeType }) => {
  try {
    return await extractLessonText({
      path: filePath,
      originalname: fileName,
      mimetype: mimeType,
    }, {
      extractPdfText: async (buffer) => (await pdfParse(buffer)).text,
    });
  } catch (error) {
    if (error instanceof LessonTextExtractionError) {
      const code = error.code === 'LESSON_TEXT_TOO_LARGE' ? 'QUESTION_AI_LESSON_TOO_LARGE' : 'QUESTION_AI_EMPTY_LESSON';
      throw new QuestionGenerationError(code, code === 'QUESTION_AI_LESSON_TOO_LARGE'
        ? 'The readable lesson text exceeds the safe size limit.'
        : 'No readable lesson text was found for question generation.');
    }
    throw new QuestionGenerationError('QUESTION_AI_EMPTY_LESSON', 'No readable lesson text was found for question generation.');
  }
};

const generateQuestionTextFromLesson = async ({ filePath, fileName, mimeType, lessonText = null }, title, grade_level, difficulty, questionCount) => {
  const cleanLessonText = lessonText || await extractLessonTextForGeneration({ filePath, fileName, mimeType });
  return generateLessonQuestions({
    lessonText: cleanLessonText,
    title,
    gradeLevel: grade_level,
    difficulty,
    questionCount,
  });
};

const saveUploadedLearningFile = async ({ title, grade_level, math_topic, file_type, folder_id, uploaded_by, file }) => {
  const fileName = generateUploadFileName(file.originalname);
  const destinationPath = path.join(uploadsDir, fileName);
  fs.renameSync(file.path, destinationPath);
  const fileUrl = buildFileUrl(fileName);
  const source = file_type === 'lesson' ? 'lesson' : 'fixed';

  const result = await pool.query(
    `INSERT INTO public.learning_files (title, file_name, file_url, grade_level, math_topic, file_type, subject, folder_id, published, source, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'Mathematics', $7, false, $8, $9)
     RETURNING *`,
    [title, file.originalname, fileUrl, grade_level, math_topic, file_type, folder_id || null, source, uploaded_by || null]
  );

  return result.rows[0];
};

const createLifecycleHttpError = (message, statusCode) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const isLessonSourceRecord = (learningFile = {}) => String(learningFile.content_role || 'question_set').trim().toLowerCase() === 'lesson_source';

const requireQuestionSetRecord = (learningFile) => {
  if (!isLessonSourceRecord(learningFile)) return;
  const error = createLifecycleHttpError('Lesson source files must generate a scoped question set before they can be reviewed or published.', 409);
  error.code = 'LESSON_SOURCE_NOT_A_QUESTION_SET';
  throw error;
};

const getQuestionSetValidationState = async (queryClient, learningFile, { lockRows = false } = {}) => {
  requireQuestionSetRecord(learningFile);
  const questionResult = await queryClient.query(
    `SELECT id, learning_file_id, question, options, correct_answer, grade_level, difficulty, math_topic, topic_id
     FROM public.questions
     WHERE learning_file_id = $1
     ORDER BY id ASC${lockRows ? ' FOR UPDATE' : ''}`,
    [learningFile.id]
  );
  const canonicalDifficulty = normalizeDifficultyValue(learningFile.difficulty);
  const scopedQuestions = questionResult.rows.map((question, index) => ({
    ...question,
    source_index: index + 1,
    difficulty: normalizeDifficultyValue(question.difficulty),
  }));
  const validationInput = {
    grade_level: learningFile.grade_level,
    difficulty: canonicalDifficulty,
    topic_id: learningFile.topic_id,
    math_topic: learningFile.math_topic,
    questions: scopedQuestions,
  };
  return {
    structural: validateQuestionSetForReview(validationInput),
    publication: validateQuestionSetForPublication({
      grade_level: learningFile.grade_level,
      difficulty: canonicalDifficulty,
      questions: scopedQuestions,
    }),
  };
};

const buildQuestionSetReviewEligibility = (learningFile = {}, validation = {}) => {
  if (validation?.isValid) return { eligible: true, code: 'ELIGIBLE', message: 'Eligible for review approval.' };
  return {
    eligible: false,
    code: 'STRUCTURAL_VALIDATION_FAILED',
    message: 'Review and correct the structural question errors before approval.',
  };
};

const buildQuestionSetPublicationBaseEligibility = (learningFile = {}, validation = {}) => {
  if (!validation?.isValid) {
    return {
      eligible: false,
      code: 'STRUCTURAL_VALIDATION_FAILED',
      message: 'Review and correct this question set before Push to Game.',
    };
  }
  return { eligible: true, code: 'ELIGIBLE', message: 'Eligible for Game publication.' };
};

const buildQuestionSetPublicationEligibility = (learningFile = {}, validationState = {}) => {
  const structuralValidation = validationState?.structural || validationState;
  const publicationValidation = validationState?.publication || validationState;
  const fingerprint = buildLearningFileApprovalFingerprint(learningFile, structuralValidation?.questions || []);
  return buildPublicationApprovalEligibility(
    learningFile,
    fingerprint,
    buildQuestionSetPublicationBaseEligibility(learningFile, publicationValidation)
  );
};

const buildQuestionSetValidationSummary = (validationState, learningFile = {}) => {
  const structuralValidation = validationState?.structural || validationState || {};
  const publicationValidation = validationState?.publication || validationState || {};
  const reviewEligibility = buildQuestionSetReviewEligibility(learningFile, structuralValidation);
  const fingerprint = buildLearningFileApprovalFingerprint(learningFile, structuralValidation?.questions || []);
  return {
    is_valid: Boolean(structuralValidation?.isValid),
    invalid_question_count: (structuralValidation?.questions || []).filter((question) => !question.is_valid).length,
    document_errors: structuralValidation?.document_errors || [],
    publication_errors: publicationValidation?.document_errors || [],
    scope_validation: publicationValidation?.scope_validation || null,
    review_eligibility: reviewEligibility,
    publication_eligibility: buildQuestionSetPublicationEligibility(learningFile, {
      structural: structuralValidation,
      publication: publicationValidation,
    }),
    approval: {
      status: String(learningFile.approval_status || 'review_required'),
      approved_at: learningFile.approved_at || null,
      approved_by: learningFile.approved_by || null,
      is_current: isApprovalCurrent(learningFile, fingerprint),
    },
  };
};

const buildQuestionSetReplacementSummary = (learningFile, questionCount = null) => ({
  id: learningFile.id,
  title: learningFile.generated_question_set_name || learningFile.title || learningFile.file_name || 'Untitled question set',
  grade_level: learningFile.grade_level,
  difficulty: normalizeDifficultyValue(learningFile.difficulty),
  topic_id: learningFile.topic_id || null,
  math_topic: learningFile.math_topic,
  question_count: Number.isInteger(Number(questionCount ?? learningFile.question_count))
    ? Number(questionCount ?? learningFile.question_count)
    : null,
});

const publishLearningFile = async (fileId, publisher, { confirmReplacement = false } = {}) => {
  const publisherId = Number(publisher?.id) || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fileResult = await client.query(
      'SELECT * FROM public.learning_files WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [fileId]
    );
    const learningFile = fileResult.rows[0];
    if (!learningFile) {
      throw createLifecycleHttpError('Uploaded file not found', 404);
    }
    requireQuestionSetRecord(learningFile);

    if (learningFile.generation_status === 'generating') {
      throw createLifecycleHttpError('Question generation is still in progress.', 409);
    }
    if (learningFile.generation_status === 'failed') {
      throw createLifecycleHttpError('Failed question sets must be generated successfully before publishing.', 409);
    }

    const validationState = await getQuestionSetValidationState(client, learningFile, { lockRows: true });
    const publicationValidation = validationState.publication;
    const publicationEligibility = buildQuestionSetPublicationEligibility(learningFile, validationState);
    if (!publicationEligibility.eligible) {
      const requiresReviewApproval = publicationEligibility.code === 'REVIEW_APPROVAL_REQUIRED';
      const error = createLifecycleHttpError(
        requiresReviewApproval
          ? publicationEligibility.message
          : publicationEligibility.message,
        requiresReviewApproval ? 409 : 422
      );
      error.code = requiresReviewApproval ? 'QUESTION_SET_REVIEW_APPROVAL_REQUIRED' : 'QUESTION_SET_VALIDATION_FAILED';
      error.questionValidation = validationState.structural;
      error.publicationEligibility = publicationEligibility;
      throw error;
    }

    const canonicalScope = resolveQuestionPoolScope(learningFile);
    if (!canonicalScope) {
      const error = createLifecycleHttpError('The question set must have a valid Grade and Difficulty before publication.', 422);
      error.code = 'QUESTION_POOL_SCOPE_UNRESOLVED';
      throw error;
    }
    const { grade_level: canonicalGrade, difficulty: canonicalDifficulty } = canonicalScope;
    const scopeKey = `${canonicalGrade}|${canonicalDifficulty}`;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [scopeKey]);

    const destinationParams = [
      canonicalGrade,
      canonicalDifficulty,
      fileId,
    ];
    const learningDifficulty = canonicalDifficultySql('difficulty');
    const linkedLearningDifficulty = canonicalDifficultySql('lf.difficulty');

    const activeScopeResult = await client.query(
      `SELECT lf.id,
              lf.title,
              lf.file_name,
              lf.grade_level,
              lf.difficulty,
              lf.topic_id,
              lf.math_topic,
              COALESCE(question_counts.question_count, 0)::INTEGER AS question_count
       FROM public.learning_files lf
       LEFT JOIN (
         SELECT learning_file_id, COUNT(*)::INTEGER AS question_count
         FROM public.questions
         GROUP BY learning_file_id
       ) question_counts ON question_counts.learning_file_id = lf.id
       WHERE lf.grade_level = $1
         AND ${linkedLearningDifficulty} = $2
         AND lf.id <> $3
         AND lf.subject = 'Mathematics'
         AND lf.deleted_at IS NULL
         AND (lf.published = true OR lf.publish_status = 'active')
       ORDER BY lf.published_at DESC NULLS LAST, lf.uploaded_at DESC, lf.id DESC
       FOR UPDATE`,
      destinationParams
    );
    const activeSets = activeScopeResult.rows;
    if (activeSets.length > 0 && !confirmReplacement) {
      const error = createLifecycleHttpError('An Active question set already exists for this Grade and Difficulty. Confirm replacement before pushing this set to the game.', 409);
      error.code = 'ACTIVE_SET_REPLACEMENT_CONFIRMATION_REQUIRED';
      error.replacement = {
        current_active: buildQuestionSetReplacementSummary(activeSets[0]),
        affected_active: activeSets.map((activeSet) => buildQuestionSetReplacementSummary(activeSet)),
        new_set: buildQuestionSetReplacementSummary(learningFile, publicationValidation.questions.length),
      };
      throw error;
    }

    await client.query(
      `UPDATE public.learning_files
       SET published = false,
           publish_status = 'superseded'
       WHERE grade_level = $1
         AND ${learningDifficulty} = $2
         AND id <> $3
         AND subject = 'Mathematics'
         AND deleted_at IS NULL
         AND (published = true OR publish_status = 'active')`,
      destinationParams
    );
    await client.query(
      `UPDATE public.questions q
       SET published = false
       FROM public.learning_files lf
       WHERE q.learning_file_id = lf.id
         AND lf.grade_level = $1
         AND ${linkedLearningDifficulty} = $2
         AND lf.id <> $3
         AND lf.subject = 'Mathematics'
         AND lf.deleted_at IS NULL
         AND lf.publish_status = 'superseded'`,
      destinationParams
    );
    const publishedResult = await client.query(
      `UPDATE public.learning_files
       SET published = true,
           publish_status = 'active',
           published_at = CURRENT_TIMESTAMP,
           published_by = $2
       WHERE id = $1
       RETURNING *`,
      [fileId, publisherId || null]
    );
    await client.query('UPDATE public.questions SET published = true WHERE learning_file_id = $1', [fileId]);
    await writeQuestionSetPublicationAudit(client, publisher, publishedResult.rows[0] || learningFile, 'published');
    await client.query('COMMIT');
    return normalizeLearningFileRow(publishedResult.rows[0] || learningFile);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const writeQuestionSetApprovalAudit = async (client, actor, learningFile) => {
  const actorName = String(actor?.name || actor?.email || '').trim() || 'Unknown Reviewer';
  const actorId = Number.isInteger(Number(actor?.id)) ? Number(actor.id) : null;
  const target = String(learningFile?.generated_question_set_name || learningFile?.title || learningFile?.file_name || 'Question Set').trim();
  await client.query(
    `INSERT INTO public.admin_audit_logs (
       admin_name, action, target_user, reason, target_account_id, operation_type, admin_account_id, created_at
     ) VALUES ($1, 'Approve Question Set', $2, 'Reviewed question set approved for publication.', $3, 'question_set_approval', $4, NOW())`,
    [actorName, target, Number(learningFile?.id) || null, actorId]
  );
};

const writeQuestionSetPublicationAudit = async (client, actor, learningFile, operation) => {
  const actorName = String(actor?.name || actor?.email || '').trim() || 'Unknown Publisher';
  const actorId = Number.isInteger(Number(actor?.id)) ? Number(actor.id) : null;
  const target = String(learningFile?.generated_question_set_name || learningFile?.title || learningFile?.file_name || 'Question Set').trim();
  const scope = [learningFile?.grade_level, normalizeDifficultyValue(learningFile?.difficulty)].filter(Boolean).join(' / ');

  if (operation === 'published') {
    await client.query(
      `INSERT INTO public.admin_audit_logs (
         admin_name, action, target_user, reason, target_account_id, operation_type, admin_account_id, created_at
       ) VALUES ($1, 'Push Question Set to Game', $2, $3, $4, 'question_set_published', $5, NOW())`,
      [actorName, target, `Published approved question set${scope ? ` for ${scope}` : ''}.`, Number(learningFile?.id) || null, actorId]
    );
    return;
  }

  await client.query(
    `INSERT INTO public.admin_audit_logs (
       admin_name, action, target_user, reason, target_account_id, operation_type, admin_account_id, created_at
     ) VALUES ($1, 'Remove Question Set from Game', $2, $3, $4, 'question_set_unpublished', $5, NOW())`,
    [actorName, target, `Removed active question set from Game${scope ? ` for ${scope}` : ''}.`, Number(learningFile?.id) || null, actorId]
  );
};

const unpublishLearningFile = async (fileId, actor) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fileResult = await client.query(
      'SELECT * FROM public.learning_files WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [fileId]
    );
    const learningFile = fileResult.rows[0];
    if (!learningFile) throw createLifecycleHttpError('Uploaded file not found', 404);
    requireQuestionSetRecord(learningFile);
    if (!(learningFile.published || learningFile.publish_status === 'active')) {
      const error = createLifecycleHttpError('Only an Active in Game question set can be removed from Game.', 409);
      error.code = 'QUESTION_SET_NOT_ACTIVE';
      throw error;
    }

    const unpublishedResult = await client.query(
      `UPDATE public.learning_files
       SET published = false,
           publish_status = 'staged'
       WHERE id = $1
       RETURNING *`,
      [fileId]
    );
    const unpublishedFile = unpublishedResult.rows[0] || {
      ...learningFile,
      published: false,
      publish_status: 'staged',
    };
    await client.query('UPDATE public.questions SET published = false WHERE learning_file_id = $1', [fileId]);
    await writeQuestionSetPublicationAudit(client, actor, unpublishedFile, 'unpublished');
    await client.query('COMMIT');
    return normalizeLearningFileRow(unpublishedFile);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const approveLearningFile = async (fileId, approver) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fileResult = await client.query(
      'SELECT * FROM public.learning_files WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [fileId]
    );
    const learningFile = fileResult.rows[0];
    if (!learningFile) throw createLifecycleHttpError('Uploaded file not found', 404);
    requireQuestionSetRecord(learningFile);
    if (learningFile.published || learningFile.publish_status === 'active') {
      throw createLifecycleHttpError('Active question sets cannot be re-approved. Publish a reviewed replacement instead.', 409);
    }
    if (String(learningFile.approval_status || 'review_required') !== 'review_required') {
      const error = createLifecycleHttpError('This question set is no longer awaiting review approval.', 409);
      error.code = 'QUESTION_SET_REVIEW_STATUS_INVALID';
      throw error;
    }

    const validationState = await getQuestionSetValidationState(client, learningFile, { lockRows: true });
    const validation = validationState.structural;
    const reviewEligibility = buildQuestionSetReviewEligibility(learningFile, validation);
    if (!reviewEligibility.eligible) {
      const error = createLifecycleHttpError(reviewEligibility.message, 422);
      error.code = 'QUESTION_SET_REVIEW_VALIDATION_FAILED';
      error.questionValidation = validation;
      error.reviewEligibility = reviewEligibility;
      throw error;
    }

    const fingerprint = buildLearningFileApprovalFingerprint(learningFile, validation.questions || []);
    const approvedResult = await client.query(
      `UPDATE public.learning_files
       SET approval_status = 'approved',
           approved_at = CURRENT_TIMESTAMP,
           approved_by = $2,
           approved_content_fingerprint = $3
       WHERE id = $1
       RETURNING *`,
      [fileId, Number(approver?.id) || null, fingerprint]
    );
    const approvedFile = approvedResult.rows[0] || learningFile;
    await writeQuestionSetApprovalAudit(client, approver, approvedFile);
    await client.query('COMMIT');
    return {
      learningFile: normalizeLearningFileRow({
        ...approvedFile,
        validation_summary: buildQuestionSetValidationSummary(validationState, approvedFile),
      }),
      validation: buildQuestionSetValidationSummary(validationState, approvedFile),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const buildPublishedQueryClause = (params, { grade_level, math_topic }) => {
  let clause = ' WHERE lf.subject = $1 AND lf.published = true AND lf.deleted_at IS NULL';
  params.push('Mathematics');
  if (grade_level) {
    params.push(grade_level);
    clause += ` AND lf.grade_level = $${params.length}`;
  }
  if (math_topic) {
    params.push(math_topic);
    clause += ` AND lf.math_topic = $${params.length}`;
  }
  return clause;
};

const buildFolderResponse = (row) => row;

const buildLearningFileResponseFromRow = (row) => ({
  ...row,
  folder_name: row.folder_name || 'Unassigned',
});

const buildQuestionResponseByRow = (row) => ({
  id: row.id,
  learning_file_id: row.learning_file_id,
  question: row.question,
  options: row.options,
  correct_answer: row.correct_answer,
  grade_level: row.grade_level,
  math_topic: row.math_topic,
  source: row.source,
  published: row.published,
});

const buildFileRecord = (row) => ({
  ...row,
  file_url: row.file_url,
  folder_name: row.folder_name || 'Unassigned',
});

const updateLearningFileMetadata = async ({ id, title, grade_level, math_topic, file_type, folder_id }) => {
  const result = await pool.query(
    `UPDATE public.learning_files
     SET title = $1,
         grade_level = $2,
         math_topic = $3,
         file_type = $4,
         folder_id = $5
     WHERE id = $6
     RETURNING *`,
    [title, grade_level, math_topic, file_type, folder_id || null, id]
  );
  return result.rows[0];
};

const generateQuestionsForLearningFile = async (learningFile) => {
  const fileRecord = learningFile;
  let questions = [];
  if (fileRecord.file_type === 'lesson') {
    const requestedCount = parseLessonQuestionCount(fileRecord.requested_question_count);
    if (requestedCount.error) throw new Error(requestedCount.error);
    questions = await generateQuestionTextFromLesson(
      {
        filePath: path.join(uploadsDir, fileRecord.file_name),
        fileName: fileRecord.file_name,
        mimeType: fileRecord.source_file_mime_type || 'application/pdf',
      },
      fileRecord.title,
      fileRecord.grade_level,
      fileRecord.difficulty,
      requestedCount.value
    );
  } else {
    questions = await parseFixedQuestionsFile({ path: path.join(uploadsDir, fileRecord.file_name), originalname: fileRecord.file_name });
  }
  await saveQuestionsForFile(fileRecord.id, questions.map((question) => ({
    ...question,
    grade_level: fileRecord.grade_level,
    math_topic: fileRecord.math_topic,
    source: fileRecord.source === 'fixed' ? 'fixed' : 'ai',
  })));
};

const upsertFixedQuestionsBundle = async (learningFile, questions) => {
  await saveQuestionsForFile(learningFile.id, questions.map((item) => ({
    ...item,
    grade_level: learningFile.grade_level,
    math_topic: learningFile.math_topic,
    source: 'fixed',
  })));
};

const cleanTemporaryUpload = (filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.warn('Failed to remove temporary upload file:', err.message);
    }
  }
};

const buildLearningFilesList = (rows) => rows.map((row) => buildFileRecord(row));

const getUploadedFileRecord = async (fileId) => {
  const result = await pool.query(
    `SELECT lf.*, f.name AS folder_name
     FROM public.learning_files lf
     LEFT JOIN public.folders f ON lf.folder_id = f.id
     WHERE lf.id = $1`,
    [fileId]
  );
  return result.rows[0] ? buildFileRecord(result.rows[0]) : null;
};

const generateFilePayload = async ({ title, grade_level, math_topic, file_type, folder_id, uploaded_by, file }) => {
  const fileRecord = await saveUploadedLearningFile({ title, grade_level, math_topic, file_type, folder_id, uploaded_by, file });
  if (file_type === 'lesson') {
    await generateQuestionsForLearningFile(fileRecord);
  } else {
    const fixedQuestions = await parseFixedQuestionsFile(file);
    await upsertFixedQuestionsBundle(fileRecord, fixedQuestions);
  }
  return fileRecord;
};

const finalizeUploadedFile = async (learningFileId) => {
  const fileRecord = await getUploadedFileRecord(learningFileId);
  if (!fileRecord) throw new Error('File record not found');
  return fileRecord;
};

const getPublishedGameData = async ({ grade_level, math_topic }) => {
  const params = [];
  const clause = buildPublishedQueryClause(params, { grade_level, math_topic });
  const filesResult = await pool.query(
    `SELECT lf.*, f.name as folder_name
     FROM public.learning_files lf
     LEFT JOIN public.folders f ON lf.folder_id = f.id
     ${clause}
     ORDER BY lf.uploaded_at DESC`,
    params
  );

  const questionsResult = await pool.query(
    `SELECT q.* FROM public.questions q
     JOIN public.learning_files lf ON q.learning_file_id = lf.id
     WHERE q.published = true
       AND lf.subject = 'Mathematics'
       AND lf.deleted_at IS NULL
       ${grade_level ? `AND q.grade_level = ${params.length + 1}` : ''}
       ${math_topic ? `AND q.math_topic = ${params.length + (grade_level ? 2 : 1)}` : ''}
     ORDER BY q.created_at DESC`
  );

  return {
    learning_files: buildLearningFilesList(filesResult.rows),
    questions: questionsResult.rows.map(buildQuestionResponseByRow),
  };
};

const parseGameQuery = (query) => ({
  grade_level: query.grade_level,
  math_topic: query.math_topic,
});

const validateLearningFileId = async (id) => {
  const file = await getUploadedFileRecord(id);
  if (!file) throw new Error('Uploaded file not found');
  return file;
};

const safeDeleteFolder = async (folderId) => {
  await pool.query('UPDATE public.learning_files SET folder_id = NULL WHERE folder_id = $1', [folderId]);
  await pool.query('DELETE FROM public.folders WHERE id = $1', [folderId]);
};

const createLearningFolder = async (name) => {
  const result = await pool.query(
    `INSERT INTO public.folders (name)
     VALUES ($1)
     RETURNING *`,
    [name]
  );
  return result.rows[0];
};

const editLearningFolder = async (id, name) => {
  const result = await pool.query(
    `UPDATE public.folders
     SET name = $1
     WHERE id = $2
     RETURNING *`,
    [name, id]
  );
  return result.rows[0];
};

const getLearningFolders = async () => {
  const result = await pool.query('SELECT * FROM public.folders ORDER BY name');
  return result.rows.map(buildFolderResponse);
};

const getLearningFiles = async () => {
  const result = await pool.query(
    `SELECT lf.*, f.name as folder_name
     FROM public.learning_files lf
     LEFT JOIN public.folders f ON lf.folder_id = f.id
     ORDER BY lf.uploaded_at DESC`
  );
  return result.rows.map(buildFileRecord);
};

const createQuestionPoolError = (code, message, statusCode = 409) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const resolveActiveGameQuestionSet = async ({ grade_level, grade, difficulty } = {}) => {
  const scope = resolveQuestionPoolScope({ grade_level, grade, difficulty });
  if (!scope) return { scope: null, questionSet: null };
  const result = await pool.query(
    `SELECT id, grade_level, difficulty, topic_id, math_topic
     FROM public.learning_files
     WHERE subject = 'Mathematics'
       AND deleted_at IS NULL
       AND grade_level = $1
       AND ${canonicalDifficultySql('difficulty')} = $2
       AND (published = true OR publish_status = 'active')
     ORDER BY published_at DESC NULLS LAST, uploaded_at DESC, id DESC
     LIMIT 2`,
    [scope.grade_level, scope.difficulty]
  );
  if (result.rows.length > 1) {
    throw createQuestionPoolError(
      'QUESTION_POOL_AMBIGUOUS',
      'Multiple legacy active question sets exist for this Grade and Difficulty. Publish a reviewed replacement set to converge the pool.'
    );
  }
  return { scope, questionSet: result.rows[0] || null };
};

const resolveGameQuestionSetId = async (scope = {}) => {
  const submittedId = Number(scope.question_set_id);
  if (Object.prototype.hasOwnProperty.call(scope, 'question_set_id')) {
    return Number.isSafeInteger(submittedId) && submittedId > 0 ? submittedId : null;
  }
  const { questionSet } = await resolveActiveGameQuestionSet(scope);
  return questionSet?.id || null;
};

const getGameQuestions = async (scope = {}) => {
  const questionSetId = await resolveGameQuestionSetId(scope);
  if (!questionSetId) return [];
  const result = await pool.query(
    `SELECT q.*
     FROM public.questions q
     WHERE q.learning_file_id = $1
       AND q.published = true
     ORDER BY q.created_at DESC`,
    [questionSetId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    learning_file_id: row.learning_file_id,
    question_set_id: row.learning_file_id,
    question: row.question,
    options: row.options,
    correct_answer: row.correct_answer,
    grade: row.grade_level,
    grade_level: row.grade_level,
    difficulty: normalizeDifficultyValue(row.difficulty),
    topic_id: row.topic_id || null,
    math_topic: row.math_topic || null,
    source: row.source,
  }));
};

const finalizeFileUploadRecord = async (fileId) => {
  const record = await getUploadedFileRecord(fileId);
  return record;
};

const buildFileUrlPath = (fileName) => `/uploads/${fileName}`;

const getLearningFileById = async (id) => {
  const result = await pool.query(`SELECT * FROM public.learning_files WHERE id = $1`, [id]);
  return result.rows[0] || null;
};

const getLearningFileQuestions = async (id) => {
  const result = await pool.query('SELECT * FROM public.questions WHERE learning_file_id = $1', [id]);
  return result.rows;
};

const removeLearningFileAndQuestions = async (id) => {
  const file = await getLearningFileById(id);
  await pool.query('DELETE FROM public.questions WHERE learning_file_id = $1', [id]);
  await pool.query('DELETE FROM public.learning_files WHERE id = $1', [id]);
  if (file) removeFileFromDisk(file.file_url);
};

const buildLearningFileMetadataResponse = (row) => ({
  ...row,
  folder_name: row.folder_name || 'Unassigned',
});

const needQuestionParser = async (fileType, file) => {
  if (fileType === 'fixed_questions') {
    return await parseFixedQuestionsFile(file);
  }
  return [];
};

const getGameFiles = async (scope = {}) => {
  const questionSetId = await resolveGameQuestionSetId(scope);
  if (!questionSetId) return [];
  const result = await pool.query(
    'SELECT * FROM public.learning_files WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
    [questionSetId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    file_url: row.file_url,
    grade_level: row.grade_level,
    difficulty: normalizeDifficultyValue(row.difficulty),
    topic_id: row.topic_id || null,
    math_topic: row.math_topic || null,
    file_type: row.file_type,
    published: row.published,
  }));
};

const buildLearningFileView = (row) => ({
  ...row,
  folder_name: row.folder_name || 'Unassigned',
});

const fetchFolders = async () => {
  const result = await pool.query('SELECT * FROM public.folders ORDER BY name ASC');
  return result.rows;
};

const fetchLearningFiles = async () => {
  const result = await pool.query(
    `SELECT lf.*, f.name AS folder_name
     FROM public.learning_files lf
     LEFT JOIN public.folders f ON lf.folder_id = f.id
     ORDER BY lf.uploaded_at DESC`
  );
  return result.rows.map((row) => buildLearningFileView(row));
};

const tryParseJson = (value) => {
  try { return JSON.parse(value); } catch { return null; }
};

const removeTempFile = (pathToRemove) => {
  if (!pathToRemove) return;
  try { fs.unlinkSync(pathToRemove); } catch (err) { /* ignore */ }
};

const mapFileRowToResult = (row) => ({
  ...row,
  folder_name: row.folder_name || 'Unassigned',
});

const mapFolderRowToResult = (row) => ({ id: row.id, name: row.name, created_at: row.created_at });

const mapQuestionRowToResult = (row) => ({
  id: row.id,
  learning_file_id: row.learning_file_id,
  question: row.question,
  options: row.options,
  correct_answer: row.correct_answer,
  grade_level: row.grade_level,
  math_topic: row.math_topic,
  source: row.source,
  published: row.published,
});

const buildFileResponseStatement = (row) => ({ ...row, folder_name: row.folder_name || 'Unassigned' });

const throwNotFound = (message) => { throw new Error(message || 'Not found'); };

const normalizeBoolean = (value) => String(value).toLowerCase() === 'true';

const signalFileNotFound = (id) => `Learning file ${id} does not exist`;

const getGameQueryParams = (req) => ({ grade_level: req.query.grade_level, math_topic: req.query.math_topic });

const confirmFileExists = async (id) => {
  const result = await pool.query('SELECT id FROM public.learning_files WHERE id = $1', [id]);
  if (result.rows.length === 0) throw new Error('Learning file not found');
};

const createUploadRecord = async (form) => {
  const result = await pool.query(
    `INSERT INTO public.learning_files (title, file_name, file_url, grade_level, math_topic, file_type, subject, folder_id, published, source, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'Mathematics', $7, false, $8, $9) RETURNING *`,
    [form.title, form.file_name, form.file_url, form.grade_level, form.math_topic, form.file_type, form.folder_id || null, form.source, form.uploaded_by || null]
  );
  return result.rows[0];
};

const getFileMetadata = async (id) => {
  const result = await pool.query(`SELECT lf.*, f.name as folder_name
    FROM public.learning_files lf
    LEFT JOIN public.folders f ON lf.folder_id = f.id
    WHERE lf.id = $1`, [id]);
  return result.rows[0];
};

const buildPublishedLearningFilesQuery = ({ grade_level, math_topic }) => {
  const params = ['Mathematics'];
  let clause = 'WHERE lf.subject = $1 AND lf.published = true AND lf.deleted_at IS NULL';
  if (grade_level) {
    params.push(grade_level);
    clause += ` AND lf.grade_level = $${params.length}`;
  }
  if (math_topic) {
    params.push(math_topic);
    clause += ` AND lf.math_topic = $${params.length}`;
  }
  return { clause, params };
};

const buildQuestionQuery = ({ grade_level, math_topic }) => {
  const { clause, params } = buildPublishedLearningFilesQuery({ grade_level, math_topic });
  return {
    text: `SELECT q.* FROM public.questions q JOIN public.learning_files lf ON q.learning_file_id = lf.id WHERE q.published = true AND ${clause} ORDER BY q.created_at DESC`,
    params,
  };
};

const buildLearningFileQuery = ({ grade_level, math_topic }) => {
  const { clause, params } = buildPublishedLearningFilesQuery({ grade_level, math_topic });
  return {
    text: `SELECT lf.*, f.name as folder_name FROM public.learning_files lf LEFT JOIN public.folders f ON lf.folder_id = f.id ${clause} ORDER BY lf.uploaded_at DESC`,
    params,
  };
};

const parseLearningFileUpload = (body) => ({
  title: body.title,
  grade_level: body.grade_level,
  math_topic: body.math_topic,
  file_type: body.file_type,
  folder_id: body.folder_id ? parseInt(body.folder_id, 10) : null,
  uploaded_by: body.uploaded_by ? parseInt(body.uploaded_by, 10) : null,
});

const getPostgresSafeId = (value) => {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new Error('Invalid id');
  return parsed;
};

const buildQuestionsPublishQuery = (learningFileId) => ({
  text: 'UPDATE public.questions SET published = true WHERE learning_file_id = $1',
  params: [learningFileId],
});

const buildQuestionsUnpublishQuery = (learningFileId) => ({
  text: 'UPDATE public.questions SET published = false WHERE learning_file_id = $1',
  params: [learningFileId],
});

const buildLearningFileMetadataUpdate = ({ id, title, grade_level, math_topic, file_type, folder_id }) => ({
  text: `UPDATE public.learning_files SET title = $1, grade_level = $2, math_topic = $3, file_type = $4, folder_id = $5 WHERE id = $6 RETURNING *`,
  params: [title, grade_level, math_topic, file_type, folder_id || null, id],
});

const createLearningFileFolder = ({ name }) => ({
  text: 'INSERT INTO public.folders (name) VALUES ($1) RETURNING *',
  params: [name],
});

const renameLearningFileFolder = ({ id, name }) => ({
  text: 'UPDATE public.folders SET name = $1 WHERE id = $2 RETURNING *',
  params: [name, id],
});

const purgeLearningFileFolder = ({ id }) => ({
  text: 'DELETE FROM public.folders WHERE id = $1',
  params: [id],
});

const clearFolderAssignments = ({ id }) => ({
  text: 'UPDATE public.learning_files SET folder_id = NULL WHERE folder_id = $1',
  params: [id],
});

const getPublishedQuestionsForGame = async ({ grade_level, math_topic }) => {
  const { text, params } = buildQuestionQuery({ grade_level, math_topic });
  const result = await pool.query(text, params);
  return result.rows;
};

const getPublishedLearningFilesForGame = async ({ grade_level, math_topic }) => {
  const { text, params } = buildLearningFileQuery({ grade_level, math_topic });
  const result = await pool.query(text, params);
  return result.rows;
};

const getGameResponse = async (query) => ({
  learning_files: await getPublishedLearningFilesForGame(query),
  questions: await getPublishedQuestionsForGame(query),
});

const buildLearningFileResult = (row) => ({
  ...row,
  folder_name: row.folder_name || 'Unassigned',
});

const buildGameQuestionResult = (row) => ({
  ...row,
  options: row.options || [],
});

const getLearningFileResults = async () => {
  const result = await pool.query(`
    SELECT lf.*, f.name AS folder_name
    FROM public.learning_files lf
    LEFT JOIN public.folders f ON lf.folder_id = f.id
    ORDER BY lf.uploaded_at DESC
  `);
  return result.rows.map(buildLearningFileResult);
};

const getFolderResults = async () => {
  const result = await pool.query('SELECT * FROM public.folders ORDER BY name ASC');
  return result.rows;
};

const ensureFileExists = async (id) => {
  const file = await getLearningFileById(id);
  if (!file) throw new Error('Learning file not found');
  return file;
};

// End of helper chain.

const parseUploadPayload = (req) => ({
  title: req.body.title || '',
  grade_level: req.body.grade_level || 'Grade 1',
  math_topic: req.body.math_topic || 'Addition',
  file_type: req.body.file_type || 'lesson',
  folder_id: req.body.folder_id ? parseInt(req.body.folder_id, 10) : null,
  uploaded_by: req.body.uploaded_by ? parseInt(req.body.uploaded_by, 10) : null,
  file: req.file,
});

const buildQuestionResponse = (row) => ({
  ...row,
  options: row.options || [],
});

const buildLearningFileResponseSimple = (row) => ({
  ...row,
  folder_name: row.folder_name || 'Unassigned',
});

const cleanOldTempFile = (pathToClean) => {
  if (pathToClean && fs.existsSync(pathToClean)) {
    try { fs.unlinkSync(pathToClean); } catch (err) { }
  }
};

const runLearningFileInsert = async ({ title, grade_level, math_topic, file_type, folder_id, uploaded_by, file_url, file_name, source }) => {
  const result = await pool.query(
    `INSERT INTO public.learning_files (title, file_name, file_url, grade_level, math_topic, file_type, subject, folder_id, published, source, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,'Mathematics',$7,false,$8,$9) RETURNING *`,
    [title, file_name, file_url, grade_level, math_topic, file_type, folder_id || null, source, uploaded_by || null]
  );
  return result.rows[0];
};

const updateLearningFileRow = async (id, title, grade_level, math_topic, file_type, folder_id) => {
  const result = await pool.query(
    `UPDATE public.learning_files set title=$1, grade_level=$2, math_topic=$3, file_type=$4, folder_id=$5 WHERE id=$6 RETURNING *`,
    [title, grade_level, math_topic, file_type, folder_id || null, id]
  );
  return result.rows[0];
};

const transformFolder = (row) => ({ id: row.id, name: row.name, created_at: row.created_at });

const setLearningFilePublishedFlag = async (id, published) => {
  await pool.query('UPDATE public.learning_files SET published=$1 WHERE id=$2', [published, id]);
};

const setLearningFileQuestionsPublishedFlag = async (id, published) => {
  await pool.query('UPDATE public.questions SET published=$1 WHERE learning_file_id=$2', [published, id]);
};

const getLearningFileJsonRows = async (id) => {
  const result = await pool.query('SELECT * FROM public.questions WHERE learning_file_id = $1', [id]);
  return result.rows;
};

const buildFileView = (row) => ({ ...row, folder_name: row.folder_name || 'Unassigned' });

const transformQuestionRow = (row) => ({
  id: row.id,
  learning_file_id: row.learning_file_id,
  question: row.question,
  options: row.options || [],
  correct_answer: row.correct_answer,
  grade_level: row.grade_level,
  math_topic: row.math_topic,
  source: row.source,
  published: row.published,
});

const getFilePathFromUrl = (url) => (url ? path.join(__dirname, url.replace('/uploads/', 'uploads/')) : null);

const createLearningFileRecord = async ({ title, file_name, file_url, grade_level, math_topic, file_type, folder_id, source, uploaded_by }) => {
  const result = await pool.query(
    `INSERT INTO public.learning_files (title, file_name, file_url, grade_level, math_topic, file_type, subject, folder_id, published, source, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,'Mathematics',$7,false,$8,$9) RETURNING *`,
    [title, file_name, file_url, grade_level, math_topic, file_type, folder_id || null, source, uploaded_by || null]
  );
  return result.rows[0];
};

const storeQuestionsForFile = async (learning_file_id, questions) => {
  const inserts = questions.map((question) => pool.query(
    `INSERT INTO public.questions (learning_file_id, question, options, correct_answer, grade_level, math_topic, source, published) VALUES ($1,$2,$3,$4,$5,$6,$7,false)`,
    [learning_file_id, question.question, JSON.stringify(question.options || []), question.correct_answer, question.grade_level, question.math_topic, question.source]
  ));
  await Promise.all(inserts);
};

const parseUploadedQuestions = async (file) => {
  const buffer = fs.readFileSync(file.path);
  const text = buffer.toString('utf8');
  if (file.originalname.toLowerCase().endsWith('.json')) {
    const payload = JSON.parse(text);
    if (!Array.isArray(payload)) throw new Error('JSON must contain an array of questions');
    return payload.map((row) => ({
      question: String(row.question || '').trim(),
      options: Array.isArray(row.options) ? row.options : [],
      correct_answer: String(row.correct_answer || row.answer || '').trim(),
      grade_level: String(row.grade_level || '').trim(),
      math_topic: String(row.math_topic || '').trim(),
      source: 'fixed',
    })).filter((item) => item.question && item.correct_answer);
  }
  if (file.originalname.toLowerCase().endsWith('.csv')) {
    const rows = text.split(/\r?\n/).filter(Boolean);
    return rows.map((row) => {
      const [question, ...cells] = row.split(',').map((value) => value.trim());
      return {
        question,
        options: cells.slice(0, 4).filter(Boolean),
        correct_answer: cells[0] || '',
        grade_level: '',
        math_topic: '',
        source: 'fixed',
      };
    }).filter((item) => item.question && item.correct_answer);
  }
  throw new Error('Unsupported fixed questions file type');
};

const buildGradeSummary = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }

  const grouped = rows.reduce((acc, item) => {
    const grade = item.grade_level || 'Unknown';
    if (!acc[grade]) acc[grade] = [];
    acc[grade].push(item);
    return acc;
  }, {});

  return Object.entries(grouped).map(([grade, items]) => {
    const averageAvailable = (values) => {
      const available = values
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value));
      return available.length
        ? Math.round(available.reduce((sum, value) => sum + value, 0) / available.length)
        : null;
    };
    const avgAccuracy = averageAvailable(items.map((item) => item.accuracy_rate));
    const avgProgress = averageAvailable(items.map((item) => item.progress_percentage));
    const easyAvg = averageAvailable(items.map((item) => item.analysis?.difficultyBreakdown?.easy));
    const mediumAvg = averageAvailable(items.map((item) => item.analysis?.difficultyBreakdown?.medium));
    const hardAvg = averageAvailable(items.map((item) => item.analysis?.difficultyBreakdown?.hard));

    return {
      grade,
      studentCount: items.length,
      averageAccuracy: avgAccuracy,
      averageProgress: avgProgress,
      difficultyAverage: { easy: easyAvg, medium: mediumAvg, hard: hardAvg },
      students: items.map((item) => ({ id: item.student_id, name: item.student_name, accuracy: item.accuracy_rate })),
    };
  });
};

const generateStudentAnalysis = (record, quizSessions = [], activityLogs = []) => {
  const metrics = buildStudentAnalyticsMetrics({ progress: record, quizSessions });
  return {
    dataAvailability: metrics.totalQuestions === null || metrics.totalQuestions <= 0 ? 'insufficient' : 'available',
    totalCorrectAnswers: metrics.correctAnswers,
    totalIncorrectAnswers: metrics.incorrectAnswers,
    currentQuest: metrics.currentQuest || 'N/A',
    difficultyBreakdown: Object.fromEntries(
      Object.entries(metrics.difficultyBreakdown).map(([difficulty, entry]) => [difficulty, entry.accuracy])
    ),
    strengths: [],
    weaknesses: [],
    recommendations: [],
    engagement: {
      activityCount: activityLogs.length,
      quizSessionCount: quizSessions.length,
    },
  };
};

const buildStudentAnalyticsReadiness = ({ progress, quizSessions = [], activityLogs = [] }) => {
  const normalizedQuizzes = quizSessions.map((quiz) => ({
    topic: quiz.math_topic || 'Unspecified topic',
    difficulty: quiz.difficulty || 'Unknown',
    percentage: Number(quiz.percentage || 0),
    score: Number(quiz.score || 0),
    totalItems: Number(quiz.total_items || 0),
    playedAt: quiz.played_at || null,
  }));

  const topicGroups = normalizedQuizzes.reduce((groups, quiz) => {
    const current = groups[quiz.topic] || { topic: quiz.topic, attempts: 0, bestPercentage: 0, averagePercentage: 0, totalPercentage: 0 };
    const next = {
      ...current,
      attempts: current.attempts + 1,
      bestPercentage: Math.max(current.bestPercentage, quiz.percentage),
      totalPercentage: current.totalPercentage + quiz.percentage,
    };
    next.averagePercentage = Number((next.totalPercentage / next.attempts).toFixed(2));
    return { ...groups, [quiz.topic]: next };
  }, {});

  const topicMastery = Object.values(topicGroups)
    .map(({ totalPercentage, ...topic }) => topic)
    .sort((left, right) => left.averagePercentage - right.averagePercentage);

  const weakTopicCandidates = topicMastery
    .filter((topic) => topic.averagePercentage < 75)
    .slice(0, 5);

  const progressTrend = normalizedQuizzes.slice(-10).map((quiz, index) => ({
    sequence: index + 1,
    topic: quiz.topic,
    difficulty: quiz.difficulty,
    percentage: quiz.percentage,
    playedAt: quiz.playedAt,
  }));

  const lastActivityAt = activityLogs
    .map((log) => log.activity_timestamp || log.last_played)
    .filter(Boolean)
    .sort()
    .at(-1) || null;

  return {
    dataScope: {
      studentId: Number(progress.student_id || progress.id),
      studentName: progress.student_name || progress.name || 'Unknown',
    },
    performanceSignals: {
      currentScore: Number(progress.score || 0),
      accuracyRate: Number(progress.accuracy_rate || progress.performance_percentage || 0),
      progressPercentage: Number(progress.progress_percentage || 0),
      totalQuestions: Number(progress.total_questions || 0),
      correctAnswers: Number(progress.correct_answers || 0),
    },
    topicMastery,
    weakTopicCandidates,
    progressTrend,
    engagement: {
      activityCount: activityLogs.length,
      lastActivityAt,
      quizSessionCount: normalizedQuizzes.length,
    },
    aiIntegration: {
      ready: normalizedQuizzes.length > 0 || activityLogs.length > 0,
      // Future AI services should consume this child-scoped payload only; never mix sibling rows.
      contract: 'child_scoped_learning_signals_v1',
      supportedUseCases: [
        'weak_topic_detection',
        'progress_trend_analysis',
        'study_recommendation_generation',
        'mastery_tracking',
        'engagement_monitoring',
      ],
    },
  };
};

const markLearningFilesFetchedByGame = async (questions) => {
  const fileIds = Array.from(new Set(
    (Array.isArray(questions) ? questions : [])
      .map((question) => Number(question?.learning_file_id))
      .filter((id) => Number.isInteger(id) && id > 0)
  ));
  if (fileIds.length === 0) return;

  await pool.query(
    `UPDATE public.learning_files
     SET last_fetched_at = CURRENT_TIMESTAMP
     WHERE id = ANY($1::INTEGER[])
       AND published = true
       AND publish_status = 'active'
       AND deleted_at IS NULL
       AND (last_fetched_at IS NULL OR last_fetched_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes')`,
    [fileIds]
  );
};

const MIN_GROUNDED_INSIGHT_RESULTS = 5;

const buildAiInsightState = ({ metrics, cachedInsight, inputFingerprint }) => {
  if (metrics.validResultCount < MIN_GROUNDED_INSIGHT_RESULTS) {
    return {
      status: 'insufficient_data',
      required_result_count: MIN_GROUNDED_INSIGHT_RESULTS,
      valid_result_count: metrics.validResultCount,
      message: 'Not enough gameplay data yet to generate a reliable analysis.',
    };
  }

  if (
    cachedInsight
    && cachedInsight.input_fingerprint === inputFingerprint
    && !cachedInsight.stale_at
  ) {
    return {
      status: 'cached',
      required_result_count: MIN_GROUNDED_INSIGHT_RESULTS,
      valid_result_count: metrics.validResultCount,
      generated_at: cachedInsight.generated_at || null,
      insight: cachedInsight.insight,
    };
  }

  return {
    status: cachedInsight ? 'stale' : 'not_generated',
    required_result_count: MIN_GROUNDED_INSIGHT_RESULTS,
    valid_result_count: metrics.validResultCount,
    message: cachedInsight
      ? 'New gameplay data is available. Generate a refreshed insight when you are ready.'
      : 'Generate a grounded insight from the recorded gameplay results.',
  };
};

const markStudentInsightStale = async (queryClient, studentId) => {
  if (!studentId) return;
  await queryClient.query(
    `UPDATE public.student_ai_insights
     SET stale_at = COALESCE(stale_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE student_id = $1`,
    [studentId]
  );
};

app.use('/api', attachAuthenticatedAccount);

app.get('/api/test', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM public.accounts');
    res.json(buildAccountHealthCheckResponse(result.rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/session/validate', async (req, res) => {
  if (!req.authenticatedUser) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }

  res.json({
    valid: true,
    user: serializeUser(req.authenticatedUser),
  });
});

app.post('/api/login', async (req, res) => {
  const { username, password, deviceId } = req.body;
  const email = normalizeLoginEmail(username);

  try {
    const result = await pool.query(buildLoginAccountLookup(email));
    if (result.rows.length === 0) return res.status(404).json({ error: 'Email not found' });

    const user = result.rows[0];
    if (user.is_archived) return res.status(403).json({ error: 'Account archived. Restore before signing in.' });
    const passwordMatches = await comparePassword(password, user.password);
    if (!passwordMatches) return res.status(401).json({ error: 'Incorrect password' });
    if (user.must_change_password === true
      && hasTemporaryPasswordCredentialMetadata(user)
      && isTemporaryPasswordExpired(user.temporary_password_expires_at)) {
      return res.status(401).json({ error: 'Temporary password expired. Contact an administrator to issue a new temporary password.' });
    }

    const normalizedDeviceId = normalizeLoginDeviceId(deviceId);
    if (normalizedDeviceId) {
      const skipResult = await pool.query(buildLoginDeviceSkipLookup(user.id, normalizedDeviceId));
      if (skipResult.rows.length > 0) {
        const sessionToken = createRememberToken(user, {
          otpTrustExpiresAt: skipResult.rows[0]?.otp_skipped_until,
        });
        await pool.query(
          'UPDATE public.accounts SET otp_code = NULL, otp_expires_at = NULL, status = $1 WHERE id = $2',
          ['Active', user.id]
        );
        const serializedUser = serializeUser({ ...user, status: 'Active' });
        return res.json({
          success: true,
          user: serializedUser,
          mustChangePassword: serializedUser.mustChangePassword,
          requiresInitialPasswordSetup: serializedUser.requiresInitialPasswordSetup,
          rememberToken: sessionToken,
        });
      }
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 3 * 60 * 1000);
    await pool.query('UPDATE public.accounts SET otp_code = $1, otp_expires_at = $2 WHERE id = $3', [otp, expiresAt, user.id]);
    const emailSent = await resolveOtpEmailDelivery(
      () => sendOtpEmail(user.email, otp, 'Login Verification Code', user.role),
      getOtpEmailTimeoutMs()
    );

    return res.json(buildLoginOtpResponse({ user, expiresAt, emailSent }));
  } catch (err) {
    console.error('Login failed:', err.message);
    return res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/login/resend-otp', async (req, res) => {
  const { userId, email } = req.body;
  try {
    let query;
    if (userId) {
      query = await pool.query('SELECT * FROM public.accounts WHERE id = $1', [userId]);
    } else if (email) {
      query = await pool.query(buildLoginAccountLookup(email));
    } else {
      return res.status(400).json({ error: 'Missing user identifier' });
    }

    if (query.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = query.rows[0];
    if (user.is_archived) return res.status(403).json({ error: 'Account archived' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 3 * 60 * 1000);
    await pool.query('UPDATE public.accounts SET otp_code = $1, otp_expires_at = $2 WHERE id = $3', [otp, expiresAt, user.id]);
    const emailSent = await resolveOtpEmailDelivery(
      () => sendOtpEmail(user.email, otp, 'Your new verification code', user.role),
      getOtpEmailTimeoutMs()
    );

    return res.json(buildResendOtpResponse({ expiresAt, emailSent }));
  } catch (err) {
    console.error('Resend OTP failed:', err.message);
    return res.status(500).json({ error: 'Failed to resend OTP' });
  }
});

app.post('/api/login/verify-otp', async (req, res) => {
  const { userId, otp, email, deviceId, skipOtpFor30Days } = req.body;
  try {
    let result;
    if (userId) {
      result = await pool.query('SELECT * FROM public.accounts WHERE id = $1 AND otp_code = $2', [userId, otp]);
    } else if (email) {
      result = await pool.query('SELECT * FROM public.accounts WHERE LOWER(TRIM(email)) = $1 AND otp_code = $2', [normalizeLoginEmail(email), otp]);
    } else {
      return res.status(400).json({ error: 'Missing info' });
    }

    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid or expired OTP' });
    const user = result.rows[0];
    if (user.otp_expires_at && new Date(user.otp_expires_at) < new Date()) {
      return res.status(401).json({ error: 'OTP expired' });
    }

    const normalizedDeviceId = normalizeLoginDeviceId(deviceId);
    let otpTrustExpiresAt = null;
    if (skipOtpFor30Days && normalizedDeviceId) {
      otpTrustExpiresAt = new Date(Date.now() + THIRTY_DAY_SESSION_MS);
      await pool.query(buildLoginDeviceSkipUpsert(user.id, normalizedDeviceId, otpTrustExpiresAt));
    }
    const rememberToken = createRememberToken(user, { otpTrustExpiresAt });
    await pool.query('UPDATE public.accounts SET otp_code = NULL, otp_expires_at = NULL, status = $1 WHERE id = $2', ['Active', user.id]);

    const serializedUser = serializeUser({ ...user, status: 'Active' });
    res.json({
      success: true,
      user: serializedUser,
      mustChangePassword: serializedUser.mustChangePassword,
      requiresInitialPasswordSetup: serializedUser.requiresInitialPasswordSetup,
      rememberToken,
    });
  } catch (err) {
    console.error('OTP verification failed:', err.message);
    res.status(500).json({ error: 'OTP verification failed' });
  }
});

app.post('/api/logout-status', async (req, res) => {
  const { userId } = req.body;
  try {
    await pool.query('UPDATE public.accounts SET status = $1 WHERE id = $2', ['Offline', userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update status' });
  }
});

app.post('/api/account/initial-password', requireWebsiteManagedAccount, async (req, res) => {
  try {
    const updatedAccount = await replaceAccountPassword({
      account: req.authenticatedUser,
      newPassword: req.body?.newPassword,
      requireTemporaryPassword: true,
    });
    const user = serializeUser(updatedAccount);
    return res.json({
      success: true,
      message: 'Initial password setup completed.',
      user,
      rememberToken: createRememberToken(updatedAccount),
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : 'Unable to complete initial password setup.',
    });
  }
});

app.put('/api/account/password', requireWebsiteManagedAccount, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!await comparePassword(currentPassword, req.authenticatedUser.password)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    const updatedAccount = await replaceAccountPassword({
      account: req.authenticatedUser,
      newPassword,
      requireTemporaryPassword: false,
    });
    const user = serializeUser(updatedAccount);
    return res.json({
      success: true,
      message: 'Password changed successfully.',
      user,
      rememberToken: createRememberToken(updatedAccount),
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : 'Unable to change password.',
    });
  }
});

app.post('/api/accounts', requireAccountManagementAdmin, async (req, res) => {
  const { name, email, role, mobile_number, address, birthday, gender, employee_id } = req.body;
  try {
    const finalName = (name || '').trim();
    const normalizedEmail = (email || '').toLowerCase().trim();
    if (!finalName || !normalizedEmail) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    const mobileResult = normalizePhilippineMobile(mobile_number);
    if (mobileResult.error) return res.status(400).json({ error: mobileResult.error });

    const finalRole = normalizeAccountRole(role || 'Parent');
    if (!isWebsiteManagedAccountRole(finalRole)) {
      return res.status(400).json({ error: 'Manage Users can only create website accounts.' });
    }

    const birthdayResult = resolveOptionalBirthday(birthday);
    if (birthdayResult.error) {
      return res.status(400).json({ error: birthdayResult.error });
    }

    const employeeIdResult = resolveEmployeeIdForRole(finalRole, employee_id);
    if (employeeIdResult.error) {
      return res.status(400).json({ error: employeeIdResult.error });
    }

    const { password: generatedPassword, mustChangePassword } = resolveGeneratedAccountPassword(null, generateRandomPassword);
    const hashedPassword = await hashPassword(generatedPassword);
    const parentCode = accountHasParentAccess(finalRole) ? await generateUniqueParentCode() : null;
    const temporaryPasswordIssuedAt = new Date();
    const temporaryPasswordExpiresAt = getTemporaryPasswordExpiry(temporaryPasswordIssuedAt);

    const result = await pool.query(
      `INSERT INTO public.accounts (name, email, password, role, mobile_number, address, birthday, gender, employee_id, status, is_archived, must_change_password, parent_id, temporary_password_issued_at, temporary_password_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, $11, $12, $13, $14)
       RETURNING *`,
      [
        finalName,
        normalizedEmail,
        hashedPassword,
        finalRole,
        mobileResult.mobileNumber,
        normalizeOptionalText(address),
        birthdayResult.birthday,
        normalizeOptionalText(gender),
        employeeIdResult.employeeId,
        'Offline',
        mustChangePassword,
        parentCode,
        temporaryPasswordIssuedAt,
        temporaryPasswordExpiresAt,
      ]
    );

    const created = serializeUser(result.rows[0]);
    const shouldSendCredentialEmail = isWebsiteManagedAccountRole(finalRole);
    const emailSent = shouldSendCredentialEmail
      ? await resolveCredentialEmailDelivery(
        () => generateCredentialsEmail(normalizedEmail, generatedPassword, finalRole, finalName),
        getCredentialEmailTimeoutMs()
      )
      : true;
    const responsePayload = buildAccountCreationResponse({
      createdUser: created,
      emailSent,
      role: finalRole,
    });

    if (normalizeAccountRole(req.authenticatedUser?.role) === 'admin') {
      await writeAdminAuditLog(req.authenticatedUser, 'Create Account', created);
    }

    res.status(201).json(responsePayload);
  } catch (err) {
    console.error('Create account failed:', err.message);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Employee ID or email already exists' });
    }
    res.status(500).json({ error: 'Create account failed' });
  }
});

app.post('/api/accounts/:id/temporary-password', requireAccountManagementAdmin, async (req, res) => {
  try {
    const accountId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return res.status(400).json({ error: 'Invalid account ID.' });
    }
    const accountResult = await pool.query('SELECT * FROM public.accounts WHERE id = $1', [accountId]);
    const account = accountResult.rows[0];
    if (!account) return res.status(404).json({ error: 'Account not found.' });
    if (!isWebsiteManagedAccountRole(account.role)) {
      return res.status(403).json({ error: 'Temporary credentials are only available for website accounts.' });
    }
    if (account.is_archived) {
      return res.status(409).json({ error: 'Restore the account before issuing a temporary password.' });
    }

    const generatedPassword = generateRandomPassword();
    const issuedAt = new Date();
    const expiresAt = getTemporaryPasswordExpiry(issuedAt);
    const hashedPassword = await hashPassword(generatedPassword);
    const updateResult = await pool.query(
      `UPDATE public.accounts
       SET password = $1,
           must_change_password = true,
           temporary_password_issued_at = $2,
           temporary_password_expires_at = $3,
           otp_code = NULL,
           otp_expires_at = NULL,
           session_version = COALESCE(session_version, 0) + 1
       WHERE id = $4
       RETURNING *`,
      [hashedPassword, issuedAt, expiresAt, account.id]
    );
    const updatedAccount = updateResult.rows[0];
    const emailSent = await resolveCredentialEmailDelivery(
      () => generateCredentialsEmail(updatedAccount.email, generatedPassword, updatedAccount.role, updatedAccount.name),
      getCredentialEmailTimeoutMs()
    );
    await writeAdminAuditLog(req.authenticatedUser, 'Regenerate Temporary Password', updatedAccount);

    if (!emailSent) {
      return res.status(202).json({
        user: serializeUser(updatedAccount),
        emailSent: false,
        credentialDelivery: 'requires_regeneration',
        warning: 'Credential email could not be sent. Issue a new temporary password after email delivery is available.',
      });
    }

    return res.json({ user: serializeUser(updatedAccount), emailSent: true });
  } catch (error) {
    console.error('Temporary password regeneration failed:', error.message);
    return res.status(500).json({ error: 'Unable to issue a temporary password.' });
  }
});

app.get('/api/accounts', requireAccountManagementAdmin, async (req, res) => {
  try {
    const archived = String(req.query.archived).toLowerCase() === 'true';
    const roleFilter = req.query.role ? normalizeAccountRole(req.query.role) : null;
    let queryString;
    let queryParams = [];

    if (roleFilter && !isWebsiteManagedAccountRole(roleFilter)) {
      return res.json([]);
    }

    if (roleFilter) {
      queryString = archived
      ? 'SELECT * FROM public.accounts WHERE is_archived = true AND LOWER(role) = $1 AND LOWER(role) = ANY($2::text[]) ORDER BY id'
        : 'SELECT * FROM public.accounts WHERE COALESCE(is_archived, false) = false AND LOWER(role) = $1 AND LOWER(role) = ANY($2::text[]) ORDER BY id';
      queryParams.push(roleFilter, WEBSITE_MANAGED_ACCOUNT_ROLES);
    } else {
      queryString = archived
        ? 'SELECT * FROM public.accounts WHERE is_archived = true AND LOWER(role) = ANY($1::text[]) ORDER BY id'
        : 'SELECT * FROM public.accounts WHERE COALESCE(is_archived, false) = false AND LOWER(role) = ANY($1::text[]) ORDER BY id';
      queryParams.push(WEBSITE_MANAGED_ACCOUNT_ROLES);
    }

    const result = await pool.query(queryString, queryParams);
    res.json(result.rows.map(serializeUser));
  } catch (err) {
    console.error('Fetch accounts failed:', err.message);
    res.status(500).json({ error: 'Fetch failed' });
  }
});

// --- UPDATED PUT ROUTE (FIXED: Properly handles all fields, includes comprehensive logging) ---
app.put('/api/accounts/:id', requireAccountManagementAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, email, password, mobile_number, address, birthday, gender, status, employee_id, is_archived, role } = req.body;

  try {
    const currentData = await pool.query('SELECT * FROM public.accounts WHERE id = $1', [id]);
    if (currentData.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const old = currentData.rows[0];
    const finalEmail = email && email.trim() !== '' ? email.toLowerCase().trim() : old.email;
    const oldRole = normalizeAccountRole(old.role);
    if (isSameAccount(req.authenticatedUser, old, id)) {
      return res.status(403).json({ error: 'You cannot edit your own account here. Please use My Profile.' });
    }
    if (!isWebsiteManagedAccountRole(oldRole)) {
      return res.status(403).json({ error: 'Manage Users can only update website accounts.' });
    }

    const roleProvided = Object.prototype.hasOwnProperty.call(req.body, 'role');
    const finalRole = roleProvided ? normalizeAccountRole(role) : oldRole;
    if (!isWebsiteManagedAccountRole(finalRole)) {
      return res.status(400).json({ error: 'Manage Users can only assign website account roles.' });
    }
    const roleChanged = finalRole !== oldRole;
    if (oldRole === 'admin' && finalRole !== 'admin') {
      const activeAdminCount = await countActiveAdminAccounts();
      if (!old.is_archived && activeAdminCount <= 1) {
        return res.status(403).json({ error: 'Cannot change the role of the last admin account.' });
      }
    }

    const birthdayResult = resolveOptionalBirthday(birthday !== undefined ? birthday : old.birthday);
    if (birthdayResult.error) {
      return res.status(400).json({ error: birthdayResult.error });
    }
    const finalBirthday = birthdayResult.birthday;
    const mobileResult = resolveMobileNumberForUpdate(mobile_number, old.mobile_number);
    if (mobileResult.error) return res.status(400).json({ error: mobileResult.error });
    const employeeIdResult = resolveEmployeeIdForRole(finalRole, employee_id !== undefined ? employee_id : old.employee_id);
    if (employeeIdResult.error) {
      return res.status(400).json({ error: employeeIdResult.error });
    }
    const finalEmployeeId = employeeIdResult.employeeId;
    const finalStatus = status || old.status || 'Active';
    const finalArchived = typeof is_archived === 'boolean' ? is_archived : old.is_archived;
    const finalParentCode = accountHasParentAccess(finalRole) ? (old.parent_id || await generateUniqueParentCode()) : null;

    let hashedPassword = old.password;
    if (password && password.trim() !== '') {
      hashedPassword = await hashPassword(password);
    }

    const updateResult = await pool.query(
      `UPDATE public.accounts
       SET name=$1, email=$2, role=$3, password=$4, mobile_number=$5, address=$6,
           birthday=$7, gender=$8, status=$9, employee_id=$10, is_archived=$11, parent_id=$12
       WHERE id=$13
       RETURNING *`,
      [
        name || old.name,
        finalEmail,
        finalRole,
        hashedPassword,
        mobileResult.mobileNumber,
        address !== undefined ? address : old.address,
        finalBirthday,
        gender !== undefined ? gender : old.gender,
        finalStatus,
        finalEmployeeId,
        finalArchived,
        finalParentCode,
        id,
      ]
    );

    if (updateResult.rows.length === 0) {
      return res.status(500).json({ error: 'Failed to update account' });
    }

    const updatedUser = serializeUser(updateResult.rows[0]);
    await writeAdminAuditLog(req.authenticatedUser, 'Edit Account', updatedUser);
    if (roleChanged) {
      await writeAdminAuditLog(req.authenticatedUser, 'Change Role', updatedUser);
    }
    res.json({ success: true, message: 'Profile updated successfully', user: updatedUser });
  } catch (err) {
    console.error('Update Error:', err.message);
    res.status(500).json({ error: 'Update failed: ' + err.message });
  }
});

const getAssignableTeacherAccount = async (teacherId) => {
  const result = await pool.query(
    `SELECT id, role, is_archived
     FROM public.accounts
     WHERE id = $1
     LIMIT 1`,
    [teacherId]
  );
  const account = result.rows[0];
  if (!account) return { error: { status: 404, message: 'Teacher account not found.' } };
  if (account.is_archived || !accountHasTeacherAccess(account.role)) {
    return { error: { status: 400, message: 'Selected account must be an active Teacher or Parent/Teacher user.' } };
  }
  return { account };
};

app.get('/api/teacher-class-assignments', requireAccountManagementAdmin, async (req, res) => {
  try {
    const teacherId = resolveScopeId(req.query.teacherId);
    if (!teacherId || Number.isNaN(teacherId)) return res.status(400).json({ error: 'Invalid teacher ID' });
    const target = await getAssignableTeacherAccount(teacherId);
    if (target.error) return res.status(target.error.status).json({ error: target.error.message });

    const result = await pool.query(
      `SELECT id, teacher_account_id, grade_level, section, section_key, created_by_admin, created_at, updated_at
       FROM public.teacher_class_assignments
       WHERE teacher_account_id = $1
       ORDER BY grade_level, section_key, id`,
      [teacherId]
    );
    return res.json({ assignments: result.rows });
  } catch (err) {
    console.error('Fetch teacher class assignments failed:', err.message);
    return res.status(500).json({ error: 'Failed to fetch teacher class assignments.' });
  }
});

app.post('/api/teacher-class-assignments', requireAccountManagementAdmin, async (req, res) => {
  try {
    const teacherId = resolveScopeId(req.body?.teacherId ?? req.body?.teacher_account_id);
    if (!teacherId || Number.isNaN(teacherId)) return res.status(400).json({ error: 'Invalid teacher ID' });
    const assignmentInput = normalizeTeacherClassAssignment(req.body);
    if (assignmentInput.error) return res.status(400).json({ error: assignmentInput.error });

    const target = await getAssignableTeacherAccount(teacherId);
    if (target.error) return res.status(target.error.status).json({ error: target.error.message });

    const result = await pool.query(
      `INSERT INTO public.teacher_class_assignments (
         teacher_account_id, grade_level, section, section_key, created_by_admin
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (teacher_account_id, grade_level, section_key) DO NOTHING
       RETURNING id, teacher_account_id, grade_level, section, section_key, created_by_admin, created_at, updated_at`,
      [teacherId, assignmentInput.gradeLevel, assignmentInput.section, assignmentInput.sectionKey, req.authenticatedUser.id]
    );
    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'This teacher already has the selected Grade and Section assignment.' });
    }
    await writeAdminAuditLog(req.authenticatedUser, 'Assign Teacher Class', target.account);
    return res.status(201).json({ success: true, assignment: result.rows[0] });
  } catch (err) {
    console.error('Create teacher class assignment failed:', err.message);
    return res.status(500).json({ error: 'Failed to create teacher class assignment.' });
  }
});

app.put('/api/teacher-class-assignments/:id', requireAccountManagementAdmin, async (req, res) => {
  try {
    const assignmentId = resolveScopeId(req.params.id);
    if (!assignmentId || Number.isNaN(assignmentId)) return res.status(400).json({ error: 'Invalid assignment ID' });
    const assignmentInput = normalizeTeacherClassAssignment(req.body);
    if (assignmentInput.error) return res.status(400).json({ error: assignmentInput.error });

    const result = await pool.query(
      `UPDATE public.teacher_class_assignments
       SET grade_level = $2, section = $3, section_key = $4
       WHERE id = $1
       RETURNING id, teacher_account_id, grade_level, section, section_key, created_by_admin, created_at, updated_at`,
      [assignmentId, assignmentInput.gradeLevel, assignmentInput.section, assignmentInput.sectionKey]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Teacher class assignment not found.' });
    await writeAdminAuditLog(req.authenticatedUser, 'Update Teacher Class Assignment', { id: assignmentId });
    return res.json({ success: true, assignment: result.rows[0] });
  } catch (err) {
    if (err?.code === '23505') return res.status(409).json({ error: 'This teacher already has the selected Grade and Section assignment.' });
    console.error('Update teacher class assignment failed:', err.message);
    return res.status(500).json({ error: 'Failed to update teacher class assignment.' });
  }
});

app.delete('/api/teacher-class-assignments/:id', requireAccountManagementAdmin, async (req, res) => {
  try {
    const assignmentId = resolveScopeId(req.params.id);
    if (!assignmentId || Number.isNaN(assignmentId)) return res.status(400).json({ error: 'Invalid assignment ID' });
    const result = await pool.query(
      `DELETE FROM public.teacher_class_assignments
       WHERE id = $1
       RETURNING id, teacher_account_id, grade_level, section`,
      [assignmentId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Teacher class assignment not found.' });
    await writeAdminAuditLog(req.authenticatedUser, 'Remove Teacher Class Assignment', result.rows[0]);
    return res.json({ success: true });
  } catch (err) {
    console.error('Delete teacher class assignment failed:', err.message);
    return res.status(500).json({ error: 'Failed to remove teacher class assignment.' });
  }
});

app.get('/api/teacher-student-relationships', requireAccountManagementAdmin, async (req, res) => {
  try {
    const teacherId = parseInt(req.query.teacherId, 10);
    if (Number.isNaN(teacherId)) return res.status(400).json({ error: 'Invalid teacher ID' });

    const result = await pool.query(
      `SELECT r.id, r.relationship_type, r.created_at, s.id AS student_id, s.name AS student_name, s.email AS student_email, s.game_student_id
       FROM public.teacher_student_relationships r
       JOIN public.accounts s ON s.id = r.student_id
       WHERE r.teacher_id = $1`,
      [teacherId]
    );

    res.json({ relationships: result.rows });
  } catch (err) {
    console.error('Fetch teacher relationships failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch relationships' });
  }
});

app.post('/api/teacher-student-relationships', requireAccountManagementAdmin, async (req, res) => {
  const { teacherId, studentEmail, relationship_type } = req.body;
  try {
    const resultTeacher = await pool.query('SELECT * FROM accounts WHERE id = $1', [teacherId]);
    if (resultTeacher.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
    const teacher = resultTeacher.rows[0];
    const ownerRole = normalizeAccountRole(teacher.role);
    if (!accountHasTeacherAccess(ownerRole) && !accountHasParentAccess(ownerRole)) {
      return res.status(400).json({ error: 'Selected user must be a teacher or parent' });
    }

    const resultStudent = await pool.query('SELECT * FROM accounts WHERE LOWER(email) = $1', [studentEmail.toLowerCase().trim()]);
    if (resultStudent.rows.length === 0) return res.status(404).json({ error: 'Student not found' });
    const student = resultStudent.rows[0];
    if (normalizeAccountRole(student.role) !== 'student') return res.status(400).json({ error: 'Selected account must be a student role' });

    const existing = await pool.query(
      'SELECT * FROM public.teacher_student_relationships WHERE teacher_id = $1 AND student_id = $2 AND relationship_type = $3',
      [teacherId, student.id, relationship_type || 'Parent']
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Relationship already exists' });
    }

    const insertResult = await pool.query(
      `INSERT INTO public.teacher_student_relationships (teacher_id, student_id, relationship_type)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [teacherId, student.id, relationship_type || 'Parent']
    );

    res.json({ success: true, relationship: insertResult.rows[0] });
  } catch (err) {
    console.error('Create teacher-student relationship failed:', err.message);
    res.status(500).json({ error: 'Failed to create relationship' });
  }
});

app.delete('/api/teacher-student-relationships/:id', requireAccountManagementAdmin, async (req, res) => {
  try {
    const relationId = parseInt(req.params.id, 10);
    if (Number.isNaN(relationId)) return res.status(400).json({ error: 'Invalid relationship ID' });

    await pool.query('DELETE FROM public.teacher_student_relationships WHERE id = $1', [relationId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete relationship failed:', err.message);
    res.status(500).json({ error: 'Failed to delete relationship' });
  }
});

app.get('/api/folders', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM public.folders WHERE deleted_at IS NULL ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch folders failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch folders' });
  }
});

app.get('/api/folders/trash', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM public.folders WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch trashed folders failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch trashed folders' });
  }
});

app.post('/api/folders/create', requireLessonQuestionManagerAccess, async (req, res) => {
  res.status(410).json({
    error: 'Folder creation is disabled. Use the fixed Questions/Grade/Difficulty structure.',
  });
});

app.put('/api/folders/:id', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const folderId = parseInt(req.params.id, 10);
    const { name } = req.body;
    if (Number.isNaN(folderId)) return res.status(400).json({ error: 'Invalid folder ID' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Folder name is required' });

    const result = await pool.query(
      'UPDATE public.folders SET name = $1 WHERE id = $2 RETURNING *',
      [String(name).trim(), folderId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Folder not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Rename folder failed:', err.message);
    res.status(500).json({ error: 'Failed to rename folder' });
  }
});

app.delete('/api/folders/:id', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const folderId = parseInt(req.params.id, 10);
    if (Number.isNaN(folderId)) return res.status(400).json({ error: 'Invalid folder ID' });
    const activeQuestionSetResult = await pool.query(
      `SELECT id, title, file_name, grade_level, difficulty, topic_id, math_topic
       FROM public.learning_files
       WHERE folder_id = $1
         AND deleted_at IS NULL
         AND (published = true OR publish_status = 'active')
       LIMIT 1`,
      [folderId]
    );
    if (activeQuestionSetResult.rows.length > 0) {
      return res.status(409).json({
        error: 'This folder contains an Active in Game question set. Remove it from Game before moving the folder to Trash.',
        code: 'ACTIVE_QUESTION_SET_CANNOT_BE_DELETED',
        blocked_question_set: buildQuestionSetReplacementSummary(activeQuestionSetResult.rows[0]),
      });
    }
    const result = await pool.query(
      'UPDATE public.folders SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP) WHERE id = $1 RETURNING *',
      [folderId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Folder not found' });
    await pool.query(
      `UPDATE public.learning_files
       SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP),
           published = false,
           publish_status = CASE
             WHEN LOWER(COALESCE(publish_status, '')) = 'superseded' THEN 'superseded'
             ELSE 'staged'
           END
       WHERE folder_id = $1`,
      [folderId]
    );
    await pool.query(
      `UPDATE public.questions q
       SET published = false
       FROM public.learning_files lf
       WHERE q.learning_file_id = lf.id
         AND lf.folder_id = $1`,
      [folderId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Move folder to trash failed:', err.message);
    res.status(500).json({ error: 'Failed to move folder to trash' });
  }
});

app.post('/api/folders/:id/restore', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const folderId = parseInt(req.params.id, 10);
    if (Number.isNaN(folderId)) return res.status(400).json({ error: 'Invalid folder ID' });
    const result = await pool.query(
      'UPDATE public.folders SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING *',
      [folderId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Trashed folder not found' });
    await pool.query('UPDATE public.learning_files SET deleted_at = NULL WHERE folder_id = $1', [folderId]);
    res.json({ success: true, folder: result.rows[0] });
  } catch (err) {
    console.error('Restore folder failed:', err.message);
    res.status(500).json({ error: 'Failed to restore folder' });
  }
});

app.delete('/api/folders/:id/permanent', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const folderId = parseInt(req.params.id, 10);
    if (Number.isNaN(folderId)) return res.status(400).json({ error: 'Invalid folder ID' });
    const activeQuestionSetResult = await pool.query(
      `SELECT id, title, file_name, grade_level, difficulty, topic_id, math_topic
       FROM public.learning_files
       WHERE folder_id = $1
         AND (published = true OR publish_status = 'active')
       LIMIT 1`,
      [folderId]
    );
    if (activeQuestionSetResult.rows.length > 0) {
      return res.status(409).json({
        error: 'This folder contains an Active in Game question set. Remove it from Game before permanently deleting the folder.',
        code: 'ACTIVE_QUESTION_SET_CANNOT_BE_DELETED',
        blocked_question_set: buildQuestionSetReplacementSummary(activeQuestionSetResult.rows[0]),
      });
    }
    const historicalResult = await pool.query(
      `SELECT 1
       FROM public.game_results gr
       JOIN public.learning_files lf ON lf.id = gr.question_set_id
       WHERE lf.folder_id = $1
         AND lf.deleted_at IS NOT NULL
       LIMIT 1`,
      [folderId]
    );
    if (historicalResult.rows.length > 0) {
      return res.status(409).json({
        error: 'This folder contains question sets with historical results and cannot be permanently deleted.',
      });
    }
    const fileResult = await pool.query(
      'SELECT id, file_url FROM public.learning_files WHERE folder_id = $1 AND deleted_at IS NOT NULL',
      [folderId]
    );
    for (const file of fileResult.rows) {
      await pool.query('DELETE FROM public.questions WHERE learning_file_id = $1', [file.id]);
      await pool.query('DELETE FROM public.learning_files WHERE id = $1', [file.id]);
      removeFileFromDisk(file.file_url);
    }
    const result = await pool.query(
      'DELETE FROM public.folders WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id',
      [folderId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Trashed folder not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Permanent folder delete failed:', err.message);
    res.status(500).json({ error: 'Failed to permanently delete folder' });
  }
});

const resolveLearningFolderId = async (rawFolderId) => {
  const value = String(rawFolderId ?? '').trim();
  if (!value) return { folderId: null };

  const folderId = parseInt(value, 10);
  if (Number.isNaN(folderId)) {
    return { error: 'Invalid folder ID.' };
  }

  const folder = await pool.query('SELECT id FROM public.folders WHERE id = $1 AND deleted_at IS NULL', [folderId]);
  if (folder.rows.length === 0) {
    return { error: 'Selected folder was not found.' };
  }

  return { folderId };
};

const uploadLearningFile = (req, res, next) => upload.single('file')(req, res, (error) => {
  if (!error) return next();
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'Uploaded files must be 30 MB or smaller.',
      code: 'LESSON_FILE_TOO_LARGE',
    });
  }
  return res.status(400).json({
    error: 'The uploaded file could not be processed.',
    code: 'LEARNING_FILE_UPLOAD_INVALID',
  });
});

const getLessonSourceFilePath = (lessonSource = {}) => {
  const fileUrl = String(lessonSource.file_url || '').trim();
  if (!fileUrl.startsWith('/uploads/')) return null;
  const fileName = path.basename(fileUrl);
  if (!fileName || fileName !== fileUrl.slice('/uploads/'.length)) return null;
  return path.join(uploadsDir, fileName);
};

const validateLessonGenerationScope = ({ grade_level, difficulty, expected_question_count }) => {
  const scope = resolveQuestionPoolScope({ grade_level, difficulty });
  if (!scope) return { error: 'Grade level and Difficulty must use supported canonical values.' };

  const parsedCount = parseLessonQuestionCount(expected_question_count);
  if (parsedCount.error) return { error: parsedCount.error };

  return {
    gradeLevel: scope.grade_level,
    difficulty: scope.difficulty,
    questionCount: parsedCount.value,
  };
};

app.get('/api/learning-files/lesson-sources', requireLessonQuestionManagerAccess, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT lf.*, COUNT(children.id)::INTEGER AS generated_child_count
       FROM public.learning_files lf
       LEFT JOIN public.learning_files children
         ON children.source_learning_file_id = lf.id
        AND children.deleted_at IS NULL
       WHERE lf.deleted_at IS NULL
         AND lf.content_role = 'lesson_source'
       GROUP BY lf.id
       ORDER BY lf.uploaded_at DESC, lf.id DESC`
    );
    return res.json(result.rows.map((source) => normalizeLearningFileRow(source)));
  } catch (error) {
    console.error('Fetch lesson sources failed:', error.message);
    return res.status(500).json({ error: 'Failed to fetch lesson sources.' });
  }
});

app.post('/api/learning-files/lesson-sources', requireLessonQuestionManagerAccess, uploadLearningFile, async (req, res) => {
  let storedFilePath = null;
  try {
    const title = String(req.body?.title || '').trim();
    if (!req.file) return res.status(400).json({ error: 'File is required.' });
    if (!title) {
      cleanTemporaryUpload(req.file.path);
      return res.status(400).json({ error: 'Lesson source title is required.' });
    }
    if (Number(req.file.size) > MAX_LESSON_UPLOAD_BYTES) {
      cleanTemporaryUpload(req.file.path);
      return res.status(413).json({ error: 'Uploaded files must be 30 MB or smaller.', code: 'LESSON_FILE_TOO_LARGE' });
    }
    const fileValidationError = validateUploadedLearningFile(req.file, 'lesson');
    if (fileValidationError) {
      cleanTemporaryUpload(req.file.path);
      return res.status(400).json({ error: fileValidationError });
    }
    const folderResolution = await resolveLearningFolderId(req.body?.folder_id);
    if (folderResolution.error) {
      cleanTemporaryUpload(req.file.path);
      return res.status(400).json({ error: folderResolution.error });
    }

    const sourceBytes = fs.readFileSync(req.file.path);
    const sourceContentFingerprint = crypto.createHash('sha256').update(sourceBytes).digest('hex');
    const storedFileName = generateUploadFileName(req.file.originalname);
    storedFilePath = path.join(uploadsDir, storedFileName);
    fs.renameSync(req.file.path, storedFilePath);
    const insertResult = await pool.query(
      `INSERT INTO public.learning_files (
         title, file_name, file_url, grade_level, difficulty, math_topic, document_topic,
         file_type, subject, folder_id, published, source, uploaded_by, file_size,
         generation_status, publish_status, content_role, source_content_fingerprint,
         source_file_mime_type
       ) VALUES ($1, $2, $3, '', NULL, NULL, NULL, 'lesson', 'Mathematics', $4, false, 'lesson', $5, $6,
                 'source_ready', 'staged', 'lesson_source', $7, $8)
       RETURNING *`,
      [
        title,
        req.file.originalname,
        buildFileUrl(storedFileName),
        folderResolution.folderId,
        req.authenticatedUser.id,
        req.file.size || null,
        sourceContentFingerprint,
        req.file.mimetype || 'application/pdf',
      ]
    );
    return res.status(201).json({
      success: true,
      lessonSource: normalizeLearningFileRow(insertResult.rows[0]),
    });
  } catch (error) {
    console.error('Lesson source upload failed:', error.message);
    cleanTemporaryUpload(storedFilePath || req.file?.path);
    return res.status(500).json({ error: 'Lesson source upload failed.' });
  }
});

app.post('/api/learning-files/lesson-sources/:id/generate', requireLessonQuestionManagerAccess, async (req, res) => {
  let childLearningFile = null;
  try {
    const sourceId = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(sourceId) || sourceId < 1) return res.status(400).json({ error: 'Invalid lesson source ID.' });
    const scope = validateLessonGenerationScope(req.body || {});
    if (scope.error) return res.status(400).json({ error: scope.error });
    const idempotencyKey = getLessonGenerationIdempotencyKey(req);
    if (!idempotencyKey) {
      return res.status(400).json({
        error: 'A valid generation request key is required for AI question generation.',
        code: 'AI_GENERATION_IDEMPOTENCY_REQUIRED',
      });
    }

    const sourceResult = await pool.query(
      `SELECT *
       FROM public.learning_files
       WHERE id = $1
         AND content_role = 'lesson_source'
         AND deleted_at IS NULL
       LIMIT 1`,
      [sourceId]
    );
    const lessonSource = sourceResult.rows[0];
    if (!lessonSource) return res.status(404).json({ error: 'Lesson source not found.' });

    const sourceContentFingerprint = String(lessonSource.source_content_fingerprint || '').trim();
    if (!sourceContentFingerprint) {
      return res.status(422).json({
        error: 'The Lesson PDF source is missing its content fingerprint. Upload the source again before generating questions.',
        code: 'LESSON_SOURCE_FINGERPRINT_MISSING',
      });
    }
    const requestFingerprint = buildLessonGenerationRequestFingerprint({
      actorId: req.authenticatedUser.id,
      sourceLearningFileId: lessonSource.id,
      sourceContentFingerprint,
      gradeLevel: scope.gradeLevel,
      difficulty: scope.difficulty,
      questionCount: scope.questionCount,
    });
    const existingGeneration = await getLessonGenerationByIdempotencyKey(req.authenticatedUser.id, idempotencyKey);
    if (existingGeneration) {
      return respondToExistingLessonGeneration({ res, learningFile: existingGeneration, requestFingerprint });
    }
    const inProgressGeneration = await getInProgressLessonGenerationByFingerprint(req.authenticatedUser.id, requestFingerprint);
    if (inProgressGeneration) {
      return res.status(202).json({
        ...buildLessonGenerationResponse(inProgressGeneration, { idempotent: true }),
        code: 'AI_GENERATION_IN_PROGRESS',
        message: 'Question generation is already in progress for this lesson source and scope.',
      });
    }

    const sourceFilePath = getLessonSourceFilePath(lessonSource);
    if (!sourceFilePath || !fs.existsSync(sourceFilePath)) {
      return res.status(422).json({
        error: 'The Lesson PDF source is unavailable. Upload the source again before generating questions.',
        code: 'LESSON_SOURCE_FILE_MISSING',
      });
    }
    const lessonText = await extractLessonTextForGeneration({
      filePath: sourceFilePath,
      fileName: lessonSource.file_name,
      mimeType: lessonSource.source_file_mime_type || 'application/pdf',
    });

    const insertResult = await pool.query(
      `INSERT INTO public.learning_files (
         title, file_name, file_url, grade_level, difficulty, math_topic, topic_id, document_topic,
         file_type, subject, folder_id, published, source, uploaded_by, file_size,
         requested_question_count, generation_status, publish_status, content_role,
         source_learning_file_id, source_content_fingerprint, generation_idempotency_key,
         generation_request_fingerprint, source_file_mime_type
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 'lesson', 'Mathematics', $8, false, 'lesson', $9, $10,
                 $11, 'generating', 'staged', 'question_set', $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        `${lessonSource.title} — ${scope.gradeLevel} / ${scope.difficulty}`,
        lessonSource.file_name,
        lessonSource.file_url,
        scope.gradeLevel,
        scope.difficulty,
        null,
        null,
        lessonSource.folder_id || null,
        req.authenticatedUser.id,
        lessonSource.file_size || null,
        scope.questionCount,
        lessonSource.id,
        sourceContentFingerprint,
        idempotencyKey,
        requestFingerprint,
        lessonSource.source_file_mime_type || 'application/pdf',
      ]
    );
    childLearningFile = insertResult.rows[0];

    if (!String(process.env.OPENAI_API_KEY || '').trim()) {
      throw new QuestionGenerationError('QUESTION_AI_NOT_CONFIGURED', 'Question AI is not configured.');
    }
    const questions = await generateQuestionTextFromLesson(
      {
        filePath: sourceFilePath,
        fileName: lessonSource.file_name,
        mimeType: lessonSource.source_file_mime_type || 'application/pdf',
        lessonText,
      },
      lessonSource.title,
      scope.gradeLevel,
      scope.difficulty,
      scope.questionCount
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await saveQuestionsForFile(childLearningFile.id, questions.map((question) => ({
        ...question,
        grade_level: scope.gradeLevel,
        difficulty: scope.difficulty,
        math_topic: null,
        topic_id: null,
        source: 'ai',
      })), client);
      const completed = await client.query(
        `UPDATE public.learning_files
         SET generation_status = 'ready_for_review',
             generated_at = CURRENT_TIMESTAMP,
             generation_failed_at = NULL,
             generation_error_code = NULL
         WHERE id = $1
         RETURNING *`,
        [childLearningFile.id]
      );
      childLearningFile = completed.rows[0] || childLearningFile;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    return res.status(201).json({
      success: true,
      learningFile: normalizeLearningFileRow({ ...childLearningFile, question_count: questions.length }),
    });
  } catch (error) {
    if (childLearningFile?.id) {
      await pool.query(
        `UPDATE public.learning_files
         SET generation_status = 'failed',
             generation_failed_at = CURRENT_TIMESTAMP,
             generation_error_code = $2
         WHERE id = $1`,
        [childLearningFile.id, error instanceof QuestionGenerationError ? error.code : 'QUESTION_GENERATION_FAILED']
      ).catch((persistError) => console.error('Failed to persist lesson source generation status:', persistError.message));
    }
    if (error instanceof QuestionGenerationError) {
      const status = error.code === 'QUESTION_AI_NOT_CONFIGURED' ? 503
        : error.code === 'QUESTION_AI_TIMEOUT' ? 504
          : error.code === 'QUESTION_AI_EMPTY_LESSON' || error.code === 'QUESTION_AI_LESSON_TOO_LARGE' ? 422
            : 502;
      const message = error.code === 'QUESTION_AI_NOT_CONFIGURED'
        ? 'Question AI is temporarily unavailable. Please contact the administrator.'
        : error.code === 'QUESTION_AI_EMPTY_LESSON'
          ? 'No readable lesson text was found in this source.'
          : error.code === 'QUESTION_AI_LESSON_TOO_LARGE'
            ? 'The readable lesson text exceeds the safe size limit.'
            : 'Question generation could not be completed. Please review the lesson source and try again.';
      return res.status(status).json({ error: message, code: error.code });
    }
    console.error('Lesson source generation failed:', error.message);
    return res.status(500).json({ error: 'Question generation could not be completed.' });
  }
});

app.post('/api/learning-files/upload', requireLessonQuestionManagerAccess, uploadLearningFile, async (req, res) => {
  let storedFilePath = null;
  let persistedLearningFileId = null;
  let lessonGenerationIdempotencyKey = null;
  let lessonGenerationRequestFingerprint = null;
  let lessonSourceContentFingerprint = null;
  try {
    const { title, grade_level, difficulty, topic_id, math_topic, file_type, folder_id, expected_question_count } = req.body;
    if (!req.file) return res.status(400).json({ error: 'File is required' });
    if (Number(req.file.size) > MAX_LESSON_UPLOAD_BYTES) {
      cleanTemporaryUpload(req.file.path);
      return res.status(413).json({
        error: 'Uploaded files must be 30 MB or smaller.',
        code: 'LESSON_FILE_TOO_LARGE',
      });
    }
    if (!title || !grade_level || !difficulty || !file_type) {
      return res.status(400).json({ error: 'Missing required metadata' });
    }

    const canonicalScope = resolveCanonicalQuestionScope({ grade_level, difficulty, topic_id, math_topic });
    if (!canonicalScope) {
      cleanTemporaryUpload(req.file.path);
      return res.status(400).json({ error: 'Grade level and Difficulty must use supported canonical values.' });
    }
    const normalizedGrade = canonicalScope.grade_level;
    const normalizedDifficulty = canonicalScope.difficulty;
    const normalizedTopicId = canonicalScope.topic_id;
    const normalizedTopic = canonicalScope.math_topic;
    const normalizedType = String(file_type).trim().toLowerCase();
    if (!isValidFileType(normalizedType)) {
      cleanTemporaryUpload(req.file.path);
      return res.status(400).json({ error: 'Invalid file type.' });
    }

    const fileValidationError = validateUploadedLearningFile(req.file, normalizedType);
    if (fileValidationError) {
      cleanTemporaryUpload(req.file.path);
      return res.status(400).json({ error: fileValidationError });
    }

    const folderResolution = await resolveLearningFolderId(folder_id);
    if (folderResolution.error) {
      cleanTemporaryUpload(req.file.path);
      return res.status(400).json({ error: folderResolution.error });
    }

    let requestedQuestionCount = null;
    let fixedQuestions = [];
    let fixedDocumentTopic = null;
    if (normalizedType === 'lesson') {
      const parsedCount = parseLessonQuestionCount(expected_question_count);
      if (parsedCount.error) {
        cleanTemporaryUpload(req.file.path);
        return res.status(400).json({ error: parsedCount.error });
      }
      requestedQuestionCount = parsedCount.value;
      lessonGenerationIdempotencyKey = getLessonGenerationIdempotencyKey(req);
      if (!lessonGenerationIdempotencyKey) {
        cleanTemporaryUpload(req.file.path);
        return res.status(400).json({
          error: 'A valid upload request key is required for AI question generation.',
          code: 'AI_GENERATION_IDEMPOTENCY_REQUIRED',
        });
      }
    } else {
      if (String(expected_question_count ?? '').trim()) {
        cleanTemporaryUpload(req.file.path);
        return res.status(400).json({ error: 'Question Count is only available for Lesson PDF files.' });
      }
      let fixedQuestionValidation;
      try {
        fixedQuestionValidation = await extractAndValidateFixedQuestionsFile({
          path: req.file.path,
          originalname: req.file.originalname,
          mimetype: req.file.mimetype,
        });
      } catch (error) {
        cleanTemporaryUpload(req.file.path);
        return res.status(422).json({
          error: 'The uploaded Fixed Question document could not be read. Correct the source document and upload it again.',
          code: 'FIXED_QUESTION_VALIDATION_FAILED',
          document_errors: ['No readable numbered questions could be extracted from this document.'],
          questions: [],
        });
      }
      if (!fixedQuestionValidation.isValid) {
        cleanTemporaryUpload(req.file.path);
        return res.status(422).json({
          error: 'Fixed Questions need correction before they can be uploaded.',
          code: 'FIXED_QUESTION_VALIDATION_FAILED',
          document_errors: fixedQuestionValidation.document_errors,
          questions: fixedQuestionValidation.questions,
        });
      }
      const fixedQuestionMetadata = resolveFixedQuestionDocumentMetadata({
        documentText: fixedQuestionValidation.document_text,
        selectedGradeLevel: normalizedGrade,
        selectedDifficulty: normalizedDifficulty,
      });
      if (fixedQuestionMetadata.metadata_error) {
        cleanTemporaryUpload(req.file.path);
        return res.status(422).json({
          error: fixedQuestionMetadata.metadata_error,
          code: 'FIXED_QUESTION_METADATA_CONFLICT',
        });
      }
      fixedDocumentTopic = fixedQuestionMetadata.document_topic;
      fixedQuestions = fixedQuestionValidation.questions;
    }

    if (normalizedType === 'lesson') {
      const sourceFileBytes = fs.readFileSync(req.file.path);
      lessonSourceContentFingerprint = crypto.createHash('sha256').update(sourceFileBytes).digest('hex');
      lessonGenerationRequestFingerprint = buildLessonGenerationRequestFingerprint({
        actorId: req.authenticatedUser.id,
        sourceContentFingerprint: lessonSourceContentFingerprint,
        gradeLevel: normalizedGrade,
        difficulty: normalizedDifficulty,
        questionCount: requestedQuestionCount,
      });

      const existingGeneration = await getLessonGenerationByIdempotencyKey(
        req.authenticatedUser.id,
        lessonGenerationIdempotencyKey
      );
      if (existingGeneration) {
        cleanTemporaryUpload(req.file.path);
        return respondToExistingLessonGeneration({
          res,
          learningFile: existingGeneration,
          requestFingerprint: lessonGenerationRequestFingerprint,
        });
      }

      const inProgressGeneration = await getInProgressLessonGenerationByFingerprint(
        req.authenticatedUser.id,
        lessonGenerationRequestFingerprint
      );
      if (inProgressGeneration) {
        cleanTemporaryUpload(req.file.path);
        return res.status(202).json({
          ...buildLessonGenerationResponse(inProgressGeneration, { idempotent: true }),
          code: 'AI_GENERATION_IN_PROGRESS',
          message: 'Question generation is already in progress for this lesson.',
        });
      }
    }

    const fileName = generateUploadFileName(req.file.originalname);
    const destinationPath = path.join(uploadsDir, fileName);
    fs.renameSync(req.file.path, destinationPath);
    storedFilePath = destinationPath;
    const fileUrl = buildFileUrl(fileName);
    const preflightLessonText = normalizedType === 'lesson'
      ? await extractLessonTextForGeneration({
        filePath: storedFilePath,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
      })
      : null;

    const createLearningFile = async (generationStatus) => {
      const insertResult = await pool.query(
        `INSERT INTO public.learning_files (
          title, file_name, file_url, grade_level, difficulty, math_topic, topic_id, document_topic,
          file_type, subject, folder_id, published, source, uploaded_by,
          file_size, requested_question_count, generation_status, publish_status,
          source_content_fingerprint, generation_idempotency_key, generation_request_fingerprint
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Mathematics', $10, false, $11, $12, $13, $14, $15, 'staged', $16, $17, $18)
         RETURNING *`,
        [
          String(title).trim(),
          req.file.originalname,
          fileUrl,
          normalizedGrade,
          normalizedDifficulty,
          normalizedTopic || null,
          normalizedTopicId,
          null,
          normalizedType,
          folderResolution.folderId,
          normalizedType === 'lesson' ? 'lesson' : 'fixed',
          req.authenticatedUser.id,
          req.file.size || null,
          requestedQuestionCount,
          generationStatus,
          normalizedType === 'lesson' ? lessonSourceContentFingerprint : null,
          normalizedType === 'lesson' ? lessonGenerationIdempotencyKey : null,
          normalizedType === 'lesson' ? lessonGenerationRequestFingerprint : null,
        ]
      );
      persistedLearningFileId = insertResult.rows[0].id;
      return insertResult.rows[0];
    };

    if (normalizedType === 'lesson') {
      let learningFile;
      try {
        learningFile = await createLearningFile('generating');
      } catch (error) {
        if (error?.code === '23505') {
          const existingGeneration = await getLessonGenerationByIdempotencyKey(
            req.authenticatedUser.id,
            lessonGenerationIdempotencyKey
          );
          const inProgressGeneration = existingGeneration || await getInProgressLessonGenerationByFingerprint(
            req.authenticatedUser.id,
            lessonGenerationRequestFingerprint
          );
          if (inProgressGeneration) {
            cleanTemporaryUpload(storedFilePath);
            storedFilePath = null;
            return respondToExistingLessonGeneration({
              res,
              learningFile: inProgressGeneration,
              requestFingerprint: lessonGenerationRequestFingerprint,
            });
          }
        }
        throw error;
      }
      try {
        if (!String(process.env.OPENAI_API_KEY || '').trim()) {
          throw new QuestionGenerationError('QUESTION_AI_NOT_CONFIGURED', 'Question AI is not configured.');
        }
        const questions = await generateQuestionTextFromLesson(
          {
            filePath: storedFilePath,
            fileName: req.file.originalname,
            mimeType: req.file.mimetype,
            lessonText: preflightLessonText,
          },
          String(title).trim(),
          normalizedGrade,
          normalizedDifficulty,
          requestedQuestionCount
        );

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await saveQuestionsForFile(learningFile.id, questions.map((question) => ({
            ...question,
            grade_level: learningFile.grade_level,
            difficulty: learningFile.difficulty,
            math_topic: learningFile.math_topic,
            topic_id: learningFile.topic_id,
            source: 'ai',
          })), client);
          const completedResult = await client.query(
            `UPDATE public.learning_files
             SET generation_status = 'ready_for_review',
                 generated_at = CURRENT_TIMESTAMP,
                 generation_failed_at = NULL,
                 generation_error_code = NULL
             WHERE id = $1
             RETURNING *`,
            [learningFile.id]
          );
          learningFile = completedResult.rows[0] || learningFile;
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.release();
        }

        return res.status(201).json({
          success: true,
          learningFile: normalizeLearningFileRow({ ...learningFile, question_count: questions.length }),
        });
      } catch (error) {
        await pool.query(
          `UPDATE public.learning_files
           SET generation_status = 'failed',
               generation_failed_at = CURRENT_TIMESTAMP,
               generation_error_code = $2
           WHERE id = $1`,
          [learningFile.id, error instanceof QuestionGenerationError ? error.code : 'QUESTION_GENERATION_FAILED']
        ).catch((persistError) => console.error('Failed to persist question generation status:', persistError.message));
        throw error;
      }
    }

    const client = await pool.connect();
    let learningFile;
    try {
      await client.query('BEGIN');
      const insertResult = await client.query(
        `INSERT INTO public.learning_files (
          title, file_name, file_url, grade_level, difficulty, math_topic, topic_id, document_topic,
          file_type, subject, folder_id, published, source, uploaded_by,
          file_size, requested_question_count, generation_status, publish_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Mathematics', $10, false, $11, $12, $13, NULL, 'not_applicable', 'staged')
         RETURNING *`,
        [
          String(title).trim(),
          req.file.originalname,
          fileUrl,
          normalizedGrade,
          normalizedDifficulty,
          normalizedTopic || null,
          normalizedTopicId,
          fixedDocumentTopic,
          normalizedType,
          folderResolution.folderId,
          'fixed',
          req.authenticatedUser.id,
          req.file.size || null,
        ]
      );
      learningFile = insertResult.rows[0];
      persistedLearningFileId = learningFile.id;
      await saveQuestionsForFile(learningFile.id, fixedQuestions.map((question) => ({
        ...question,
        grade_level: learningFile.grade_level,
        difficulty: learningFile.difficulty,
        math_topic: learningFile.math_topic,
        topic_id: learningFile.topic_id,
        source: 'fixed',
      })), client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    res.status(201).json({
      success: true,
      learningFile: normalizeLearningFileRow({ ...learningFile, question_count: fixedQuestions.length }),
    });
  } catch (err) {
    if (err instanceof QuestionGenerationError && err.providerDiagnostics) {
      console.error('Question AI provider diagnostics:', err.providerDiagnostics);
    }
    console.error('Upload failed:', err.message);
    if (!persistedLearningFileId) {
      cleanTemporaryUpload(storedFilePath || req.file?.path);
    }
    if (err instanceof QuestionGenerationError) {
      const status = err.code === 'QUESTION_AI_NOT_CONFIGURED' ? 503
        : err.code === 'QUESTION_AI_TIMEOUT' ? 504
        : err.code === 'QUESTION_AI_EMPTY_LESSON' || err.code === 'QUESTION_AI_LESSON_TOO_LARGE' || err.code === 'QUESTION_AI_INVALID_REQUEST' || err.code === 'QUESTION_AI_INVALID_RESPONSE' ? 422
            : 502;
      const error = err.code === 'QUESTION_AI_NOT_CONFIGURED'
        ? 'Question AI is temporarily unavailable. Please contact the administrator.'
        : err.code === 'QUESTION_AI_TIMEOUT'
          ? 'Question generation timed out. Please try again.'
          : err.code === 'QUESTION_AI_EMPTY_LESSON'
            ? 'No readable lesson text was found in this source.'
            : err.code === 'QUESTION_AI_LESSON_TOO_LARGE'
              ? 'The readable lesson text exceeds the safe size limit.'
            : err.code === 'QUESTION_AI_INVALID_RESPONSE'
              ? 'Question generation returned unusable question data. Please try again.'
              : 'Question generation could not be completed. Please review the lesson source and try again.';
      return res.status(status).json({ error, code: err.code });
    }
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.get('/api/question-folders', requireLessonQuestionManagerAccess, async (req, res) => {
  res.json(buildQuestionFolderStructure());
});

app.get('/api/learning-files/folder', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const gradeLevel = normalizeGameGradeLevel(req.query.grade_level || req.query.grade);
    const difficulty = normalizeDifficultyValue(req.query.difficulty);
    if (!QUESTION_GRADE_LEVELS.includes(gradeLevel) || !QUESTION_DIFFICULTIES.includes(difficulty)) {
      return res.status(400).json({ error: 'Valid grade_level and difficulty are required.' });
    }

    const result = await pool.query(
      `SELECT lf.*,
              f.name AS folder_name,
              COALESCE(NULLIF(TRIM(a.name), ''), a.email, 'Unknown') AS uploaded_by_name,
              COALESCE(question_counts.question_count, 0)::INTEGER AS question_count
       FROM public.learning_files lf
       LEFT JOIN public.folders f ON lf.folder_id = f.id
       LEFT JOIN public.accounts a ON lf.uploaded_by = a.id
       LEFT JOIN (
         SELECT learning_file_id, COUNT(*)::INTEGER AS question_count
         FROM public.questions
         GROUP BY learning_file_id
       ) question_counts ON question_counts.learning_file_id = lf.id
       WHERE lf.deleted_at IS NULL
         AND (f.id IS NULL OR f.deleted_at IS NULL)
         AND lf.grade_level = $1
         AND ${canonicalDifficultySql('lf.difficulty')} = $2
       ORDER BY lf.uploaded_at DESC`,
      [gradeLevel, difficulty]
    );

    res.json({
      path: buildQuestionFolderPath(gradeLevel, difficulty),
      grade_level: gradeLevel,
      difficulty,
      files: result.rows.map(normalizeLearningFileRow),
    });
  } catch (err) {
    console.error('Fetch learning folder files failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch folder files' });
  }
});

app.get('/api/learning-files', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT lf.*,
              f.name AS folder_name,
              COALESCE(NULLIF(TRIM(a.name), ''), a.email, 'Unknown') AS uploaded_by_name,
              COALESCE(question_counts.question_count, 0)::INTEGER AS question_count
       FROM public.learning_files lf
       LEFT JOIN public.folders f ON lf.folder_id = f.id
       LEFT JOIN public.accounts a ON lf.uploaded_by = a.id
       LEFT JOIN (
         SELECT learning_file_id, COUNT(*)::INTEGER AS question_count
         FROM public.questions
         GROUP BY learning_file_id
       ) question_counts ON question_counts.learning_file_id = lf.id
       WHERE lf.deleted_at IS NULL
         AND (f.id IS NULL OR f.deleted_at IS NULL)
       ORDER BY lf.uploaded_at DESC`
    );
    const files = await Promise.all(result.rows.filter((row) => !isLessonSourceRecord(row)).map(async (row) => {
      const validation = await getQuestionSetValidationState(pool, row);
      return normalizeLearningFileRow({
        ...row,
        validation_summary: buildQuestionSetValidationSummary(validation, row),
      });
    }));
    res.json(files);
  } catch (err) {
    console.error('Fetch learning files failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch files' });
  }
});

app.get('/api/learning-files/storage-summary', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         COALESCE(SUM(GREATEST(COALESCE(lf.file_size, 0), 0)), 0)::BIGINT AS source_file_bytes,
         COALESCE((
           SELECT SUM(
             octet_length(
               jsonb_build_object(
                 'question', q.question,
                 'options', q.options,
                 'correct_answer', q.correct_answer,
                 'grade_level', q.grade_level,
                 'difficulty', q.difficulty,
                 'math_topic', q.math_topic,
                 'source', q.source
               )::text
             )
           )::BIGINT
           FROM public.questions q
           INNER JOIN public.learning_files qlf ON qlf.id = q.learning_file_id
         ), 0)::BIGINT AS question_content_bytes
       FROM public.learning_files lf`
    );
    const row = result.rows[0] || {};
    const sourceFileBytes = Number(row.source_file_bytes || 0);
    const questionContentBytes = Number(row.question_content_bytes || 0);
    return res.json({
      used_bytes: Math.max(0, sourceFileBytes) + Math.max(0, questionContentBytes),
      source_file_bytes: Math.max(0, sourceFileBytes),
      question_content_bytes: Math.max(0, questionContentBytes),
    });
  } catch (err) {
    console.error('Fetch learning storage summary failed:', err.message);
    return res.status(500).json({ error: 'Failed to calculate managed-content storage.' });
  }
});

app.get('/api/learning-files/:id/questions', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    if (Number.isNaN(fileId)) return res.status(400).json({ error: 'Invalid file ID' });

    const fileResult = await pool.query(
      `SELECT *
       FROM public.learning_files
       WHERE id = $1 AND deleted_at IS NULL`,
      [fileId]
    );
    if (fileResult.rows.length === 0) return res.status(404).json({ error: 'File not found' });

    const validation = await getQuestionSetValidationState(pool, fileResult.rows[0]);

    res.json({
      file: normalizeLearningFileRow({
        ...fileResult.rows[0],
        validation_summary: buildQuestionSetValidationSummary(validation, fileResult.rows[0]),
      }),
      validation: buildQuestionSetValidationSummary(validation, fileResult.rows[0]),
      review_fingerprint: buildLearningFileApprovalFingerprint(fileResult.rows[0], validation.structural.questions),
      questions: validation.structural.questions.map((question) => ({
        ...question,
        difficulty: normalizeDifficultyValue(question.difficulty),
      })),
    });
  } catch (err) {
    console.error('Preview generated questions failed:', err.message);
    res.status(500).json({ error: 'Failed to preview questions' });
  }
});

app.post('/api/learning-files/:id/approve', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    if (Number.isNaN(fileId)) return res.status(400).json({ error: 'Invalid file ID' });
    const approved = await approveLearningFile(fileId, req.authenticatedUser);
    return res.json({ success: true, message: 'Question set approved for publication.', ...approved });
  } catch (err) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
        ...(err.reviewEligibility ? { review_eligibility: err.reviewEligibility } : {}),
      });
    }
    console.error('Approve question set failed:', err.message);
    return res.status(500).json({ error: 'Unable to approve this question set.' });
  }
});

app.get('/api/learning-files/:id/preview', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    if (Number.isNaN(fileId)) return res.status(400).json({ error: 'Invalid file ID' });
    const fileResult = await pool.query(
      'SELECT * FROM public.learning_files WHERE id = $1 AND deleted_at IS NULL',
      [fileId]
    );
    if (fileResult.rows.length === 0) return res.status(404).json({ error: 'File not found' });

    const rawFile = fileResult.rows[0];
    const file = normalizeLearningFileRow(rawFile);
    const filePath = file.file_url && !String(file.file_url).startsWith('http')
      ? path.join(__dirname, String(file.file_url).replace('/uploads/', 'uploads/'))
      : null;
    const lowerName = String(file.file_name || '').toLowerCase();
    const isTextPreview = /\.(json|csv)$/i.test(lowerName);
    let content = null;
    if (isTextPreview && Buffer.isBuffer(rawFile.source_file_bytes)) {
      content = rawFile.source_file_bytes.toString('utf8');
    } else if (isTextPreview && filePath && fs.existsSync(filePath)) {
      content = fs.readFileSync(filePath, 'utf8');
    }

    res.json({
      file,
      preview_kind: lowerName.endsWith('.pdf') ? 'pdf' : isTextPreview ? 'text' : 'download',
      content,
    });
  } catch (err) {
    console.error('Preview learning file failed:', err.message);
    res.status(500).json({ error: 'Failed to preview file' });
  }
});

app.put('/api/learning-files/:id/rename', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    if (Number.isNaN(fileId)) return res.status(400).json({ error: 'Invalid file ID' });
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'File name is required.' });

    const currentFileResult = await pool.query(
      'SELECT id, published, publish_status FROM public.learning_files WHERE id = $1 AND deleted_at IS NULL',
      [fileId]
    );
    const currentFile = currentFileResult.rows[0];
    if (!currentFile) return res.status(404).json({ error: 'File not found' });
    if (currentFile.published || currentFile.publish_status === 'active') {
      return res.status(409).json({
        error: 'This question set is Active in Game. Remove from Game before editing this question set.',
        code: 'ACTIVE_QUESTION_SET_CANNOT_BE_EDITED',
      });
    }

    const result = await pool.query(
      `UPDATE public.learning_files
       SET title = $1,
           approval_status = 'review_required',
           approved_at = NULL,
           approved_by = NULL,
           approved_content_fingerprint = NULL
       WHERE id = $2
         AND deleted_at IS NULL
         AND NOT (COALESCE(published, false) = true OR publish_status = 'active')
       RETURNING *`,
      [title, fileId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'File not found' });
    res.json({ success: true, learningFile: normalizeLearningFileRow(result.rows[0]) });
  } catch (err) {
    console.error('Rename learning file failed:', err.message);
    res.status(500).json({ error: 'Failed to rename file' });
  }
});

app.put('/api/learning-files/:id', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    if (Number.isNaN(fileId)) return res.status(400).json({ error: 'Invalid file ID' });
    const { title, grade_level, difficulty, topic_id, math_topic, file_type, folder_id } = req.body;
    if (!title || !grade_level || !difficulty || !file_type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const currentFileResult = await pool.query(
      'SELECT id, published, publish_status FROM public.learning_files WHERE id = $1 AND deleted_at IS NULL',
      [fileId]
    );
    const currentFile = currentFileResult.rows[0];
    if (!currentFile) return res.status(404).json({ error: 'File not found' });
    if (currentFile.published || currentFile.publish_status === 'active') {
      return res.status(409).json({
        error: 'This question set is Active in Game. Remove from Game before editing this question set.',
        code: 'ACTIVE_QUESTION_SET_CANNOT_BE_EDITED',
      });
    }
    const canonicalScope = resolveCanonicalQuestionScope({ grade_level, difficulty, topic_id, math_topic });
    if (!canonicalScope) {
      return res.status(400).json({ error: 'Grade level and Difficulty must use supported canonical values.' });
    }
    const normalizedGrade = canonicalScope.grade_level;
    const normalizedDifficulty = canonicalScope.difficulty;
    const normalizedTopicId = canonicalScope.topic_id;
    const normalizedTopic = canonicalScope.math_topic;
    const normalizedType = String(file_type).trim().toLowerCase();
    if (!isValidFileType(normalizedType)) {
      return res.status(400).json({ error: 'Invalid file type.' });
    }

    const folderResolution = await resolveLearningFolderId(folder_id);
    if (folderResolution.error) {
      return res.status(400).json({ error: folderResolution.error });
    }

    const result = await pool.query(
      `UPDATE public.learning_files
       SET title = $1,
           grade_level = $2,
           difficulty = $3,
           math_topic = COALESCE($4, math_topic),
           topic_id = COALESCE($5, topic_id),
           file_type = $6,
           folder_id = $7,
           published = false,
           publish_status = 'staged',
           published_at = NULL,
           published_by = NULL,
           approval_status = 'review_required',
           approved_at = NULL,
           approved_by = NULL,
           approved_content_fingerprint = NULL
     WHERE id = $8
        AND deleted_at IS NULL
        AND NOT (COALESCE(published, false) = true OR publish_status = 'active')
       RETURNING *`,
      [String(title).trim(), normalizedGrade, normalizedDifficulty, normalizedTopic, normalizedTopicId, normalizedType, folderResolution.folderId, fileId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'File not found' });

    await pool.query(
      `UPDATE public.questions
       SET grade_level = $1,
           difficulty = $2,
           math_topic = COALESCE($3, math_topic),
           topic_id = CASE WHEN source = 'ai' AND $4 IS NOT NULL THEN $4 ELSE topic_id END
       WHERE learning_file_id = $5`,
      [normalizedGrade, normalizedDifficulty, normalizedTopic, normalizedTopicId, fileId]
    );

    res.json(normalizeLearningFileRow(result.rows[0]));
  } catch (err) {
    console.error('Update learning file failed:', err.message);
    res.status(500).json({ error: 'Failed to update file' });
  }
});

app.delete('/api/learning-files/trash', requireLessonQuestionManagerAccess, async (req, res) => {
  const rawFileIds = req.body?.file_ids;
  const fileIds = Array.isArray(rawFileIds)
    ? rawFileIds.map((value) => Number(value))
    : [];
  const hasOnlySafeUniqueIds = fileIds.length > 0
    && fileIds.every((id) => Number.isSafeInteger(id) && id > 0)
    && new Set(fileIds).size === fileIds.length;
  if (!hasOnlySafeUniqueIds) {
    return res.status(400).json({ error: 'file_ids must be a non-empty list of unique positive integer IDs.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const filesResult = await client.query(
      `SELECT id, title, file_name, file_url, published, publish_status, deleted_at
       FROM public.learning_files
       WHERE id = ANY($1)
         AND deleted_at IS NOT NULL
       ORDER BY id ASC
       FOR UPDATE`,
      [fileIds]
    );
    const files = filesResult.rows;
    if (files.length !== fileIds.length) {
      throw createLifecycleHttpError('One or more selected files are no longer in Trash.', 404);
    }

    const activeFileIds = files
      .filter((file) => file.published || file.publish_status === 'active')
      .map((file) => file.id);
    if (activeFileIds.length > 0) {
      const error = createLifecycleHttpError('An Active in Game question set must be removed from Game before permanent deletion.', 409);
      error.code = 'ACTIVE_QUESTION_SET_CANNOT_BE_DELETED';
      error.blockedFileIds = activeFileIds;
      throw error;
    }

    const historicalResult = await client.query(
      `SELECT DISTINCT question_set_id
       FROM public.game_results
       WHERE question_set_id = ANY($1)`,
      [fileIds]
    );
    const historicalFileIds = historicalResult.rows
      .map((row) => Number(row.question_set_id))
      .filter((id) => Number.isSafeInteger(id));
    if (historicalFileIds.length > 0) {
      const error = createLifecycleHttpError('Question sets with historical results cannot be permanently deleted.', 409);
      error.code = 'QUESTION_SET_HISTORY_PREVENTS_PERMANENT_DELETE';
      error.blockedFileIds = historicalFileIds;
      throw error;
    }

    await client.query('DELETE FROM public.questions WHERE learning_file_id = ANY($1)', [fileIds]);
    const deletedResult = await client.query(
      `DELETE FROM public.learning_files
       WHERE id = ANY($1)
         AND deleted_at IS NOT NULL
       RETURNING id, file_url`,
      [fileIds]
    );
    if (deletedResult.rows.length !== fileIds.length) {
      throw createLifecycleHttpError('One or more selected files could not be permanently deleted.', 409);
    }
    await client.query('COMMIT');
    deletedResult.rows.forEach((file) => removeFileFromDisk(file.file_url));
    return res.json({ success: true, deleted_file_ids: deletedResult.rows.map((file) => file.id) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : 'Failed to empty Trash.',
      ...(err.code ? { code: err.code } : {}),
      ...(err.blockedFileIds ? { blocked_file_ids: err.blockedFileIds } : {}),
    });
  } finally {
    client.release();
  }
});

app.delete('/api/learning-files/:id', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    if (Number.isNaN(fileId)) return res.status(400).json({ error: 'Invalid file ID' });
    const currentFileResult = await pool.query(
      'SELECT * FROM public.learning_files WHERE id = $1 AND deleted_at IS NULL',
      [fileId]
    );
    const currentFile = currentFileResult.rows[0];
    if (!currentFile) return res.status(404).json({ error: 'File not found' });
    if (currentFile.published || currentFile.publish_status === 'active') {
      return res.status(409).json({
        error: 'This question set is Active in Game. Remove from Game before deleting this question set.',
        code: 'ACTIVE_QUESTION_SET_CANNOT_BE_DELETED',
      });
    }
    const fileResult = await pool.query(
      `UPDATE public.learning_files
       SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP),
           published = false
       WHERE id = $1
       RETURNING *`,
      [fileId]
    );
    if (fileResult.rows.length === 0) return res.status(404).json({ error: 'File not found' });
    await pool.query('UPDATE public.questions SET published = false WHERE learning_file_id = $1', [fileId]);
    res.json({ success: true, learningFile: normalizeLearningFileRow(fileResult.rows[0]) });
  } catch (err) {
    console.error('Move learning file to trash failed:', err.message);
    res.status(500).json({ error: 'Failed to move file to trash' });
  }
});

app.post('/api/learning-files/:id/restore', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    if (Number.isNaN(fileId)) return res.status(400).json({ error: 'Invalid file ID' });
    const result = await pool.query(
      'UPDATE public.learning_files SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING *',
      [fileId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Trashed file not found' });
    res.json({ success: true, learningFile: normalizeLearningFileRow(result.rows[0]) });
  } catch (err) {
    console.error('Restore learning file failed:', err.message);
    res.status(500).json({ error: 'Failed to restore file' });
  }
});

app.delete('/api/learning-files/:id/permanent', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    if (Number.isNaN(fileId)) return res.status(400).json({ error: 'Invalid file ID' });
    const fileResult = await pool.query(
      'SELECT * FROM public.learning_files WHERE id = $1 AND deleted_at IS NOT NULL',
      [fileId]
    );
    if (fileResult.rows.length === 0) return res.status(404).json({ error: 'Trashed file not found' });
    const file = fileResult.rows[0];
    if (file.published || file.publish_status === 'active') {
      return res.status(409).json({
        error: 'This question set is Active in Game. Remove from Game before permanently deleting this question set.',
        code: 'ACTIVE_QUESTION_SET_CANNOT_BE_DELETED',
      });
    }
    const historicalResult = await pool.query(
      'SELECT 1 FROM public.game_results WHERE question_set_id = $1 LIMIT 1',
      [fileId]
    );
    if (historicalResult.rows.length > 0) {
      return res.status(409).json({
        error: 'This question set has historical results and cannot be permanently deleted.',
      });
    }
    await pool.query('DELETE FROM public.questions WHERE learning_file_id = $1', [fileId]);
    await pool.query('DELETE FROM public.learning_files WHERE id = $1', [fileId]);
    removeFileFromDisk(file.file_url);
    res.json({ success: true });
  } catch (err) {
    console.error('Permanent learning file delete failed:', err.message);
    res.status(500).json({ error: 'Failed to permanently delete file' });
  }
});

app.post('/api/questions/publish/:id', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    if (Number.isNaN(fileId)) return res.status(400).json({ error: 'Invalid file ID' });
    const learningFile = await publishLearningFile(fileId, req.authenticatedUser, {
      confirmReplacement: req.body?.confirm_replacement === true,
    });
    res.json({ success: true, message: 'Content pushed to game.', learningFile });
  } catch (err) {
    console.error('Publish failed:', err.message);
    res.status(err.statusCode || 500).json({
      error: err.statusCode === 404 || err.statusCode === 422 ? err.message : 'Failed to publish content',
      ...(err.code ? { code: err.code } : {}),
      ...(err.questionValidation ? { validation: err.questionValidation } : {}),
      ...(err.publicationEligibility ? { publication_eligibility: err.publicationEligibility } : {}),
      ...(err.replacement ? { replacement: err.replacement } : {}),
    });
  }
});

app.post('/api/questions/unpublish/:id', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    if (Number.isNaN(fileId)) return res.status(400).json({ error: 'Invalid file ID' });
    const learningFile = await unpublishLearningFile(fileId, req.authenticatedUser);
    res.json({ success: true, message: 'Content removed from game.', learningFile });
  } catch (err) {
    console.error('Unpublish failed:', err.message);
    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : 'Failed to remove content from game',
      ...(err.code ? { code: err.code } : {}),
    });
  }
});

app.get('/api/curriculum/registry', requireLessonQuestionManagerAccess, (req, res) => {
  const registry = getPublicRegistrySnapshot();
  const etag = `"curriculum-registry-${registry.version}"`;
  res.set('ETag', etag);
  res.set('Cache-Control', 'private, max-age=300');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  return res.json(registry);
});

app.get('/api/game/questions', async (req, res) => {
  try {
    if ((!req.query.grade_level && !req.query.grade) || !req.query.difficulty) {
      return res.status(400).json({
        error: 'Grade and Difficulty are required for game questions.',
        code: 'QUESTION_SCOPE_REQUIRED',
      });
    }
    const scope = resolveQuestionPoolScope({
      grade_level: req.query.grade_level,
      grade: req.query.grade,
      difficulty: req.query.difficulty,
    });
    if (!scope) {
      return res.status(400).json({
        error: 'Grade and Difficulty must use supported canonical values.',
        code: 'QUESTION_SCOPE_INVALID',
      });
    }
    // Legacy Topic query values are accepted for old APK compatibility, but
    // they intentionally do not affect active-pool selection.
    const { questionSet } = await resolveActiveGameQuestionSet(scope);
    const selectedScope = { ...scope, question_set_id: questionSet?.id || null };
    const learningFiles = await getGameFiles(selectedScope);
    const gameQuestions = await getGameQuestions(selectedScope);
    if (gameQuestions.length > 0) {
      await markLearningFilesFetchedByGame(gameQuestions);
    }
    const availableQuestionCount = gameQuestions.length;
    const availability = availableQuestionCount >= GAME_QUESTION_SET_SIZE
      ? {
        available: true,
        code: 'QUESTION_POOL_READY',
        message: 'Published questions are available for this Grade and Difficulty.',
        expected_question_count: GAME_QUESTION_SET_SIZE,
        available_question_count: availableQuestionCount,
      }
      : availableQuestionCount === 0
        ? {
          available: false,
          code: 'QUESTION_POOL_EXHAUSTED',
          message: 'No published questions are available for this Grade and Difficulty yet.',
          expected_question_count: GAME_QUESTION_SET_SIZE,
          available_question_count: 0,
        }
        : {
          available: false,
          code: 'QUESTION_POOL_UNDERSIZED',
          message: 'The published question pool has fewer questions than this encounter requires.',
          expected_question_count: GAME_QUESTION_SET_SIZE,
          available_question_count: availableQuestionCount,
        };
    res.json({
      learning_files: learningFiles,
      questions: gameQuestions,
      availability,
      scope: {
        grade_level: scope.grade_level,
        difficulty: scope.difficulty,
        question_set_id: questionSet?.id || null,
      },
    });
  } catch (err) {
    if (err?.code === 'QUESTION_POOL_AMBIGUOUS') {
      return res.status(err.statusCode || 409).json({ error: err.message, code: err.code });
    }
    console.error('Fetch game questions failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch game content' });
  }
});

app.get('/api/learning-files/trash', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT lf.*,
              f.name AS folder_name,
              COALESCE(NULLIF(TRIM(a.name), ''), a.email, 'Unknown') AS uploaded_by_name
       FROM public.learning_files lf
       LEFT JOIN public.folders f ON lf.folder_id = f.id
       LEFT JOIN public.accounts a ON lf.uploaded_by = a.id
       WHERE lf.deleted_at IS NOT NULL
       ORDER BY lf.deleted_at DESC, lf.uploaded_at DESC`
    );
    res.json(result.rows.map(normalizeLearningFileRow));
  } catch (err) {
    console.error('Fetch trashed learning files failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch trashed files' });
  }
});

app.get('/api/announcements', async (req, res) => {
  try {
    const targetRole = normalizeAnnouncementTarget(req.query.target_role);
    if (!targetRole) {
      return res.status(400).json({ error: 'Valid target_role is required.' });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);
    const filters = ['an.target_role = $1'];
    const params = [targetRole];
    const createdBy = Number.parseInt(req.query.created_by, 10);
    const createdByRole = normalizeAnnouncementRole(req.query.created_by_role);

    if (!Number.isNaN(createdBy)) {
      params.push(createdBy);
      filters.push(`an.created_by = $${params.length}`);
    }

    if (createdByRole) {
      params.push(createdByRole);
      filters.push(`an.created_by_role = $${params.length}`);
    }

    params.push(limit);
    const result = await pool.query(
      `${announcementSelectSql}
       WHERE ${filters.join(' AND ')}
       ORDER BY an.created_at DESC
       LIMIT $${params.length}`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Fetch announcements failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch announcements' });
  }
});

app.put('/api/announcements/:id', async (req, res) => {
  try {
    const announcementId = parseInt(req.params.id, 10);
    const payload = normalizeAnnouncementManagementPayload(req.body);
    if (Number.isNaN(announcementId) || !payload) {
      return res.status(400).json({ error: 'Title, message, actor, and actor role are required.' });
    }

    const existing = await pool.query('SELECT * FROM public.announcements WHERE id = $1', [announcementId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Announcement not found.' });
    }

    if (!canManageAnnouncement(existing.rows[0], payload)) {
      return res.status(403).json({ error: 'You can only manage announcements you posted.' });
    }

    const result = await pool.query(
      `UPDATE public.announcements
       SET title = $1,
           message = $2
       WHERE id = $3
       RETURNING *`,
      [payload.title, payload.message, announcementId]
    );

    const hydrated = await pool.query(
      `${announcementSelectSql}
       WHERE an.id = $1`,
      [result.rows[0].id]
    );

    res.json(hydrated.rows[0]);
  } catch (err) {
    console.error('Update announcement failed:', err.message);
    res.status(500).json({ error: 'Failed to update announcement' });
  }
});

app.delete('/api/announcements/:id', async (req, res) => {
  try {
    const announcementId = parseInt(req.params.id, 10);
    const actor = normalizeAnnouncementActorPayload({ ...req.query, ...req.body });
    if (Number.isNaN(announcementId) || !actor) {
      return res.status(400).json({ error: 'Actor and actor role are required.' });
    }

    const existing = await pool.query('SELECT * FROM public.announcements WHERE id = $1', [announcementId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Announcement not found.' });
    }

    if (!canManageAnnouncement(existing.rows[0], actor)) {
      return res.status(403).json({ error: 'You can only manage announcements you posted.' });
    }

    await pool.query('DELETE FROM public.announcements WHERE id = $1', [announcementId]);
    res.json({ success: true, id: announcementId });
  } catch (err) {
    console.error('Delete announcement failed:', err.message);
    res.status(500).json({ error: 'Failed to delete announcement' });
  }
});

app.post('/api/announcements', async (req, res) => {
  try {
    const payload = normalizeAnnouncementPayload(req.body);
    if (!payload) {
      return res.status(400).json({ error: 'Title, message, creator, creator role, and target role are required.' });
    }

    if (
      (payload.createdByRole === 'admin' && payload.targetRole !== 'teacher') ||
      (payload.createdByRole === 'teacher' && payload.targetRole !== 'parent')
    ) {
      return res.status(400).json({ error: 'Announcement target does not match creator role.' });
    }

    const creatorRoles = payload.createdByRole === 'teacher' ? ['teacher', 'parent_teacher'] : [payload.createdByRole];
    const creatorResult = await pool.query(
      'SELECT id, name, role FROM public.accounts WHERE id = $1 AND LOWER(role) = ANY($2::text[]) AND COALESCE(is_archived, false) = false',
      [payload.createdBy, creatorRoles]
    );
    if (creatorResult.rows.length === 0) {
      return res.status(404).json({ error: 'Announcement creator not found.' });
    }

    const result = await pool.query(
      `INSERT INTO public.announcements (title, message, created_by, created_by_role, target_role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [payload.title, payload.message, payload.createdBy, payload.createdByRole, payload.targetRole]
    );

    res.status(201).json({
      ...result.rows[0],
      posted_by: creatorResult.rows[0].name,
    });
  } catch (err) {
    console.error('Create announcement failed:', err.message);
    res.status(500).json({ error: 'Failed to create announcement' });
  }
});

app.post('/api/game/parent/validate', async (req, res) => {
  try {
    const parentCode = normalizeParentCode(req.body?.parent_id);
    if (!parentCode) {
      return res.status(400).json({ ok: false, error: 'Parent ID must be exactly 6 digits.' });
    }

    const { parent, error } = await getValidatedActiveParentAccount(parentCode);
    if (error) {
      return res.status(error.status).json({ ok: false, success: false, error: error.message });
    }

    res.json({ ok: true, success: true, parent, message: 'Parent ID is valid.' });
  } catch (err) {
    console.error('Validate Parent ID failed:', err.message);
    res.status(500).json({ ok: false, success: false, error: 'Unable to connect to the server. Please try again.' });
  }
});

app.get('/api/game/learning-cycle/:student_id', async (req, res) => {
  try {
    const studentCode = normalizeStudentCode(req.params.student_id);
    const parentCode = normalizeParentCode(req.query.parent_id);
    if (!studentCode || !parentCode) {
      return res.status(400).json({ ok: false, error: 'Parent ID and Student ID must each be exactly 6 digits.' });
    }

    const { parent, error } = await getValidatedActiveParentAccount(parentCode);
    if (error) return res.status(error.status).json({ ok: false, error: error.message });

    const linkedStudent = await pool.query(
      `SELECT s.id, s.current_learning_cycle_version, s.current_learning_cycle_started_at
       FROM public.accounts s
       JOIN public.teacher_student_relationships r ON r.student_id = s.id
       WHERE r.teacher_id = $1
         AND s.game_student_id = $2
         AND LOWER(r.relationship_type) = 'parent'
         AND COALESCE(s.is_archived, false) = false
       LIMIT 1`,
      [parent.id, studentCode]
    );
    if (linkedStudent.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Student ID is not linked to this Parent account.' });
    }

    return res.json({ ok: true, learning_cycle: toLearningCycleDescriptor(linkedStudent.rows[0]) });
  } catch (err) {
    console.error('Game learning cycle lookup failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to retrieve the learning cycle.' });
  }
});

app.get('/api/game/profile/check/:student_id', async (req, res) => {
  try {
    const studentCode = normalizeStudentCode(req.params.student_id);
    const parentCode = normalizeParentCode(req.query.parent_id);
    if (!studentCode) {
      return res.status(400).json({ error: 'Student ID must be exactly 6 digits.' });
    }
    if (!parentCode) {
      return res.status(400).json({ error: 'Parent ID must be exactly 6 digits.' });
    }

    const { parent, error } = await getValidatedActiveParentAccount(parentCode);
    if (error) {
      return res.status(error.status).json({ ok: false, success: false, error: error.message });
    }

    const linkedStudent = await pool.query(
      `SELECT s.id, s.name, s.grade_level, s.section,
              s.current_learning_cycle_version, s.current_learning_cycle_started_at
       FROM public.accounts s
       JOIN public.teacher_student_relationships r ON r.student_id = s.id
       WHERE r.teacher_id = $1
         AND s.game_student_id = $2
         AND LOWER(r.relationship_type) = 'parent'
         AND COALESCE(s.is_archived, false) = false
       LIMIT 1`,
      [parent.id, studentCode]
    );

    if (linkedStudent.rows.length === 0) {
      const existingStudent = await pool.query(
        `SELECT id, is_archived
         FROM public.accounts
         WHERE game_student_id = $1
           AND LOWER(role) = 'student'
         LIMIT 1`,
        [studentCode]
      );
      if (existingStudent.rows.length > 0) {
        if (existingStudent.rows[0].is_archived) {
          return res.status(403).json({
            ok: false,
            exists: true,
            should_block: true,
            can_play: false,
            error: 'Student account is no longer active.',
            message: 'Student account is no longer active.',
          });
        }
        return res.status(403).json({
          ok: false,
          exists: true,
          should_block: true,
          can_play: false,
          error: 'This Student is not linked to this Parent account.',
          message: 'This Student is not linked to this Parent account.',
        });
      }
      return res.status(404).json({
        ok: false,
        exists: false,
        should_block: true,
        can_play: false,
        error: 'Student ID does not exist.',
        message: 'Student ID does not exist.',
      });
    }

    const existing = await pool.query(
      `SELECT 1
       FROM public.student_game_progress
       WHERE student_id = $1
       LIMIT 1`,
      [linkedStudent.rows[0].id]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        ok: false,
        exists: true,
        should_block: true,
        can_play: false,
        error: 'Student ID already has an existing game profile. Please use Load Game.',
        message: 'Student ID already has an existing game profile. Please use Load Game.',
      });
    }

    return res.json({
      ok: true,
      exists: false,
      should_block: false,
      can_play: true,
      canonical_profile: {
        name: linkedStudent.rows[0].name,
        grade_level: linkedStudent.rows[0].grade_level,
        section: linkedStudent.rows[0].section ?? null,
      },
      learning_cycle: toLearningCycleDescriptor(linkedStudent.rows[0]),
      message: 'Student ID is available for a new game.',
    });
  } catch (err) {
    console.error('Game profile check failed:', err.message);
    return res.status(500).json({ error: 'Failed to check existing game profile.' });
  }
});

app.post('/api/game/progress', async (req, res) => {
  const {
    parent_id,
    student_name,
    grade,
    section,
    current_quest,
    quest_progress,
    lesson_progress,
    score,
    correct_answers,
    total_questions,
    save_status = 'saved',
    activity_description = 'Gameplay progress saved',
    login_time,
    logout_time,
  } = req.body || {};
  const grade_level = req.body?.grade_level || grade;
  const current_scene = req.body?.current_scene || req.body?.currentScene || req.body?.scene || req.body?.scene_name || null;
  const current_map = req.body?.current_map || req.body?.currentMap || req.body?.map || req.body?.map_name || null;
  const difficulty_level = resolveDifficultyFromScene({ ...req.body, current_scene, current_map });
  const total_play_time = req.body?.total_play_time ?? req.body?.duration_seconds ?? req.body?.duration;
  const normalizedProgressPayload = {
    ...req.body,
    accuracy_rate: req.body?.accuracy_rate ?? req.body?.accuracy,
    lesson_progress: lesson_progress ?? req.body?.completion_percentage,
    quest_progress: quest_progress ?? req.body?.completion_percentage,
  };
  const activityTimestamp = req.body?.timestamp || req.body?.played_at || req.body?.last_played || null;

  const parentCode = normalizeParentCode(parent_id);
  const studentName = normalizeGameStudentName(student_name);

  if (!parentCode) {
    return res.status(400).json({ error: 'Parent ID must be exactly 6 digits.' });
  }
  if (!studentName) {
    return res.status(400).json({ error: 'Student/Player Name is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const parentResult = await client.query(
      `SELECT id, name, parent_id
       FROM public.accounts
       WHERE parent_id = $1
         AND LOWER(role) IN ('parent', 'parent_teacher')
          AND COALESCE(is_archived, false) = false
       LIMIT 1`,
      [parentCode]
    );

    if (parentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Parent ID not found.' });
    }

    const parent = parentResult.rows[0];
    // Prefer authoritative six-digit student code when provided.
    const submittedStudentCode = normalizeStudentCode(String(req.body?.student_id || '').trim());
    let student = null;
    let studentResult = null;
    let isLinkedCanonicalChild = false;

    if (submittedStudentCode) {
      // Attempt to find a student account with this game_student_id linked to this parent
      studentResult = await client.query(
        `SELECT s.*
         FROM public.accounts s
         JOIN public.teacher_student_relationships r ON r.student_id = s.id
         WHERE r.teacher_id = $1
           AND s.game_student_id = $2
           AND LOWER(r.relationship_type) = 'parent'
           AND COALESCE(s.is_archived, false) = false
         LIMIT 1`,
        [parent.id, submittedStudentCode]
      );

      if (studentResult.rows.length > 0) {
        student = studentResult.rows[0];
        isLinkedCanonicalChild = true;
      } else {
        // If an account exists with this student code but not linked to this parent, reject.
        const existing = await client.query('SELECT * FROM public.accounts WHERE game_student_id = $1 LIMIT 1', [submittedStudentCode]);
        if (existing.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Student is not linked to this parent.' });
        }

        // No existing account with this code: create a new student account tied to this code.
        const studentPassword = await hashPassword(generateRandomPassword());
        const email = buildGameStudentEmail(parent.id, studentName || `student-${submittedStudentCode}`);
        studentResult = await client.query(
          `INSERT INTO public.accounts (name, email, password, role, status, is_archived, must_change_password, game_student_id)
           VALUES ($1, $2, $3, 'student', 'Offline', false, false, $4)
           RETURNING *`,
          [studentName || '', email, studentPassword, submittedStudentCode]
        );
        student = studentResult.rows[0];
      }
    } else {
      // Backwards-compatible numeric student_id (database id) path
      const submittedStudentId = resolveScopeId(req.body?.student_id ?? req.body?.resolved_student_id);
      if (submittedStudentId && !Number.isNaN(submittedStudentId)) {
        studentResult = await client.query(
          `SELECT s.*
           FROM public.accounts s
           JOIN public.teacher_student_relationships r ON r.student_id = s.id
           WHERE r.teacher_id = $1
             AND r.student_id = $2
             AND LOWER(r.relationship_type) = 'parent'
             AND COALESCE(s.is_archived, false) = false
           LIMIT 1`,
          [parent.id, submittedStudentId]
        );
        if (studentResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Student is not linked to this parent.' });
        }
        student = studentResult.rows[0];
        isLinkedCanonicalChild = true;
      } else {
        // Fallback to matching by name (least preferred)
        studentResult = await client.query(
          `SELECT s.*
           FROM public.accounts s
           JOIN public.teacher_student_relationships r ON r.student_id = s.id
           WHERE r.teacher_id = $1
             AND LOWER(r.relationship_type) = 'parent'
             AND LOWER(TRIM(s.name)) = LOWER($2)
           ORDER BY s.id
           LIMIT 1`,
          [parent.id, studentName]
        );
        if (studentResult.rows.length > 0) {
          student = studentResult.rows[0];
          isLinkedCanonicalChild = true;
        }
      }
    }

    await ensureParentStudentRelationship(client, {
      teacherId: parent.id,
      studentId: student.id,
      relationshipType: 'parent',
    });

    // A linked Parent-created child profile is the authority for identity and
    // school metadata. Legacy New Game registrations keep their submitted
    // values until a managed profile exists.
    const resolvedStudentName = normalizeGameStudentName(student.name) || studentName;
    const resolvedGradeLevel = String(student.grade_level || '').trim() || grade_level || null;
    const canonicalSection = String(student.section || '').trim() || null;
    const resolvedSection = isLinkedCanonicalChild
      ? canonicalSection
      : canonicalSection || section || null;

    const lifecycleLease = await validateProgressLearningCycleLease(client, {
      studentId: student.id,
      sessionId: resolvePositiveInteger(req.body?.playtime_session_id),
      sessionCredential: String(req.body?.playtime_session_credential || '').trim(),
    });
    if (!lifecycleLease.ok) {
      await client.query('ROLLBACK');
      if (lifecycleLease.staleSessionId) {
        await finalizeStalePlaytimeSession(lifecycleLease.staleSessionId);
      }
      return res.status(lifecycleLease.status).json(lifecycleLease.body);
    }

    const scoreValue = Math.round(toNullableNumber(score) ?? 0);
    const correctAnswersValue = Math.round(toNullableNumber(correct_answers) ?? 0);
    const totalQuestionsValue = Math.round(toNullableNumber(total_questions) ?? 0);
    const questProgressValue = Math.min(100, Math.max(0, toNullableNumber(normalizedProgressPayload.quest_progress) ?? 0));
    const progressPercentageValue = resolveProgressPercentage(normalizedProgressPayload);
    const lessonProgressValue = Math.min(100, Math.max(0, toNullableNumber(normalizedProgressPayload.lesson_progress) ?? progressPercentageValue));
    const accuracyRateValue = resolveAccuracyRate(normalizedProgressPayload);
    const totalPlayTimeValue = Math.round(toNullableNumber(total_play_time) ?? 0);
    const totalQuestsCompletedValue = Math.round(toNullableNumber(req.body?.total_quests_completed ?? req.body?.quests_completed) ?? 0);

    const existingProgress = await client.query(
      `SELECT id
       FROM public.student_game_progress
       WHERE student_id = $1
       ORDER BY updated_at DESC NULLS LAST, id DESC
       LIMIT 1`,
      [student.id]
    );

    let progressResult;
    if (existingProgress.rows.length > 0) {
      progressResult = await client.query(
        `UPDATE public.student_game_progress
         SET student_name = $1,
             grade_level = COALESCE($2, grade_level),
             section = COALESCE($3, section),
             current_quest = COALESCE($4, current_quest),
             score = $5,
             correct_answers = $6,
             total_questions = $7,
             accuracy_rate = $8,
             progress_percentage = $9,
             lesson_progress = $10,
             total_quests_completed = GREATEST(COALESCE(total_quests_completed, 0), $11),
             total_play_time = GREATEST(COALESCE(total_play_time, 0), $12),
             current_scene = COALESCE($13, current_scene),
             current_map = COALESCE($14, current_map),
             difficulty_level = $15,
             last_played = NOW(),
             updated_at = NOW()
         WHERE id = $16
         RETURNING *`,
        [
          resolvedStudentName,
          resolvedGradeLevel,
          resolvedSection,
          current_quest || null,
          scoreValue,
          correctAnswersValue,
          totalQuestionsValue,
          accuracyRateValue,
          progressPercentageValue,
          lessonProgressValue,
          totalQuestsCompletedValue,
          totalPlayTimeValue,
          current_scene,
          current_map,
          difficulty_level,
          existingProgress.rows[0].id,
        ]
      );
    } else {
      progressResult = await client.query(
        `INSERT INTO public.student_game_progress (
          student_id, student_name, grade_level, section, current_quest,
          score, correct_answers, total_questions, accuracy_rate,
          progress_percentage, lesson_progress, total_quests_completed, total_play_time,
          current_scene, current_map, difficulty_level, last_played, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW(), NOW()
        )
        RETURNING *`,
        [
          student.id,
          resolvedStudentName,
          resolvedGradeLevel,
          resolvedSection,
          current_quest || null,
          scoreValue,
          correctAnswersValue,
          totalQuestionsValue,
          accuracyRateValue,
          progressPercentageValue,
          lessonProgressValue,
          totalQuestsCompletedValue,
          totalPlayTimeValue,
          current_scene,
          current_map,
          difficulty_level,
        ]
      );
    }

    const activityResult = await client.query(
      `INSERT INTO public.activity_logs (
        student_id, student_name, grade_level, section, current_quest,
        save_status, total_play_time, last_played, quest_progress, lesson_progress,
        difficulty_level, role, status, activity_description, current_scene, current_map,
        login_time, logout_time, session_date, activity_timestamp, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, COALESCE($12, NOW()), $8, $9, $10, 'Student', 'Online', $11, $14, $15,
        COALESCE($12, NOW()), $13, CURRENT_DATE, COALESCE($12, NOW()), NOW()
      )
      RETURNING *`,
      [
        student.id,
        resolvedStudentName,
        resolvedGradeLevel,
        resolvedSection,
        current_quest || null,
        save_status,
        totalPlayTimeValue,
        questProgressValue,
        lessonProgressValue,
        difficulty_level,
        activity_description,
        login_time || activityTimestamp,
        logout_time || null,
        current_scene,
        current_map,
      ]
    );

    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      parent,
      student: serializeUser(student),
      progress: progressResult.rows[0],
      activityLog: activityResult.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Save game progress failed:', err.message);
    res.status(500).json({ error: 'Failed to save game progress', details: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/game/result', async (req, res) => {
  const {
    parent_id,
    student_id,
    resolved_student_id,
    student_name,
    grade,
    topic,
    score,
  } = req.body || {};
  const grade_level = req.body?.grade_level || grade;
  const math_topic = req.body?.math_topic || topic;
  const total_items = req.body?.total_items ?? req.body?.total_questions;
  const played_at = req.body?.played_at || req.body?.timestamp;
  const playtimeSessionId = resolvePositiveInteger(req.body?.playtime_session_id);
  const playtimeSessionCredential = String(req.body?.playtime_session_credential || '').trim();
  // A game question carries its own canonical difficulty.  Keep that value for
  // analytics, and only infer from the scene for older clients that do not
  // report a question difficulty yet.
  const reportedDifficulty = normalizeDifficultyValue(req.body?.difficulty || req.body?.difficulty_level);
  const difficulty = reportedDifficulty || resolveDifficultyFromScene(req.body || {});

  const parentCode = normalizeParentCode(parent_id);
  const submittedStudentCode = normalizeStudentCode(student_id);
  const submittedStudentId = submittedStudentCode ? null : resolveScopeId(student_id ?? resolved_student_id);
  const studentName = normalizeGameStudentName(student_name);
  const scoreValue = toNullableNumber(score);
  const totalItemsValue = toNullableNumber(total_items);
  const percentage = calculateGameResultPercentage({ score, totalItems: total_items });

  if (!parentCode) {
    return res.status(400).json({ error: 'Parent ID must be exactly 6 digits.' });
  }
  if (!submittedStudentCode && Number.isNaN(submittedStudentId)) {
    return res.status(400).json({ error: 'Student ID must be a valid number.' });
  }
  if (!studentName && !submittedStudentId && !submittedStudentCode) {
    return res.status(400).json({ error: 'Student/Player Name or Student ID is required.' });
  }
  if (scoreValue === null || totalItemsValue === null || totalItemsValue <= 0 || percentage === null) {
    return res.status(400).json({ error: 'score and total_items must be valid quiz totals.' });
  }
  if (Number.isNaN(playtimeSessionId) || !playtimeSessionId || !playtimeSessionCredential) {
    return res.status(400).json({ error: 'An active playtime session is required to save a game result.' });
  }

  try {
    const parentResult = await pool.query(
      `SELECT id, parent_id
       FROM public.accounts
       WHERE parent_id = $1
         AND LOWER(role) IN ('parent', 'parent_teacher')
         AND COALESCE(is_archived, false) = false
       LIMIT 1`,
      [parentCode]
    );

    if (parentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Parent ID not found.' });
    }

    const parent = parentResult.rows[0];
    // Keep result ingestion non-destructive: unresolved names stay reviewable instead of auto-creating a child here.
    let resolvedStudentId = null;
    let resultStudentName = studentName;
    let resultGradeLevel = grade_level;
    if (submittedStudentCode) {
      const studentResult = await pool.query(
        `SELECT s.id, s.name, s.grade_level
         FROM public.accounts s
         JOIN public.teacher_student_relationships r ON r.student_id = s.id
         WHERE r.teacher_id = $1
           AND s.game_student_id = $2
           AND LOWER(r.relationship_type) = 'parent'
           AND COALESCE(s.is_archived, false) = false
         LIMIT 1`,
        [parent.id, submittedStudentCode]
      );
      if (studentResult.rows.length === 0) {
        return res.status(403).json({ error: 'Student is not linked to this parent.' });
      }
      resolvedStudentId = studentResult.rows[0].id;
      resultStudentName = String(studentResult.rows[0].name || '').trim() || resultStudentName || `Student ${submittedStudentCode}`;
      resultGradeLevel = String(studentResult.rows[0].grade_level || '').trim() || resultGradeLevel;
    } else if (submittedStudentId) {
      const studentResult = await pool.query(
        `SELECT s.id, s.name, s.grade_level
         FROM public.accounts s
         JOIN public.teacher_student_relationships r ON r.student_id = s.id
         WHERE r.teacher_id = $1
           AND r.student_id = $2
           AND LOWER(r.relationship_type) = 'parent'
           AND COALESCE(s.is_archived, false) = false
         LIMIT 1`,
        [parent.id, submittedStudentId]
      );
      if (studentResult.rows.length === 0) {
        return res.status(403).json({ error: 'Student is not linked to this parent.' });
      }
      resolvedStudentId = studentResult.rows[0].id;
      resultStudentName = String(studentResult.rows[0].name || '').trim() || resultStudentName || `Student ${resolvedStudentId}`;
      resultGradeLevel = String(studentResult.rows[0].grade_level || '').trim() || resultGradeLevel;
    } else {
      const studentResult = await pool.query(
        `SELECT s.id, s.name, s.grade_level
         FROM public.accounts s
         JOIN public.teacher_student_relationships r ON r.student_id = s.id
         WHERE r.teacher_id = $1
           AND LOWER(r.relationship_type) = 'parent'
           AND LOWER(TRIM(s.name)) = LOWER($2)
           AND COALESCE(s.is_archived, false) = false
         ORDER BY s.id
         LIMIT 1`,
        [parent.id, studentName]
      );
      resolvedStudentId = studentResult.rows[0]?.id || null;
      resultStudentName = String(studentResult.rows[0]?.name || '').trim() || studentName;
      resultGradeLevel = String(studentResult.rows[0]?.grade_level || '').trim() || resultGradeLevel;
    }

    const playtimeSessionResult = await pool.query(
      `SELECT id, student_id, parent_id, status, expires_at, session_credential_hash,
              COALESCE(learning_cycle_version, 0) AS learning_cycle_version,
              (SELECT COALESCE(a.current_learning_cycle_version, 0)
                 FROM public.accounts a
                WHERE a.id = public.playtime_sessions.student_id) AS current_learning_cycle_version,
              (${getPlaytimeHeartbeatStaleSql()}) AS heartbeat_stale
       FROM public.playtime_sessions
       WHERE id = $1
         AND student_id = $2
         AND parent_id = $3
         AND status = 'Playing'
         AND expires_at > NOW()
       LIMIT 1`,
      [playtimeSessionId, resolvedStudentId, parentCode]
    );
    const playtimeSession = playtimeSessionResult.rows[0];
    if (!playtimeSession) {
      return res.status(403).json({ error: 'The active playtime session has expired or is invalid.' });
    }
    if (!hasMatchingPlaytimeSessionCredential(playtimeSessionCredential, playtimeSession.session_credential_hash)) {
      return res.status(403).json({ error: 'The active playtime session credential is invalid.' });
    }
    if (playtimeSession.heartbeat_stale) {
      await finalizeStalePlaytimeSession(playtimeSessionId);
      return res.status(409).json({
        code: 'PLAYTIME_HEARTBEAT_STALE',
        error: 'The playtime session is no longer active. Start a new session to continue.',
      });
    }
    if (Number(playtimeSession.learning_cycle_version ?? 0) !== Number(playtimeSession.current_learning_cycle_version ?? 0)) {
      return res.status(409).json({
        code: 'LEARNING_CYCLE_CHANGED',
        error: 'This result belongs to a previous learning cycle. Start a new game for the current cycle.',
      });
    }

    const questionSetResolution = await resolveGameResultQuestionSet({
      rawQuestionSetId: req.body?.question_set_id,
      gradeLevel: resultGradeLevel,
      difficulty,
    });
    if (questionSetResolution.error) {
      return res.status(400).json({ error: questionSetResolution.error });
    }

    await pool.query(
      `INSERT INTO public.game_results (
         parent_id, student_name, resolved_student_id, grade_level, difficulty,
          math_topic, score, total_items, percentage, played_at, question_set_id, playtime_session_id, is_unlinked
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, NOW()), $11, $12, $13
        )`,
      [
        parentCode,
        resultStudentName,
        resolvedStudentId,
        resultGradeLevel || null,
        difficulty,
        math_topic || null,
        Math.round(scoreValue),
        Math.round(totalItemsValue),
        percentage,
        played_at || null,
        questionSetResolution.questionSetId,
        playtimeSessionId,
        !resolvedStudentId,
      ]
    );
    if (resolvedStudentId) {
      await markStudentInsightStale(pool, resolvedStudentId);
    }

    res.status(201).json({ success: true, resolved: Boolean(resolvedStudentId), student_id: resolvedStudentId });
  } catch (err) {
    console.error('Save game result failed:', err.message);
    res.status(500).json({ error: 'Failed to save game result', details: err.message });
  }
});

const CANONICAL_GAME_ACTIVITY_TYPES = Object.freeze({
  task_triggered: 'Task Triggered',
  task_completed: 'Task Completed',
  quest_completed: 'Quest Completed',
});

const normalizeCanonicalGameActivityKey = (value) => {
  const key = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._:-]{0,191}$/.test(key) ? key : null;
};

const normalizeCanonicalGameTaskId = (value) => {
  const taskId = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,95}$/.test(taskId) ? taskId : null;
};

app.post('/api/game/activity', async (req, res) => {
  try {
    const body = req.body || {};
    const forbiddenIdentityFields = ['student_id', 'student_name', 'grade', 'grade_level', 'section', 'parent_id'];
    if (forbiddenIdentityFields.some((field) => Object.prototype.hasOwnProperty.call(body, field))) {
      return res.status(400).json({ error: 'Canonical student identity is resolved from the active playtime session.' });
    }

    const sessionId = resolvePositiveInteger(body.session_id);
    const sessionCredential = String(body.session_credential || '').trim();
    const learningCycleVersion = Number(body.learning_cycle_version);
    const eventType = String(body.event_type || '').trim().toLowerCase();
    const eventKey = normalizeCanonicalGameActivityKey(body.event_key);
    const taskId = normalizeCanonicalGameTaskId(body.task_id);
    if (!sessionId || Number.isNaN(sessionId) || !sessionCredential || !Number.isInteger(learningCycleVersion)) {
      return res.status(400).json({ error: 'A valid current playtime lease and learning cycle are required.' });
    }
    if (!Object.prototype.hasOwnProperty.call(CANONICAL_GAME_ACTIVITY_TYPES, eventType)) {
      return res.status(400).json({ error: 'Unsupported canonical game activity type.' });
    }
    if (!eventKey || !taskId) {
      return res.status(400).json({ error: 'A valid task ID and stable event key are required.' });
    }

    const sessionResult = await pool.query(
      `SELECT ps.id,
              ps.student_id,
              ps.session_credential_hash,
              COALESCE(ps.learning_cycle_version, 0) AS learning_cycle_version,
              COALESCE(a.current_learning_cycle_version, 0) AS current_learning_cycle_version,
              a.name AS student_name,
              a.grade_level,
              a.section
       FROM public.playtime_sessions ps
       JOIN public.accounts a ON a.id = ps.student_id
       WHERE ps.id = $1
         AND ps.status = 'Playing'
         AND ps.end_time IS NULL
         AND ps.expires_at > NOW()
         AND NOT (${getPlaytimeHeartbeatStaleSql('ps.')})
         AND COALESCE(a.is_archived, false) = false
       LIMIT 1`,
      [sessionId]
    );
    const session = sessionResult.rows[0];
    if (!session || !hasMatchingPlaytimeSessionCredential(sessionCredential, session.session_credential_hash)) {
      return res.status(403).json({ error: 'The active playtime session is invalid.' });
    }
    if (Number(session.learning_cycle_version) !== Number(session.current_learning_cycle_version)
      || Number(session.learning_cycle_version) !== learningCycleVersion) {
      return res.status(409).json({
        code: 'LEARNING_CYCLE_CHANGED',
        error: 'This activity belongs to a previous learning cycle. Start a new game for the current cycle.',
      });
    }

    const displayLabel = CANONICAL_GAME_ACTIVITY_TYPES[eventType];
    const insertResult = await pool.query(
      `INSERT INTO public.activity_logs (
         student_id, student_name, grade_level, section, activity_description,
         current_quest, role, status, activity_timestamp, event_key
       ) VALUES ($1, $2, $3, $4, $5, $6, 'student', 'Active', CURRENT_TIMESTAMP, $7)
       ON CONFLICT (student_id, event_key) WHERE event_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        session.student_id,
        String(session.student_name || 'Student').trim() || 'Student',
        session.grade_level || null,
        session.section || null,
        `${displayLabel} — ${taskId}`,
        taskId,
        eventKey,
      ]
    );

    return res.status(insertResult.rows.length ? 201 : 200).json({
      success: true,
      duplicate: insertResult.rows.length === 0,
      event_type: eventType,
    });
  } catch (err) {
    console.error('Canonical game activity failed:', err.message);
    return res.status(500).json({ error: 'Failed to record canonical game activity.' });
  }
});

app.post('/api/game/leaderboard', async (req, res) => {
  try {
    const sessionId = resolvePositiveInteger(req.body?.session_id);
    const sessionCredential = String(req.body?.session_credential || '').trim();
    const learningCycleVersion = Number(req.body?.learning_cycle_version);
    if (!sessionId || Number.isNaN(sessionId) || !sessionCredential || !Number.isInteger(learningCycleVersion)) {
      return res.status(400).json({ error: 'A valid current playtime lease and learning cycle are required.' });
    }

    const sessionResult = await pool.query(
      `SELECT ps.id,
              ps.student_id,
              ps.session_credential_hash,
              COALESCE(ps.learning_cycle_version, 0) AS learning_cycle_version,
              COALESCE(a.current_learning_cycle_version, 0) AS current_learning_cycle_version,
              (${getPlaytimeHeartbeatStaleSql('ps.')}) AS heartbeat_stale
       FROM public.playtime_sessions ps
       JOIN public.accounts a ON a.id = ps.student_id
       WHERE ps.id = $1
         AND ps.status = 'Playing'
         AND ps.end_time IS NULL
         AND ps.expires_at > NOW()
         AND COALESCE(a.is_archived, false) = false
       LIMIT 1`,
      [sessionId]
    );
    const session = sessionResult.rows[0];
    if (!session || !hasMatchingPlaytimeSessionCredential(sessionCredential, session.session_credential_hash)) {
      return res.status(403).json({ error: 'The active playtime session is invalid.' });
    }
    if (session.heartbeat_stale) {
      await finalizeStalePlaytimeSession(sessionId);
      return res.status(409).json({
        code: 'PLAYTIME_HEARTBEAT_STALE',
        error: 'The playtime session is no longer active. Start a new session to continue.',
      });
    }
    if (Number(session.learning_cycle_version) !== Number(session.current_learning_cycle_version)
      || Number(session.learning_cycle_version) !== learningCycleVersion) {
      return res.status(409).json({
        code: 'LEARNING_CYCLE_CHANGED',
        error: 'This leaderboard request belongs to a previous learning cycle. Start a new game for the current cycle.',
      });
    }

    const result = await pool.query(
      `SELECT progress_percentage,
              accuracy_rate,
              correct_answers,
              total_questions,
              total_quests_completed
       FROM (
         SELECT p.student_id,
                p.progress_percentage,
                p.accuracy_rate,
                p.correct_answers,
                p.total_questions,
                COALESCE(p.total_quests_completed, 0) AS total_quests_completed,
                ROW_NUMBER() OVER (
                  PARTITION BY p.student_id
                  ORDER BY p.progress_percentage DESC NULLS LAST,
                           p.accuracy_rate DESC NULLS LAST,
                           p.correct_answers DESC NULLS LAST,
                           COALESCE(p.total_quests_completed, 0) DESC,
                           p.updated_at DESC NULLS LAST,
                           p.id DESC
                ) AS student_rank
         FROM public.student_game_progress p
         JOIN public.accounts a ON a.id = p.student_id
         WHERE COALESCE(a.is_archived, false) = false
           AND a.progress_archived_at IS NULL
           AND (
             a.current_learning_cycle_started_at IS NULL
             OR p.updated_at >= a.current_learning_cycle_started_at
           )
       ) ranked_progress
       WHERE student_rank = 1
       ORDER BY progress_percentage DESC NULLS LAST,
                accuracy_rate DESC NULLS LAST,
                correct_answers DESC NULLS LAST,
                total_quests_completed DESC
       LIMIT 10`
    );

    return res.json({
      entries: result.rows.map((row, index) => ({
        rank: index + 1,
        display_name: `Player ${index + 1}`,
        progress_percentage: row.progress_percentage ?? null,
        accuracy_rate: row.accuracy_rate ?? null,
        correct_answers: row.correct_answers ?? null,
        total_questions: row.total_questions ?? null,
        quests_completed: row.total_quests_completed ?? 0,
      })),
    });
  } catch (err) {
    console.error('Fetch game leaderboard failed:', err.message);
    return res.status(500).json({ error: 'Failed to fetch the game leaderboard.' });
  }
});

app.delete('/api/accounts/:id', requireAccountManagementAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const permanent = String(req.query.permanent).toLowerCase() === 'true';
    const accountResult = await pool.query('SELECT id, email, role, is_archived FROM public.accounts WHERE id = $1', [id]);
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }
    const targetAccount = accountResult.rows[0];
    const accountRole = normalizeAccountRole(targetAccount.role);
    if (isSameAccount(req.authenticatedUser, targetAccount, id)) {
      return res.status(403).json({ error: 'You cannot delete your own account.' });
    }
    if (!isWebsiteManagedAccountRole(accountRole)) {
      return res.status(403).json({ error: 'Manage Users can only delete website accounts.' });
    }
    if (accountRole === 'admin') {
      const activeAdminCount = await countActiveAdminAccounts();
      if (!targetAccount.is_archived && activeAdminCount <= 1) {
        return res.status(403).json({ error: permanent ? 'Cannot delete the last admin account.' : 'Cannot archive the last admin account.' });
      }
    }

    const reasonResult = resolveAccountRemovalReason(req.body?.reason);
    if (reasonResult.error) {
      return res.status(400).json({ error: reasonResult.error });
    }
    if (permanent && !targetAccount.is_archived) {
      return res.status(409).json({ error: 'Only archived accounts can be permanently deleted.' });
    }
    if (permanent && req.body?.permanent_confirmation !== 'DELETE') {
      return res.status(400).json({ error: 'Type DELETE to confirm permanent account deletion.' });
    }
    const auditOptions = {
      reason: reasonResult.reason,
      operationType: permanent ? 'permanent_delete' : 'archive',
    };

    if (permanent) {
      await pool.query('DELETE FROM public.login_otp_device_skips WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM public.accounts WHERE id = $1', [id]);
      await writeAdminAuditLog(req.authenticatedUser, 'Delete Account', targetAccount, auditOptions);
      return res.json({ success: true, message: 'Account permanently deleted' });
    }

    const archiveResult = await pool.query(
      `UPDATE public.accounts
       SET is_archived = true,
           status = 'Offline',
           otp_code = NULL,
           otp_expires_at = NULL,
           session_version = COALESCE(session_version, 0) + 1
       WHERE id = $1
      RETURNING *`,
      [id]
    );
    await pool.query('DELETE FROM public.login_otp_device_skips WHERE user_id = $1', [id]);
    await writeAdminAuditLog(req.authenticatedUser, 'Archive Account', archiveResult.rows[0] || targetAccount, auditOptions);
    res.json({ success: true, message: 'Account archived' });
  } catch (err) {
    console.error('Delete/archive failed:', err.message);
    res.status(500).json({ error: 'Delete/archive failed' });
  }
});

app.post('/api/accounts/:id/restore', requireAccountManagementAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const accountResult = await pool.query('SELECT id, role FROM public.accounts WHERE id = $1', [id]);
    if (accountResult.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
    if (!isWebsiteManagedAccountRole(accountResult.rows[0].role)) {
      return res.status(403).json({ error: 'Manage Users can only restore website accounts.' });
    }

    const result = await pool.query('UPDATE public.accounts SET is_archived = false WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
    await writeAdminAuditLog(req.authenticatedUser, 'Restore Account', result.rows[0], { operationType: 'restore' });
    res.json({ success: true, message: 'Account restored', user: serializeUser(result.rows[0]) });
  } catch (err) {
    console.error('Restore failed:', err.message);
    res.status(500).json({ error: 'Restore failed' });
  }
});

app.post('/api/reset-password/send-code', async (req, res) => {
  const email = req.body.email.toLowerCase().trim();
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  try {
    const result = await pool.query('SELECT * FROM accounts WHERE LOWER(email)=$1', [email]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Email not found' });
    await pool.query('UPDATE accounts SET otp_code=$1, otp_expires_at=$2 WHERE LOWER(email)=$3', [otp, expiresAt, email]);
    const emailSent = await sendSystemEmail({
      to: email,
      subject: 'Password Reset Code',
      html: `<p>Your code is: <b>${otp}</b></p><p>This code expires in 10 minutes.</p>`
    });
    if (!emailSent) return res.status(503).json({ error: 'Email service unavailable' });
    res.json({ success: true, expiresAt });
  } catch (err) { console.error('Reset password code failed:', err.message); res.status(500).json({ error: 'Reset failed' }); }
});

app.post('/api/reset-password/verify', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  try {
    const result = await pool.query('SELECT * FROM accounts WHERE LOWER(email)=$1 AND otp_code=$2', [email.toLowerCase().trim(), otp]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid code' });

    const user = result.rows[0];
    if (user.otp_expires_at && new Date(user.otp_expires_at) < new Date()) {
      return res.status(401).json({ error: 'OTP expired' });
    }

    const hashedPassword = await hashPassword(newPassword);
    await pool.query('UPDATE accounts SET password=$1, otp_code=NULL, otp_expires_at=NULL WHERE LOWER(email)=$2', [hashedPassword, email.toLowerCase().trim()]);
    res.json({ success: true });
  } catch (err) { console.error('Reset password verify failed:', err.message); res.status(500).json({ error: 'Update failed' }); }
});

// --- NEW: Change Password with OTP (Step 1: Request OTP) ---
app.post('/api/request-password-change-otp', requireWebsiteManagedAccount, async (req, res) => {
  try {
    const account = req.authenticatedUser;

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query('UPDATE accounts SET otp_code=$1, otp_expires_at=$2 WHERE id=$3', [otp, expiresAt, account.id]);

    const emailSent = await sendSystemEmail({
      to: account.email,
      subject: 'Password Change Verification Code',
      html: `<div style="font-family: Arial; border: 1px solid #ddd; padding: 20px;">
                <h2>Password Change Verification</h2>
                <p>Your verification code is: <h1 style="color: #3498db;">${otp}</h1></p>
                <p style="color: #888; font-size: 12px;">This code will expire in 10 minutes.</p>
               </div>`,
    });
    if (!emailSent) return res.status(503).json({ error: 'Email service unavailable' });

    return res.json({ success: true, message: 'OTP sent to email', expiresAt });
  } catch (err) {
    console.error('Request password change OTP failed:', err.message);
    return res.status(500).json({ error: 'Request failed' });
  }
});

// --- NEW: Change Password with OTP (Step 2: Verify OTP and Update Password) ---
app.post('/api/verify-password-change-otp', requireWebsiteManagedAccount, async (req, res) => {
  const { userId, newPassword, firstLogin } = req.body;
  try {
    if (firstLogin) {
      if (!req.authenticatedUser || Number(req.authenticatedUser.id) !== Number(userId)) {
        return res.status(403).json({ error: 'Password change is not authorized' });
      }
      const updatedAccount = await replaceAccountPassword({
        account: req.authenticatedUser,
        newPassword,
        requireTemporaryPassword: true,
      });
      return res.json({
        success: true,
        message: 'Password changed successfully!',
        user: serializeUser(updatedAccount),
        rememberToken: createRememberToken(updatedAccount),
      });
    }

    return res.status(410).json({
      error: 'Password changes require your current password in Settings.',
    });
  } catch (err) {
    console.error('Password change OTP verification failed:', err.message);
    return res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : 'Verification failed',
    });
  }
});

// --- NEW: Get User Profile (fetch from database) ---
app.get('/api/user/:id', async (req, res) => {
  try {
    if (!req.authenticatedUser) {
      return res.status(401).json({ error: 'Authentication is required.' });
    }

    const requestedUserId = resolvePositiveInteger(req.params.id);
    if (!requestedUserId || Number.isNaN(requestedUserId)) {
      return res.status(400).json({ error: 'A valid user ID is required.' });
    }

    const authenticatedUserId = Number(req.authenticatedUser.id);
    const authenticatedRole = normalizeAccountRole(req.authenticatedUser.role);
    if (authenticatedRole !== 'admin' && authenticatedUserId !== requestedUserId) {
      return res.status(403).json({ error: 'You can only access your own profile.' });
    }

    const result = await pool.query('SELECT * FROM accounts WHERE id = $1', [requestedUserId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (result.rows[0].is_archived) return res.status(401).json({ error: 'Session expired. Please log in again.' });
    
    const userData = serializeUser(result.rows[0]);
    res.json(userData);
  } catch (err) {
    console.error('Fetch user failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

app.put('/api/user/:id', async (req, res) => {
  try {
    if (!req.authenticatedUser) {
      return res.status(401).json({ error: 'Authentication is required.' });
    }

    const { id } = req.params;
    const currentData = await pool.query('SELECT * FROM public.accounts WHERE id = $1', [id]);
    if (currentData.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const old = currentData.rows[0];
    if (old.is_archived) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    if (!isSameAccount(req.authenticatedUser, old, id)) {
      return res.status(403).json({ error: 'You can only update your own profile.' });
    }

    const birthdayResult = resolveOptionalBirthday(req.body.birthday !== undefined ? req.body.birthday : old.birthday);
    if (birthdayResult.error) {
      return res.status(400).json({ error: birthdayResult.error });
    }
    const mobileResult = resolveMobileNumberForUpdate(req.body.mobile_number, old.mobile_number);
    if (mobileResult.error) return res.status(400).json({ error: mobileResult.error });

    const finalEmail = req.body.email && req.body.email.trim() !== ''
      ? req.body.email.toLowerCase().trim()
      : old.email;
    const result = await pool.query(
      `UPDATE public.accounts
       SET name=$1, email=$2, mobile_number=$3, address=$4, birthday=$5, gender=$6, status=$7
       WHERE id=$8
       RETURNING *`,
      [
        req.body.name || old.name,
        finalEmail,
        mobileResult.mobileNumber,
        req.body.address !== undefined ? req.body.address : old.address,
        birthdayResult.birthday,
        req.body.gender !== undefined ? req.body.gender : old.gender,
        req.body.status || old.status || 'Active',
        id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(500).json({ error: 'Failed to update profile' });
    }

    res.json({ success: true, message: 'Profile updated successfully', user: serializeUser(result.rows[0]) });
  } catch (err) {
    console.error('Profile update failed:', err.message);
    res.status(500).json({ error: 'Profile update failed' });
  }
});

// --- NEW: Get Top Achievers (game progress data) ---
const handleTopAchieversRequest = async (req, res) => {
  try {
    const scope = resolveAnalyticsScope(req);

    const params = [];
    let query = `
      SELECT *
      FROM (
        SELECT
          p.id,
          p.student_id,
          COALESCE(NULLIF(TRIM(p.student_name), ''), a.name, 'Unknown') AS student_name,
          a.email AS student_email,
          a.game_student_id,
          p.grade_level,
          p.section,
          p.current_quest,
          p.score,
          p.correct_answers,
          p.correct_answers AS total_correct_answers,
          p.total_questions,
          p.total_questions AS total_questions_answered,
          p.accuracy_rate,
          p.accuracy_rate AS accuracy,
          p.progress_percentage,
          p.progress_percentage AS completion_percentage,
          COALESCE(p.total_quests_completed, 0) AS quests_completed,
          COALESCE(p.total_quests_completed, 0) AS total_quests_completed,
          COALESCE(p.total_play_time, latest_activity.total_play_time, 0) AS total_play_time,
          p.last_played,
          ROW_NUMBER() OVER (
            PARTITION BY p.student_id
            ORDER BY
              p.progress_percentage DESC NULLS LAST,
              p.accuracy_rate DESC NULLS LAST,
              p.correct_answers DESC NULLS LAST,
              COALESCE(p.total_quests_completed, 0) DESC,
              p.updated_at DESC NULLS LAST,
              p.id DESC
          ) AS student_rank
        FROM public.student_game_progress p
        LEFT JOIN public.accounts a ON a.id = p.student_id
        LEFT JOIN LATERAL (
          SELECT al.total_play_time
          FROM public.activity_logs al
          WHERE al.student_id = p.student_id
          ORDER BY al.activity_timestamp DESC NULLS LAST, al.id DESC
          LIMIT 1
        ) latest_activity ON true
        WHERE 1=1
          AND a.progress_archived_at IS NULL
          AND (
            a.current_learning_cycle_started_at IS NULL
            OR p.updated_at >= a.current_learning_cycle_started_at
          )
    `;

    query += appendAnalyticsScopeFilter({ scope, params, studentColumn: 'p.student_id' });

    query += `
      ) ranked_progress
      WHERE student_rank = 1
      ORDER BY progress_percentage DESC, accuracy_rate DESC, correct_answers DESC, quests_completed DESC
      LIMIT 50
    `;

    const result = await pool.query(query, params);
    res.json(result.rows.map((row, index) => normalizeTopAchieverRow(row, index)));
  } catch (err) {
    console.error('Fetch top achievers failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch top achievers' });
  }
};

app.get('/api/top-achievers', requireAnalyticsAccess, handleTopAchieversRequest);
app.get('/api/leaderboard/top-achievers', requireAnalyticsAccess, handleTopAchieversRequest);

const STUDENT_QUEST_ACTIVITY_SQL = [
  '(',
  'al.event_key IS NOT NULL',
  'OR (',
  "LOWER(BTRIM(COALESCE(al.role, ''))) = 'student'",
  "AND NULLIF(BTRIM(al.current_quest), '') IS NOT NULL",
  "AND NULLIF(BTRIM(al.current_scene), '') IS NOT NULL",
  "AND NULLIF(BTRIM(al.current_map), '') IS NOT NULL",
  ')',
  ')',
].join(' ');

// --- ENHANCED: Get Recent Activity Logs with Filtering & Role-Based Access ---
app.get('/api/activity-logs', requireAnalyticsAccess, async (req, res) => {
  try {
    const {
      limit = 50,
      offset = 0,
      student_id = null,
      grade_level = null,
      section = null,
      search = null,
      sort_by = 'activity_timestamp',
      sort_order = 'DESC'
    } = req.query;

    // Validate and sanitize parameters
    const queryLimit = Math.min(parseInt(limit) || 50, 500);
    const queryOffset = Math.max(parseInt(offset) || 0, 0);
    const searchTerm = search ? `%${search.toLowerCase()}%` : null;
    const scope = resolveAnalyticsScope(req);
    const selectedStudentId = resolveScopeId(student_id);
    if (Number.isNaN(selectedStudentId)) return res.status(400).json({ error: 'Invalid student ID' });

    let query = `
      SELECT 
        al.id,
        al.student_id,
        account.game_student_id,
        al.student_name,
        al.grade_level AS grade,
        al.grade_level,
        al.section,
        al.current_quest,
        al.save_status,
        al.total_play_time AS duration_seconds,
        al.total_play_time,
        al.last_played,
        al.quest_progress,
        al.lesson_progress,
        al.difficulty_level,
        al.login_time,
        al.logout_time,
        al.session_date,
        al.activity_timestamp,
        al.activity_description,
        al.role,
        al.status,
        al.created_at
      FROM public.activity_logs al
      LEFT JOIN public.accounts account ON account.id = al.student_id
      WHERE 1=1
    `;

    const params = [];
    query += appendAnalyticsScopeFilter({ scope, params, studentColumn: 'al.student_id' });
    query += ` AND ${STUDENT_QUEST_ACTIVITY_SQL}`;
    let paramIndex = params.length + 1;

    if (selectedStudentId) {
      query += ` AND al.student_id = $${paramIndex}`;
      params.push(selectedStudentId);
      paramIndex++;
    }

    // Grade level filter
    if (grade_level && grade_level !== 'All Grades') {
      query += ` AND al.grade_level = $${paramIndex}`;
      params.push(grade_level);
      paramIndex++;
    }

    // Section filter
    if (section && section !== 'All Sections') {
      query += ` AND al.section = $${paramIndex}`;
      params.push(section);
      paramIndex++;
    }

    // Search visible student identity fields without changing the authenticated scope.
    if (searchTerm) {
      query += ` AND (LOWER(al.student_name) LIKE $${paramIndex} OR LOWER(COALESCE(account.game_student_id, '')) LIKE $${paramIndex})`;
      params.push(searchTerm);
      paramIndex++;
    }

    // Sorting
    const allowedSortFields = [
      'student_name',
      'grade_level',
      'section',
      'current_quest',
      'quest_progress',
      'total_play_time',
      'last_played',
      'activity_timestamp',
      'save_status'
    ];
    const sortField = allowedSortFields.includes(sort_by) ? sort_by : 'activity_timestamp';
    const sortDirection = sort_order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    query += ` ORDER BY al.${sortField} ${sortDirection}`;

    // Pagination
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(queryLimit, queryOffset);

    // Execute query
    const result = await pool.query(query, params);

    // Get total count for pagination metadata
    let countQuery = `SELECT COUNT(*) as total
      FROM public.activity_logs al
      LEFT JOIN public.accounts account ON account.id = al.student_id
      WHERE 1=1`;
    let countParams = [];
    countQuery += appendAnalyticsScopeFilter({ scope, params: countParams, studentColumn: 'al.student_id' });
    countQuery += ` AND ${STUDENT_QUEST_ACTIVITY_SQL}`;
    let countParamIndex = countParams.length + 1;

    if (selectedStudentId) {
      countQuery += ` AND al.student_id = $${countParamIndex}`;
      countParams.push(selectedStudentId);
      countParamIndex++;
    }

    if (grade_level && grade_level !== 'All Grades') {
      countQuery += ` AND al.grade_level = $${countParamIndex}`;
      countParams.push(grade_level);
      countParamIndex++;
    }

    if (section && section !== 'All Sections') {
      countQuery += ` AND al.section = $${countParamIndex}`;
      countParams.push(section);
      countParamIndex++;
    }

    if (searchTerm) {
      countQuery += ` AND (LOWER(al.student_name) LIKE $${countParamIndex} OR LOWER(COALESCE(account.game_student_id, '')) LIKE $${countParamIndex})`;
      countParams.push(searchTerm);
    }

    const countResult = await pool.query(countQuery, countParams);
    const totalRecords = parseInt(countResult.rows[0].total);

    res.json({
      data: result.rows,
      pagination: {
        total: totalRecords,
        limit: queryLimit,
        offset: queryOffset,
        pages: Math.max(1, Math.ceil(totalRecords / queryLimit)),
        current_page: Math.floor(queryOffset / queryLimit) + 1
      }
    });
  } catch (err) {
    console.error('Error fetching activity logs:', err.message);
    res.status(500).json({ error: 'Failed to fetch activity logs', details: err.message });
  }
});

app.post('/api/activity-logs/reset', requireAccountManagementAdmin, async (req, res) => {
  if (req.body?.confirmation !== 'RESET') {
    return res.status(400).json({ error: 'Type RESET to confirm this action.' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const result = await client.query(`DELETE FROM public.activity_logs al WHERE ${STUDENT_QUEST_ACTIVITY_SQL}`);
    await client.query('COMMIT');
    return res.json({ success: true, deleted_count: result.rowCount || 0 });
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Activity Log reset rollback failed:', rollbackError.message);
      }
    }
    console.error('Activity Log reset failed:', err.message);
    return res.status(500).json({ error: 'Failed to reset Student quest activity.' });
  } finally {
    client?.release();
  }
});

const parseActivityDurationSeconds = (value) => {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);

  const hours = text.match(/(\d+)\s*h/i);
  const minutes = text.match(/(\d+)\s*m/i);
  const seconds = text.match(/(\d+)\s*s/i);
  return (hours ? Number(hours[1]) * 3600 : 0)
    + (minutes ? Number(minutes[1]) * 60 : 0)
    + (seconds ? Number(seconds[1]) : 0);
};

// --- ENHANCED: Create Activity Log Entry with Gameplay Tracking ---
app.post('/api/activity-logs', async (req, res) => {
  const {
    student_id,
    student_name,
    grade,
    grade_level,
    section,
    current_quest,
    started_at,
    timestamp,
    duration_seconds,
    duration,
    save_status = 'pending',
    total_play_time = 0,
    quest_progress = 0,
    role = 'Student',
    status = 'Online',
    activity_description = 'Gameplay Session'
  } = req.body;

  try {
    if (!student_id || !student_name) {
      return res.status(400).json({ error: 'student_id and student_name are required' });
    }

    // Godot sends the public six-digit Student ID.  Resolve it to the account
    // primary key (and verify the supplied parent relationship) before writing
    // the foreign-key column used by monitoring queries.  A just-created game
    // may not have been saved yet, so acknowledge that harmless pre-profile
    // event instead of coercing e.g. 001234 into the unrelated integer 1234.
    const gameStudentCode = normalizeStudentCode(student_id);
    let activityStudentId = gameStudentCode ? null : resolveScopeId(student_id);
    if (gameStudentCode) {
      const parentCode = normalizeParentCode(req.body.parent_id);
      if (!parentCode) {
        return res.status(400).json({ error: 'parent_id is required when using a game Student ID.' });
      }

      const linkedStudent = await pool.query(
        `SELECT s.id
         FROM public.accounts s
         JOIN public.teacher_student_relationships r ON r.student_id = s.id
         JOIN public.accounts parent ON parent.id = r.teacher_id
         WHERE s.game_student_id = $1
           AND parent.parent_id = $2
           AND LOWER(r.relationship_type) = 'parent'
           AND COALESCE(s.is_archived, false) = false
           AND COALESCE(parent.is_archived, false) = false
         LIMIT 1`,
        [gameStudentCode, parentCode]
      );

      if (linkedStudent.rows.length === 0) {
        return res.status(202).json({
          message: 'Activity accepted; the game profile will be linked after its first Save Game.',
          pending_profile: true,
        });
      }
      activityStudentId = linkedStudent.rows[0].id;
    }

    if (!activityStudentId || Number.isNaN(activityStudentId)) {
      return res.status(400).json({ error: 'student_id must reference a valid student account.' });
    }

    const gradeValue = String(grade_level || grade || '').trim() || null;
    const durationValue = parseActivityDurationSeconds(duration_seconds ?? duration ?? total_play_time);
    const activityTime = started_at || timestamp || req.body.last_played || null;
    const currentScene = req.body.current_scene || req.body.currentScene || req.body.scene || req.body.scene_name || null;
    const currentMap = req.body.current_map || req.body.currentMap || req.body.map || req.body.map_name || null;
    const difficultyLevel = resolveDifficultyFromScene({ ...req.body, current_scene: currentScene, current_map: currentMap });

    const result = await pool.query(
      `INSERT INTO public.activity_logs (
        student_id, student_name, grade_level, section, current_quest,
        save_status, total_play_time, last_played, quest_progress,
        difficulty_level, role, status, activity_description, current_scene, current_map,
        login_time, session_date, activity_timestamp, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, COALESCE($13::timestamptz, NOW()), $8, $9, $10, $11, $12, $14, $15,
        COALESCE($13::timestamptz, NOW()), CURRENT_DATE, COALESCE($13::timestamptz, NOW()), NOW()
      ) RETURNING *`,
      [
        activityStudentId,
        student_name,
        gradeValue,
        section || null,
        current_quest || null,
        save_status,
        durationValue,
        quest_progress,
        difficultyLevel,
        role,
        normalizeMonitoringStatus(status, 'Online'),
        activity_description,
        activityTime,
        currentScene,
        currentMap
      ]
    );

    res.status(201).json({
      message: 'Activity log created successfully',
      data: result.rows[0]
    });
  } catch (err) {
    console.error('Create activity log failed:', err.message);
    res.status(500).json({ error: 'Failed to create activity log', details: err.message });
  }
});

const getDailyPlaytimeTotals = async (studentId) => {
  const result = await pool.query(
    `SELECT COALESCE(SUM(
       CASE
         WHEN status = 'Playing' AND end_time IS NULL THEN GREATEST(
           0,
           FLOOR(EXTRACT(EPOCH FROM (
              ${getPlaytimeEffectiveEndSql()}
             - COALESCE(server_started_at, start_time)
           )))::INTEGER
         )
         ELSE COALESCE(total_playtime_seconds, total_playtime_minutes * 60, 0)
       END
     ), 0)::INTEGER AS total_playtime_seconds,
     FLOOR(COALESCE(SUM(
       CASE
         WHEN status = 'Playing' AND end_time IS NULL THEN GREATEST(
           0,
           FLOOR(EXTRACT(EPOCH FROM (
              ${getPlaytimeEffectiveEndSql()}
             - COALESCE(server_started_at, start_time)
           )))::INTEGER
         )
         ELSE COALESCE(total_playtime_seconds, total_playtime_minutes * 60, 0)
       END
     ), 0) / 60)::INTEGER AS total_playtime_today
     FROM public.playtime_sessions
     WHERE student_id = $1
       AND date_played = CURRENT_DATE`,
    [studentId]
  );
  const row = result.rows[0] || {};
  const totalPlaytimeSeconds = Number.isFinite(Number(row.total_playtime_seconds))
    ? Number(row.total_playtime_seconds)
    : Math.max(0, Number(row.total_playtime_today || 0) * 60);
  return {
    totalPlaytimeSeconds: Math.max(0, totalPlaytimeSeconds),
    totalPlaytimeMinutes: Math.max(0, Number(row.total_playtime_today || Math.floor(totalPlaytimeSeconds / 60))),
  };
};

const finalizeStalePlaytimeSession = async (sessionId) => {
  const effectiveEndSql = getPlaytimeEffectiveEndSql();
  return pool.query(
    `UPDATE public.playtime_sessions
     SET end_time = ${effectiveEndSql},
         total_playtime_seconds = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
           ${effectiveEndSql} - COALESCE(server_started_at, start_time)
         )))::INTEGER),
         total_playtime_minutes = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
           ${effectiveEndSql} - COALESCE(server_started_at, start_time)
         )) / 60)::INTEGER),
         status = 'Offline',
         updated_at = NOW()
     WHERE id = $1
       AND status = 'Playing'
     RETURNING *`,
    [sessionId]
  );
};

const getDailyPlaytimeTotal = async (studentId) => {
  const { totalPlaytimeMinutes } = await getDailyPlaytimeTotals(studentId);
  return totalPlaytimeMinutes;
};

const applyPlaytimeFilters = ({ req, params, scope = 'all' }) => {
  const filters = [];
  const addParam = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const lifecycle = String(req.query.lifecycle || 'active').trim().toLowerCase();
  if (!['active', 'archived'].includes(lifecycle)) {
    return { error: 'Invalid monitoring lifecycle.' };
  }
  if (lifecycle === 'archived') {
    filters.push(`EXISTS (
      SELECT 1
      FROM public.accounts archived_student
      WHERE archived_student.id = ps.student_id
        AND archived_student.progress_archived_at IS NOT NULL
    )`);
  } else {
    filters.push(`NOT EXISTS (
      SELECT 1
      FROM public.accounts archived_student
      WHERE archived_student.id = ps.student_id
        AND archived_student.progress_archived_at IS NOT NULL
    )`);
  }

  if (scope === 'children') {
    const parentAccountId = Number(req.authenticatedUser.id);
    const parentAccountPlaceholder = addParam(parentAccountId);
    const parentCode = normalizeParentCode(req.authenticatedUser.parent_id);

    if (parentCode) {
      const parentCodePlaceholder = addParam(parentCode);
      filters.push(`(
        ps.student_id IN (
          SELECT tsr.student_id
          FROM public.teacher_student_relationships tsr
          JOIN public.accounts child
            ON child.id = tsr.student_id
           AND COALESCE(child.is_archived, false) = false
          WHERE tsr.teacher_id = ${parentAccountPlaceholder}
            AND LOWER(tsr.relationship_type) = 'parent'
        )
        OR ps.parent_id = ${parentCodePlaceholder}
      )`);
    } else {
      filters.push(`ps.student_id IN (
        SELECT tsr.student_id
        FROM public.teacher_student_relationships tsr
        JOIN public.accounts child
          ON child.id = tsr.student_id
         AND COALESCE(child.is_archived, false) = false
        WHERE tsr.teacher_id = ${parentAccountPlaceholder}
          AND LOWER(tsr.relationship_type) = 'parent'
      )`);
    }
  }

  if (scope === 'teacher') {
    const teacherAccountId = Number(req.authenticatedUser.id);
    const teacherAccountPlaceholder = addParam(teacherAccountId);
    filters.push(buildTeacherStudentScopePredicate({
      teacherPlaceholder: teacherAccountPlaceholder,
      studentColumn: 'ps.student_id',
    }));
  }

  const dateValue = String(req.query.date || req.query.date_played || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    filters.push(`ps.date_played = ${addParam(dateValue)}::date`);
  }

  if (scope === 'all') {
    const gradeLevel = String(req.query.grade_level || req.query.grade || '').trim();
    if (gradeLevel && gradeLevel !== 'All Grades') filters.push(`ps.grade_level = ${addParam(gradeLevel)}`);

    const section = String(req.query.section || '').trim();
    if (section && section !== 'All Sections') filters.push(`ps.section = ${addParam(section)}`);
  }

  const requestedStudentId = String(req.query.student_id || '').trim();
  const gameStudentCode = normalizeStudentCode(requestedStudentId);
  const studentId = gameStudentCode ? null : resolvePositiveInteger(requestedStudentId);
  if (requestedStudentId && !gameStudentCode && Number.isNaN(studentId)) {
    return { error: 'Invalid student ID' };
  }
  if (gameStudentCode) {
    filters.push(`ps.student_id IN (SELECT id FROM public.accounts WHERE game_student_id = ${addParam(gameStudentCode)})`);
  } else if (studentId) {
    filters.push(`ps.student_id = ${addParam(studentId)}`);
  }

  if (scope === 'all') {
    const parentCode = String(req.query.parent_id || '').trim();
    if (parentCode) filters.push(`ps.parent_id = ${addParam(parentCode)}`);
  }

  const studentName = String(req.query.student_name || req.query.child_name || '').trim().toLowerCase();
  if (studentName) filters.push(`LOWER(ps.student_name) LIKE ${addParam(`%${studentName}%`)}`);

  const status = String(req.query.status || '').trim();
  if (status) {
    const normalizedStatus = normalizePlaytimeStatus(status, status);
    const statusFilter = addParam(normalizedStatus);
    filters.push(['Playing', 'Offline'].includes(normalizedStatus)
      ? `(${getPlaytimePresenceStatusSql('ps.')}) = ${statusFilter}`
      : `ps.status = ${statusFilter}`);
  }

  const search = String(req.query.search || '').trim().toLowerCase();
  if (search) {
    const searchPlaceholder = addParam(`%${search}%`);
    filters.push(`(
      LOWER(ps.student_name) LIKE ${searchPlaceholder}
      OR LOWER(COALESCE(ps.parent_id, '')) LIKE ${searchPlaceholder}
      OR LOWER(COALESCE(ps.grade_level, '')) LIKE ${searchPlaceholder}
      OR LOWER(COALESCE(ps.section, '')) LIKE ${searchPlaceholder}
      OR LOWER(COALESCE(ps.status, '')) LIKE ${searchPlaceholder}
      OR CAST(ps.student_id AS TEXT) LIKE ${searchPlaceholder}
    )`);
  }

  return { whereSql: filters.length ? ` AND ${filters.join(' AND ')}` : '' };
};

const handlePlaytimeListRequest = async (req, res, { scope = 'all' } = {}) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || ((page - 1) * limit), 0);
    const sortMap = {
      date: 'ps.date_played',
      date_played: 'ps.date_played',
      student_name: 'ps.student_name',
      child_name: 'ps.student_name',
      total_playtime: 'ps.total_playtime_minutes',
      total_playtime_minutes: 'ps.total_playtime_minutes',
      status: 'ps.status',
    };
    const sortField = sortMap[String(req.query.sort_by || 'student_name').trim()] || 'ps.student_name';
    const sortDirection = String(req.query.sort_order || 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    const params = [];
    const filterResult = applyPlaytimeFilters({ req, params, scope });
    if (filterResult.error) {
      return res.status(400).json({ error: filterResult.error });
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::INTEGER AS total
       FROM public.playtime_sessions ps
       WHERE 1=1${filterResult.whereSql}`,
      params
    );

    const dataParams = params.slice();
    dataParams.push(limit, offset);
    const result = await pool.query(
      `SELECT ps.id,
              ps.student_id,
              student_account.game_student_id,
              ps.parent_id,
              ps.student_name,
              ps.student_name AS child_name,
              ps.grade_level,
              ps.section,
              ps.date_played,
              ps.start_time,
               ps.end_time,
               COALESCE(ps.total_playtime_minutes, 0) AS total_playtime_minutes,
               ps.status,
               ps.last_heartbeat_at,
               ps.expires_at,
               (${getPlaytimePresenceStatusSql('ps.')}) AS presence_status,
               CASE
                 WHEN ps.status = 'Playing'
                  AND ps.end_time IS NULL
                  AND ${getPlaytimeHeartbeatStaleSql('ps.')}
                 THEN 'heartbeat_stale'
                 WHEN ps.status = 'Playing'
                  AND ps.end_time IS NULL
                  AND COALESCE(ps.expires_at, NOW()) <= NOW()
                 THEN 'lease_expired'
                 ELSE NULL
               END AS presence_reason,
               ps.created_at,
               ps.updated_at
       FROM public.playtime_sessions ps
       LEFT JOIN public.accounts student_account ON student_account.id = ps.student_id
       WHERE 1=1${filterResult.whereSql}
       ORDER BY ${sortField} ${sortDirection}, ps.id DESC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    const total = Number(countResult.rows[0]?.total || 0);
    res.json({
      data: result.rows.map((row) => ({
        ...row,
        status: normalizePlaytimeStatus(row.presence_status || row.status, 'Offline'),
      })),
      pagination: {
        page,
        limit,
        offset,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (err) {
    console.error('Fetch playtime sessions failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch playtime sessions' });
  }
};

app.post('/api/playtime/start', async (req, res) => {
  try {
    const studentCode = normalizeStudentCode(req.body.student_id);
    if (!studentCode) {
      return res.status(400).json({ error: 'Student ID must be exactly 6 digits.' });
    }

    const studentName = String(req.body.student_name || '').trim();
    if (!studentName) {
      return res.status(400).json({ error: 'student_name is required.' });
    }

    const parentCode = normalizeParentCode(req.body.parent_id);
    if (!parentCode) {
      return res.status(400).json({ error: 'Parent ID must be exactly 6 digits.' });
    }

    // Verify parent exists and is active
    const { parent, error } = await getValidatedActiveParentAccount(parentCode);
    if (error) {
      return res.status(error.status).json({ error: error.message, can_play: false });
    }
    const parentId = parent.id;

    // Check for linked student (existing student account linked to this parent)
    const linkedStudentResult = await pool.query(
      `SELECT s.id, s.name, s.grade_level, s.section,
              s.current_learning_cycle_version, s.current_learning_cycle_started_at
       FROM public.accounts s
       JOIN public.teacher_student_relationships r ON r.student_id = s.id
       WHERE r.teacher_id = $1
         AND s.game_student_id = $2
         AND LOWER(r.relationship_type) = 'parent'
         AND COALESCE(s.is_archived, false) = false
       LIMIT 1`,
      [parentId, studentCode]
    );

    let studentId = null;
    let learningCycle = toLearningCycleDescriptor();
    let resolvedStudentName = studentName;
    let resolvedGradeLevel = String(req.body.grade_level || req.body.grade || '').trim() || null;
    let resolvedSection = String(req.body.section || '').trim() || null;
    if (linkedStudentResult.rows.length > 0) {
      // Parent-created profiles own identity, grade, and section. Never allow
      // the game client to overwrite those fields while starting a lease.
      const linkedStudent = linkedStudentResult.rows[0];
      studentId = linkedStudent.id;
      learningCycle = toLearningCycleDescriptor(linkedStudent);
      resolvedStudentName = String(linkedStudent.name || '').trim() || studentName;
      resolvedGradeLevel = String(linkedStudent.grade_level || '').trim() || resolvedGradeLevel;
      resolvedSection = String(linkedStudent.section || '').trim() || null;
    } else {
      // Student not found or not linked to this parent
      // For NEW GAME registration, allow it if student doesn't exist yet
      const existingStudentResult = await pool.query(
        `SELECT id
         FROM public.accounts
         WHERE game_student_id = $1
         LIMIT 1`,
        [studentCode]
      );

      if (existingStudentResult.rows.length > 0) {
        // Student exists but is not linked to this parent - reject
        return res.status(403).json({ error: 'Student ID is already registered with a different parent.', can_play: false });
      }

      // NEW GAME: create the canonical student account and Parent relationship before
      // allowing gameplay so the registration is persistent at Start.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const studentPassword = await hashPassword(generateRandomPassword());
        const email = buildGameStudentEmail(parentId, studentName || `student-${studentCode}`);
        const studentResult = await client.query(
          `INSERT INTO public.accounts (name, email, password, role, status, is_archived, must_change_password, game_student_id)
           VALUES ($1, $2, $3, 'student', 'Offline', false, false, $4)
           RETURNING id`,
          [studentName, email, studentPassword, studentCode]
        );
        studentId = studentResult.rows[0]?.id;
        if (!studentId) throw new Error('Unable to create the new game student account.');
        await ensureParentStudentRelationship(client, {
          teacherId: parentId,
          studentId,
          relationshipType: 'parent',
        });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    // A client never controls when a playtime session starts. An interrupted
    // lease is closed at server time before a new lease is issued, because the
    // plaintext lease credential is intentionally never recoverable from the
    // database.
    let { totalPlaytimeSeconds } = await getDailyPlaytimeTotals(studentId);
    const activeSessionResult = await pool.query(
       `SELECT *,
               GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
                 COALESCE(expires_at, NOW()) - NOW()
               )))::INTEGER) AS remaining_seconds,
               (${getPlaytimeHeartbeatStaleSql()}) AS heartbeat_stale
       FROM public.playtime_sessions
       WHERE student_id = $1
         AND status = 'Playing'
       ORDER BY COALESCE(server_started_at, start_time) DESC NULLS LAST, id DESC
       LIMIT 1`,
      [studentId]
    );

    if (activeSessionResult.rows.length > 0) {
      const activeSession = activeSessionResult.rows[0];
      if (activeSession.heartbeat_stale) {
        await finalizeStalePlaytimeSession(activeSession.id);
      } else {
        await pool.query(
          `UPDATE public.playtime_sessions
           SET end_time = LEAST(NOW(), COALESCE(expires_at, NOW())),
               total_playtime_seconds = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
                 LEAST(NOW(), COALESCE(expires_at, NOW())) - COALESCE(server_started_at, start_time)
               )))::INTEGER),
               total_playtime_minutes = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
                 LEAST(NOW(), COALESCE(expires_at, NOW())) - COALESCE(server_started_at, start_time)
               )) / 60)::INTEGER),
               status = CASE WHEN COALESCE(expires_at, NOW()) <= NOW() THEN 'Timed Out' ELSE 'Interrupted' END,
               updated_at = NOW()
           WHERE id = $1`,
          [activeSession.id]
        );
      }
      ({ totalPlaytimeSeconds } = await getDailyPlaytimeTotals(studentId));
    }

    const remainingSeconds = Math.max(0, PLAYTIME_DAILY_LIMIT_SECONDS - totalPlaytimeSeconds);
    if (remainingSeconds <= 0) {
      return res.status(403).json({
        error: 'Daily playtime limit reached.',
        message: 'Daily playtime limit reached.',
        total_playtime_today: Math.floor(totalPlaytimeSeconds / 60),
        total_playtime_seconds: totalPlaytimeSeconds,
        remaining_minutes: 0,
        remaining_seconds: 0,
        can_play: false,
        daily_limit_minutes: PLAYTIME_DAILY_LIMIT_MINUTES,
      });
    }

    const sessionCredential = createPlaytimeSessionCredential();
    const result = await pool.query(
      `INSERT INTO public.playtime_sessions (
        student_id, parent_id, student_name, grade_level, section,
        date_played, start_time, server_started_at, expires_at,
        status, total_playtime_minutes, total_playtime_seconds,
        session_credential_hash, last_heartbeat_at, learning_cycle_version, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        CURRENT_DATE, NOW(), NOW(),
        LEAST(
          NOW() + ($6::INTEGER * INTERVAL '1 second'),
          date_trunc('day', NOW()) + INTERVAL '1 day'
        ),
        'Playing', 0, 0, $7, NOW(), $8, NOW(), NOW()
      )
      RETURNING *,
        GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (expires_at - NOW())))::INTEGER) AS remaining_seconds`,
      [
        studentId,
        parentCode,
        resolvedStudentName,
        resolvedGradeLevel,
        resolvedSection,
        remainingSeconds,
        hashPlaytimeSessionCredential(sessionCredential),
        learningCycle.version,
      ]
    );

    const session = result.rows[0];
    return res.status(201).json({
      ...toPlaytimeResponse({
      session,
      totalPlaytimeSeconds,
      sessionCredential,
      remainingSeconds: session?.remaining_seconds,
      message: 'Playtime session started.',
      }),
      learning_cycle: learningCycle,
    });
  } catch (err) {
    console.error('Start playtime session failed:', err.message);
    res.status(500).json({ error: 'Failed to start playtime session' });
  }
});

app.post('/api/playtime/end', async (req, res) => {
  try {
    const sessionId = resolvePositiveInteger(req.body.session_id);
    const sessionCredential = String(req.body.session_credential || '').trim();
    if (Number.isNaN(sessionId) || !sessionId || !sessionCredential) {
      return res.status(400).json({ error: 'Invalid playtime session payload.' });
    }

    const sessionResult = await pool.query(
      `SELECT *
       FROM public.playtime_sessions
       WHERE id = $1
         AND status = 'Playing'
       LIMIT 1`,
      [sessionId]
    );
    const session = sessionResult.rows[0];
    if (!session) {
      return res.status(404).json({ error: 'No active playtime session found.' });
    }
    if (!hasMatchingPlaytimeSessionCredential(sessionCredential, session.session_credential_hash)) {
      return res.status(403).json({ error: 'Invalid playtime session credential.' });
    }

    const status = normalizePlaytimeStatus(req.body.status, 'Completed');
    const result = await pool.query(
      `UPDATE public.playtime_sessions
       SET end_time = LEAST(NOW(), COALESCE(expires_at, NOW())),
           total_playtime_seconds = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
             LEAST(NOW(), COALESCE(expires_at, NOW())) - COALESCE(server_started_at, start_time)
           )))::INTEGER),
           total_playtime_minutes = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
             LEAST(NOW(), COALESCE(expires_at, NOW())) - COALESCE(server_started_at, start_time)
           )) / 60)::INTEGER),
           status = CASE WHEN COALESCE(expires_at, NOW()) <= NOW() THEN 'Timed Out' ELSE $2 END,
           updated_at = NOW()
       WHERE id = $1
         AND status = 'Playing'
       RETURNING *`,
      [sessionId, status]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No active playtime session found.' });
    }

    res.json({ success: true, session: result.rows[0] });
  } catch (err) {
    console.error('End playtime session failed:', err.message);
    res.status(500).json({ error: 'Failed to end playtime session' });
  }
});

app.post('/api/playtime/heartbeat', async (req, res) => {
  try {
    const sessionId = resolvePositiveInteger(req.body.session_id);
    const sessionCredential = String(req.body.session_credential || '').trim();
    if (Number.isNaN(sessionId) || !sessionId || !sessionCredential) {
      return res.status(400).json({ error: 'Invalid playtime heartbeat payload.' });
    }

    const sessionResult = await pool.query(
      `SELECT *,
               (SELECT COALESCE(a.current_learning_cycle_version, 0)
                  FROM public.accounts a
                 WHERE a.id = public.playtime_sessions.student_id) AS current_learning_cycle_version,
               (${getPlaytimeHeartbeatStaleSql()}) AS heartbeat_stale,
               GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
                 COALESCE(expires_at, NOW()) - NOW()
              )))::INTEGER) AS remaining_seconds
       FROM public.playtime_sessions
       WHERE id = $1
         AND status = 'Playing'
       LIMIT 1`,
      [sessionId]
    );
    const session = sessionResult.rows[0];
    if (!session) {
      return res.status(404).json({ error: 'No active playtime session found.', can_play: false });
    }
    if (!hasMatchingPlaytimeSessionCredential(sessionCredential, session.session_credential_hash)) {
      return res.status(403).json({ error: 'Invalid playtime session credential.', can_play: false });
    }
    if (Number(session.learning_cycle_version ?? 0) !== Number(session.current_learning_cycle_version ?? 0)) {
      return res.status(409).json({
        code: 'LEARNING_CYCLE_CHANGED',
        error: 'This playtime session belongs to a previous learning cycle. Start a new game for the current cycle.',
        can_play: false,
      });
    }

    const remainingSeconds = Math.max(0, Number(session.remaining_seconds || 0));
    if (remainingSeconds <= 0) {
      await pool.query(
        `UPDATE public.playtime_sessions
         SET end_time = COALESCE(expires_at, NOW()),
             total_playtime_seconds = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
               COALESCE(expires_at, NOW()) - COALESCE(server_started_at, start_time)
             )))::INTEGER),
             total_playtime_minutes = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
               COALESCE(expires_at, NOW()) - COALESCE(server_started_at, start_time)
             )) / 60)::INTEGER),
             status = 'Timed Out',
             updated_at = NOW()
         WHERE id = $1`,
        [sessionId]
      );
      const { totalPlaytimeSeconds } = await getDailyPlaytimeTotals(session.student_id);
      return res.status(403).json({
        error: 'Daily playtime limit reached.',
        ...toPlaytimeResponse({
          session: { ...session, status: 'Timed Out' },
          totalPlaytimeSeconds,
          remainingSeconds: 0,
          message: 'Daily playtime limit reached.',
        }),
      });
    }

    if (session.heartbeat_stale) {
      await finalizeStalePlaytimeSession(sessionId);
      const { totalPlaytimeSeconds } = await getDailyPlaytimeTotals(session.student_id);
      return res.status(409).json({
        code: 'PLAYTIME_HEARTBEAT_STALE',
        error: 'The playtime session is no longer active. Start a new session to continue.',
        can_play: false,
        ...toPlaytimeResponse({
          session: { ...session, status: 'Offline' },
          totalPlaytimeSeconds,
          remainingSeconds: 0,
          message: 'The playtime session expired after a missed heartbeat.',
        }),
      });
    }

    const updateResult = await pool.query(
      `UPDATE public.playtime_sessions
       SET last_heartbeat_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND status = 'Playing'
       RETURNING *,
         GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (expires_at - NOW())))::INTEGER) AS remaining_seconds`,
      [sessionId]
    );
    const { totalPlaytimeSeconds } = await getDailyPlaytimeTotals(session.student_id);
    return res.json(toPlaytimeResponse({
      session: updateResult.rows[0] || session,
      totalPlaytimeSeconds,
      remainingSeconds: updateResult.rows[0]?.remaining_seconds ?? remainingSeconds,
      message: 'Playtime lease renewed.',
    }));
  } catch (err) {
    console.error('Playtime heartbeat failed:', err.message);
    return res.status(500).json({ error: 'Failed to renew playtime session.', can_play: false });
  }
});

app.get('/api/playtime/today/:student_id', requireAnalyticsAccess, verifyScopedStudentAnalyticsAccess, async (req, res) => {
  try {
    const studentId = resolvePositiveInteger(req.params.student_id);
    if (!studentId || Number.isNaN(studentId)) {
      return res.status(400).json({ error: 'A valid student_id is required.' });
    }

    const { totalPlaytimeSeconds, totalPlaytimeMinutes } = await getDailyPlaytimeTotals(studentId);
    const remainingSeconds = Math.max(0, PLAYTIME_DAILY_LIMIT_SECONDS - totalPlaytimeSeconds);
    res.json({
      student_id: studentId,
      total_playtime_today: totalPlaytimeMinutes,
      total_playtime_seconds: totalPlaytimeSeconds,
      remaining_minutes: Math.ceil(remainingSeconds / 60),
      remaining_seconds: remainingSeconds,
      can_play: remainingSeconds > 0,
      daily_limit_minutes: PLAYTIME_DAILY_LIMIT_MINUTES,
    });
  } catch (err) {
    console.error('Fetch daily playtime failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch daily playtime' });
  }
});

app.get(
  '/api/playtime',
  requireAuthenticatedRoles(['admin', 'teacher', 'parent_teacher']),
  (req, res) => {
    const analyticsScope = resolveAnalyticsScope(req);
    return handlePlaytimeListRequest(req, res, { scope: analyticsScope?.type === 'all' ? 'all' : 'teacher' });
  }
);

app.get(
  '/api/playtime/my-children',
  requireAuthenticatedRoles(['parent', 'parent_teacher']),
  (req, res) => handlePlaytimeListRequest(req, res, { scope: 'children' })
);

app.get('/api/sections/registry', requireParentAnalyticsAccess, (req, res) => {
  return res.json(getPublicSectionRegistrySnapshot());
});

app.post('/api/parent/children', requireParentAnalyticsAccess, async (req, res) => {
  const childProfile = resolveParentChildProfile(req.body);
  if (childProfile.error) return res.status(400).json({ error: childProfile.error });

  const parentId = Number(req.authenticatedUser?.id);
  if (!Number.isInteger(parentId) || parentId <= 0) {
    return res.status(401).json({ error: 'Authentication is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingStudentResult = await client.query(
      `SELECT s.id,
              s.game_student_id,
              EXISTS (
                SELECT 1
                FROM public.teacher_student_relationships own_link
                WHERE own_link.student_id = s.id
                  AND own_link.teacher_id = $2
                  AND LOWER(own_link.relationship_type) = 'parent'
              ) AS linked_to_authenticated_parent,
              EXISTS (
                SELECT 1
                FROM public.teacher_student_relationships other_link
                WHERE other_link.student_id = s.id
                  AND other_link.teacher_id <> $2
                  AND LOWER(other_link.relationship_type) = 'parent'
              ) AS linked_to_another_parent
       FROM public.accounts s
       WHERE s.game_student_id = $1
       FOR UPDATE`,
      [childProfile.studentId, parentId]
    );
    const existingStudent = existingStudentResult.rows[0];
    if (existingStudent) {
      await client.query('ROLLBACK');
      if (existingStudent.linked_to_authenticated_parent) {
        return res.status(409).json({ error: 'This Student ID is already linked to your account.' });
      }
      return res.status(409).json({ error: 'This Student ID is already linked to another parent or needs administrator resolution.' });
    }

    const studentPassword = await hashPassword(generateRandomPassword());
    const studentEmail = buildGameStudentEmail(parentId, `${childProfile.fullName}-${childProfile.studentId}`);
    const studentResult = await client.query(
      `INSERT INTO public.accounts (
         name, first_name, last_name, middle_initial, grade_level, section,
         email, password, role, status, is_archived, must_change_password, game_student_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'student', 'Offline', false, false, $9)
       RETURNING id, name, first_name, last_name, middle_initial, grade_level, section, game_student_id`,
      [
        childProfile.fullName,
        childProfile.firstName,
        childProfile.lastName,
        childProfile.middleInitial,
        childProfile.gradeLevel,
        childProfile.section,
        studentEmail,
        studentPassword,
        childProfile.studentId,
      ]
    );
    const child = studentResult.rows[0];
    if (!child?.id) throw new Error('Unable to create the child game profile.');

    await ensureParentStudentRelationship(client, {
      teacherId: parentId,
      studentId: child.id,
      relationshipType: 'parent',
    });
    await client.query(
      `INSERT INTO public.activity_logs (student_id, student_name, grade_level, section, activity_description, role, status)
       VALUES ($1, $2, $3, $4, 'Child Added', 'parent', 'Active')`,
      [child.id, child.name, child.grade_level, child.section]
    );
    await client.query('COMMIT');
    return res.status(201).json({
      success: true,
      child: {
        id: child.id,
        student_id: child.id,
        student_name: child.name,
        first_name: child.first_name,
        last_name: child.last_name,
        middle_initial: child.middle_initial,
        grade_level: child.grade_level,
        section: child.section,
        game_student_id: child.game_student_id,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Parent child creation failed:', error.message);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This Student ID is already in use. Contact an administrator if you need help.' });
    }
    return res.status(500).json({ error: 'Unable to add child at this time.' });
  } finally {
    client.release();
  }
});

app.get('/api/parent/children', requireParentAnalyticsAccess, async (req, res) => {
  try {
    const parentId = Number(req.authenticatedUser.id);

    const childrenResult = await pool.query(
      `SELECT s.id,
              s.id AS student_id,
              s.game_student_id,
              s.name,
              s.name AS student_name,
              s.email,
              s.progress_archived_at,
              s.progress_archive_reason,
              COALESCE(p.grade_level, s.grade_level) AS grade_level,
              NULLIF(s.section, '') AS section,
              p.current_quest,
              p.score,
              CASE WHEN p.id IS NULL THEN NULL ELSE p.progress_percentage END AS completion_percentage,
              CASE
                WHEN COALESCE(SUM(gr.total_items), 0) > 0
                  THEN ROUND((SUM(gr.score)::NUMERIC / NULLIF(SUM(gr.total_items), 0)) * 100, 2)
                ELSE NULL
              END AS accuracy,
              COUNT(gr.id)::INTEGER AS total_quizzes,
              MAX(gr.played_at) AS last_quiz_date
       FROM public.teacher_student_relationships tsr
       JOIN public.accounts parent
         ON parent.id = tsr.teacher_id
        AND COALESCE(parent.is_archived, false) = false
       JOIN public.accounts s ON s.id = tsr.student_id
       LEFT JOIN LATERAL (
         SELECT progress.id, progress.grade_level, progress.section, progress.current_quest,
                progress.score, progress.progress_percentage
         FROM public.student_game_progress progress
         WHERE progress.student_id = s.id
           AND (
             s.current_learning_cycle_started_at IS NULL
             OR progress.updated_at >= s.current_learning_cycle_started_at
           )
         ORDER BY progress.updated_at DESC NULLS LAST, progress.id DESC
         LIMIT 1
       ) p ON true
       LEFT JOIN public.game_results gr
         ON gr.resolved_student_id = s.id
        AND (
          s.current_learning_cycle_started_at IS NULL
          OR gr.played_at >= s.current_learning_cycle_started_at
        )
       WHERE tsr.teacher_id = $1
         AND LOWER(tsr.relationship_type) = 'parent'
         AND COALESCE(s.is_archived, false) = false
       GROUP BY s.id, s.progress_archived_at, s.progress_archive_reason,
                p.id, p.grade_level, p.section, p.current_quest, p.score, p.progress_percentage
       ORDER BY s.name`,
      [parentId]
    );

    // Unlinked sessions only have the six-digit parent code until a student profile match is made.
    const unlinkedResult = await pool.query(
      `SELECT COUNT(gr.id)::INTEGER AS unlinked_count
       FROM public.accounts parent
       LEFT JOIN public.game_results gr
         ON gr.parent_id = parent.parent_id
        AND gr.is_unlinked = true
       WHERE parent.id = $1
         AND COALESCE(parent.is_archived, false) = false`,
      [parentId]
    );

    res.json({
      children: childrenResult.rows,
      unlinked_count: unlinkedResult.rows[0]?.unlinked_count || 0,
    });
  } catch (err) {
    console.error('Fetch parent children failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch parent children' });
  }
});

app.get('/api/parent/children/:studentId/quizzes', requireParentAnalyticsAccess, verifyParentChildAccess, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;
    const { studentId } = req.parentChildAccess;

    const [quizzesResult, countResult] = await Promise.all([
      pool.query(
        `SELECT gr.id, gr.parent_id, gr.student_name, gr.resolved_student_id, gr.grade_level, gr.difficulty,
                gr.math_topic, gr.score, gr.total_items, gr.percentage, gr.played_at
         FROM public.game_results gr
         JOIN public.accounts student ON student.id = gr.resolved_student_id
         WHERE gr.resolved_student_id = $1
           AND (
             student.current_learning_cycle_started_at IS NULL
             OR gr.played_at >= student.current_learning_cycle_started_at
           )
         ORDER BY played_at DESC NULLS LAST, id DESC
         LIMIT $2 OFFSET $3`,
        [studentId, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::INTEGER AS total
         FROM public.game_results gr
         JOIN public.accounts student ON student.id = gr.resolved_student_id
         WHERE gr.resolved_student_id = $1
           AND (
             student.current_learning_cycle_started_at IS NULL
             OR gr.played_at >= student.current_learning_cycle_started_at
           )`,
        [studentId]
      ),
    ]);

    const total = countResult.rows[0]?.total || 0;
    res.json({
      data: quizzesResult.rows,
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (err) {
    console.error('Fetch child quizzes failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch child quizzes' });
  }
});

app.get('/api/parent/children/:studentId/topics', requireParentAnalyticsAccess, verifyParentChildAccess, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT gr.math_topic,
              COUNT(*)::INTEGER AS times_played,
              MAX(gr.score) AS best_score
       FROM public.game_results gr
       JOIN public.accounts student ON student.id = gr.resolved_student_id
       WHERE gr.resolved_student_id = $1
         AND gr.math_topic IS NOT NULL
         AND (
           student.current_learning_cycle_started_at IS NULL
           OR gr.played_at >= student.current_learning_cycle_started_at
         )
       GROUP BY gr.math_topic
       ORDER BY times_played DESC, math_topic`,
      [req.parentChildAccess.studentId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Fetch child topics failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch child topics' });
  }
});

app.get('/api/students', requireAuthenticatedRoles(['admin', 'teacher', 'parent_teacher']), async (req, res) => {
  try {
    const scope = resolveAnalyticsScope(req);
    const params = [];
    let query = `SELECT a.id, a.game_student_id, a.name, a.email, a.role, a.mobile_number, a.address, a.birthday, a.gender, a.status,
              p.score, p.correct_answers, p.total_questions, p.accuracy_rate, p.progress_percentage, p.current_quest
        FROM accounts a
        LEFT JOIN public.student_game_progress p
          ON a.id = p.student_id
         AND (
           a.current_learning_cycle_started_at IS NULL
           OR p.updated_at >= a.current_learning_cycle_started_at
         )
       WHERE LOWER(a.role) = 'student' AND COALESCE(a.is_archived, false) = false`;
    query += appendAnalyticsScopeFilter({ scope, params, studentColumn: 'a.id' });
    query += ' ORDER BY a.name';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch students failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

app.get('/api/students/progress', requireAnalyticsAccess, async (req, res) => {
  try {
    const scope = resolveAnalyticsScope(req);
    const lifecycle = resolveStudentProgressLifecycle(req.query.lifecycle);
    if (!lifecycle) return res.status(400).json({ error: 'lifecycle must be active or archived.' });
    const params = [];
    let query = buildCanonicalStudentProgressQuery(lifecycle);
    query += appendAnalyticsScopeFilter({ scope, params, studentColumn: 'a.id' });
    query += " ORDER BY LOWER(COALESCE(NULLIF(a.name, ''), NULLIF(p.student_name, ''), '')), a.id ASC";

    const result = await pool.query(query, params);
    const rows = sortRowsByStudentName(result.rows.map(normalizeStudentProgressRow).map((row) => {
      const metrics = buildStudentAnalyticsMetrics({ progress: row });
      return {
        ...row,
        correct_answers: metrics.correctAnswers,
        incorrect_answers: metrics.incorrectAnswers,
        total_questions: metrics.totalQuestions,
        accuracy_rate: metrics.accuracy,
        performance_percentage: metrics.accuracy,
        difficultyBreakdown: metrics.difficultyBreakdown,
      };
    }));
    res.json(rows);
  } catch (err) {
    console.error('Fetch students progress failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch student progress' });
  }
});

app.get('/api/analytics/overview', requireAnalyticsAccess, async (req, res) => {
  try {
    const scope = resolveAnalyticsScope(req);
    const params = [];
    let query = buildCanonicalStudentProgressQuery();
    query += appendAnalyticsScopeFilter({ scope, params, studentColumn: 'a.id' });

    const result = await pool.query(query, params);
    const rows = result.rows.map(normalizeStudentProgressRow).map((row) => {
      const metrics = buildStudentAnalyticsMetrics({ progress: row });
      return { ...row, metrics, analysis: generateStudentAnalysis(row) };
    });

    const gradeSummary = buildGradeSummary(rows);
    const averageOfAvailable = (values) => {
      const available = values.filter((value) => Number.isFinite(value));
      return available.length ? Math.round(available.reduce((sum, value) => sum + value, 0) / available.length) : null;
    };
    const averageAccuracy = averageOfAvailable(rows.map((item) => item.metrics.accuracy));
    const averageProgress = averageOfAvailable(rows.map((item) => item.metrics.totalProgress));
    const studentCount = rows.length;

    res.json({
      studentCount,
      averageAccuracy,
      averageProgress,
      gradeSummary,
      sections: Array.from(new Set(rows.map((row) => row.section).filter(Boolean))).sort(),
    });
  } catch (err) {
    console.error('Fetch analytics overview failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch analytics overview' });
  }
});

app.get('/api/analytics/recommendations', requireAnalyticsAccess, async (req, res) => {
  res.json({
    recommendations: [],
    status: 'user_triggered_per_student',
    message: 'Grounded AI Insights are requested from an individual student analysis after enough gameplay results are available.',
  });
});

app.get('/api/students/progress-analysis', requireAuthenticatedRoles(['admin', 'teacher', 'parent_teacher']), async (req, res) => {
  try {
    const scope = resolveAnalyticsScope(req);
    const minScore = parseInt(req.query.minScore, 10);
    const minAccuracy = parseInt(req.query.minAccuracy, 10);

    let baseQuery = `SELECT p.*, a.name AS student_name, a.email AS student_email, a.role AS student_role
                   FROM public.student_game_progress p
                   LEFT JOIN accounts a ON a.id = p.student_id`;
    const params = [];
    const filters = [];

    if (!Number.isNaN(minScore)) {
      params.push(minScore);
      filters.push(`p.score >= $${params.length}`);
    }
    if (!Number.isNaN(minAccuracy)) {
      params.push(minAccuracy);
      filters.push(`p.accuracy_rate >= $${params.length}`);
    }
    filters.push(`(
      a.current_learning_cycle_started_at IS NULL
      OR p.updated_at >= a.current_learning_cycle_started_at
    )`);
    filters.push('a.progress_archived_at IS NULL');
    if (filters.length > 0) {
      baseQuery += ` WHERE ${filters.join(' AND ')}`;
    } else {
      baseQuery += ' WHERE 1=1';
    }
    baseQuery += appendAnalyticsScopeFilter({ scope, params, studentColumn: 'p.student_id' });
    baseQuery += ' ORDER BY p.score DESC, p.accuracy_rate DESC';

    const result = await pool.query(baseQuery, params);
    const studentAnalyses = result.rows.map((row) => ({
      ...row,
      analysis: generateStudentAnalysis(row)
    }));

    const averageScore = studentAnalyses.length
      ? Math.round(studentAnalyses.reduce((sum, item) => sum + (item.score || 0), 0) / studentAnalyses.length)
      : 0;
    const averageAccuracy = studentAnalyses.length
      ? Math.round(studentAnalyses.reduce((sum, item) => sum + (item.accuracy_rate || 0), 0) / studentAnalyses.length)
      : 0;
    const totalStudents = studentAnalyses.length;
    const topStudents = studentAnalyses.slice(0, 5).map((item) => ({
      student_id: item.student_id,
      student_name: item.student_name,
      score: item.score,
      accuracy_rate: item.accuracy_rate,
      progress_percentage: item.progress_percentage,
    }));
    const actionItems = [];

    if (averageAccuracy < 75) actionItems.push('Review classroom accuracy trends and assign targeted practice sessions.');
    if (averageScore < 70) actionItems.push('Plan checkpoint quizzes to help students increase overall scores.');
    if (studentAnalyses.some((item) => item.progress_percentage < 50)) actionItems.push('Reach out to students with low progress percentages for additional support.');
    if (actionItems.length === 0) actionItems.push('Class performance is strong; keep reinforcing current progress routines.');

    res.json({ summary: { averageScore, averageAccuracy, totalStudents, topStudents, actionItems }, studentAnalyses });
  } catch (err) {
    console.error('Fetch students progress analysis failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch progress analysis' });
  }
});

app.post('/api/student-progress/bulk/reset', requireAnalyticsAccess, (req, res) => runBulkLifecycleAction(req, res, 'reset'));
app.post('/api/student-progress/bulk/archive', requireAnalyticsAccess, (req, res) => runBulkLifecycleAction(req, res, 'archive'));

app.post('/api/student-progress/:studentId/reset', requireAnalyticsAccess, verifyScopedStudentAnalyticsAccess, async (req, res) => {
  const studentId = resolvePositiveInteger(req.params.studentId);
  const resetReason = resolveLearningCycleResetReason(req.body);
  if (!studentId || resetReason.error) {
    return res.status(400).json({ error: resetReason.error || 'A valid student ID is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const studentResult = await client.query(
      `SELECT id, name, grade_level, section
       FROM public.accounts
       WHERE id = $1
         AND LOWER(role) = 'student'
         AND COALESCE(is_archived, false) = false
         AND progress_archived_at IS NULL
       FOR UPDATE`,
      [studentId]
    );
    const student = studentResult.rows[0];
    if (!student) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Student not found.' });
    }

    const learningCycle = await startFreshLearningCycle(client, studentId);
    await client.query(
      `INSERT INTO public.activity_logs (
        student_id, student_name, grade_level, section, activity_description,
        actor_account_id, role, status, activity_timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Active', CURRENT_TIMESTAMP)`,
      [
        studentId,
        student.name,
        student.grade_level,
        student.section,
        `Student progress reset for new learning cycle — Reason: ${resetReason.auditReason}`,
        req.authenticatedUser.id,
        req.authenticatedRole,
      ]
    );
    await client.query('COMMIT');
    return res.json({
      success: true,
      student_id: studentId,
      learning_cycle_started_at: learningCycle.started_at || null,
      learning_cycle: learningCycle,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Learning cycle reset failed:', err.message);
    return res.status(500).json({ error: 'Unable to start a new learning cycle.' });
  } finally {
    client.release();
  }
});

app.get('/api/student-progress/lifecycle-summary', requireAnalyticsAccess, async (req, res) => {
  try {
    const operation = String(req.query.operation || '').trim().toLowerCase();
    const scope = getLifecycleMutationScope(req);
    if (!['reset', 'archive'].includes(operation)) {
      return res.status(400).json({ error: 'A valid lifecycle operation is required.' });
    }
    if (!scope) {
      return res.status(403).json({ error: 'Bulk lifecycle actions are limited to Admin or the authorized Teacher scope.' });
    }
    const targets = await getScopedLifecycleStudents(pool, scope, { lifecycle: 'active' });
    return res.json({ operation, affected_count: targets.rows.length });
  } catch (err) {
    console.error('Lifecycle summary failed:', err.message);
    return res.status(500).json({ error: 'Failed to prepare the lifecycle summary.' });
  }
});

const runBulkLifecycleAction = async (req, res, operation) => {
  const scope = getLifecycleMutationScope(req);
  const confirmation = resolveBulkLifecycleConfirmation(req.body, operation);
  const reasonResult = operation === 'archive'
    ? resolveLearningCycleArchiveReason(req.body)
    : resolveLearningCycleResetReason(req.body);
  if (!scope) {
    return res.status(403).json({ error: 'Bulk lifecycle actions are limited to Admin or the authorized Teacher scope.' });
  }
  if (confirmation.error || reasonResult.error) {
    return res.status(400).json({ error: confirmation.error || reasonResult.error });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const targetResult = await getScopedLifecycleStudents(client, scope, { lifecycle: 'active', forUpdate: true });
    const targets = targetResult.rows;
    if (targets.length !== confirmation.expectedCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'The affected student count changed. Review the summary and confirm again.' });
    }

    const descriptors = [];
    for (const student of targets) {
      if (operation === 'archive') {
        await client.query(
          `UPDATE public.accounts
           SET progress_archived_at = CURRENT_TIMESTAMP,
               progress_archived_by = $2,
               progress_archive_reason = $3
           WHERE id = $1`,
          [student.id, req.authenticatedUser.id, reasonResult.auditReason]
        );
        await writeStudentLifecycleAudit(client, {
          student,
          actor: req.authenticatedUser,
          role: req.authenticatedRole,
          action: 'Archive: Progress Archived',
          reason: reasonResult.auditReason,
          description: 'Historical gameplay, Screen Time, and Activity Log remain preserved.',
        });
      } else {
        const descriptor = await startFreshLearningCycle(client, student.id);
        descriptors.push({ student_id: student.id, learning_cycle: descriptor });
        await writeStudentLifecycleAudit(client, {
          student,
          actor: req.authenticatedUser,
          role: req.authenticatedRole,
          action: 'Reset: New Learning Cycle Started',
          reason: reasonResult.auditReason,
          description: `Started learning cycle ${descriptor.version}. Historical gameplay and Screen Time remain preserved.`,
        });
      }
    }

    if (targets.length > 0) {
      await writeStudentLifecycleAudit(client, {
        student: targets[0],
        actor: req.authenticatedUser,
        role: req.authenticatedRole,
        action: operation === 'archive' ? 'Archive: Progress Archived (bulk)' : 'Reset: New Learning Cycles Started (bulk)',
        reason: reasonResult.auditReason,
        description: `${targets.length} authorized Student progress records affected.`,
      });
    }
    await client.query('COMMIT');
    return res.json({ success: true, operation, affected_count: targets.length, learning_cycles: descriptors });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`Bulk ${operation} failed:`, err.message);
    return res.status(500).json({ error: `Unable to ${operation} authorized Student progress.` });
  } finally {
    client.release();
  }
};

app.post('/api/student-progress/:studentId/archive', requireAnalyticsAccess, verifyScopedStudentAnalyticsAccess, async (req, res) => {
  const studentId = resolvePositiveInteger(req.params.studentId);
  const scope = getLifecycleMutationScope(req);
  const archiveReason = resolveLearningCycleArchiveReason(req.body);
  if (!studentId || archiveReason.error) {
    return res.status(400).json({ error: archiveReason.error || 'A valid student ID is required.' });
  }
  if (!scope) {
    return res.status(403).json({ error: 'Only Admin or the authorized Teacher scope can archive progress.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const targetResult = await getScopedLifecycleStudents(client, scope, { lifecycle: 'active', forUpdate: true });
    const student = targetResult.rows.find((row) => Number(row.id) === studentId);
    if (!student) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Active student progress was not found.' });
    }
    const archiveResult = await client.query(
      `UPDATE public.accounts
       SET progress_archived_at = CURRENT_TIMESTAMP,
           progress_archived_by = $2,
           progress_archive_reason = $3
       WHERE id = $1
       RETURNING progress_archived_at`,
      [studentId, req.authenticatedUser.id, archiveReason.auditReason]
    );
    await writeStudentLifecycleAudit(client, {
      student,
      actor: req.authenticatedUser,
      role: req.authenticatedRole,
      action: 'Archive: Progress Archived',
      reason: archiveReason.auditReason,
      description: 'Historical gameplay, Screen Time, and Activity Log remain preserved.',
    });
    await client.query('COMMIT');
    return res.json({ success: true, student_id: studentId, progress_archived_at: archiveResult.rows[0]?.progress_archived_at || null });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Archive Progress failed:', err.message);
    return res.status(500).json({ error: 'Unable to archive Student progress.' });
  } finally {
    client.release();
  }
});

app.post('/api/student-progress/:studentId/permanent-delete', requireAccountManagementAdmin, async (req, res) => {
  const studentId = resolvePositiveInteger(req.params.studentId);
  const reason = String(req.body?.reason || '').trim();
  const confirmation = String(req.body?.confirmation_phrase || '').trim();
  if (!studentId || !reason || reason.length > MAX_LEARNING_CYCLE_RESET_REASON_LENGTH || confirmation !== 'DELETE') {
    return res.status(400).json({ error: 'A deletion reason and typed DELETE confirmation are required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const studentResult = await client.query(
      `SELECT id, name, grade_level, section
       FROM public.accounts
       WHERE id = $1
         AND LOWER(role) = 'student'
         AND COALESCE(is_archived, false) = false
         AND progress_archived_at IS NOT NULL
       FOR UPDATE`,
      [studentId]
    );
    const student = studentResult.rows[0];
    if (!student) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Student not found.' });
    }
    const descriptor = await startFreshLearningCycle(client, studentId);
    await client.query('DELETE FROM public.game_results WHERE resolved_student_id = $1', [studentId]);
    await client.query('DELETE FROM public.student_ai_insights WHERE student_id = $1', [studentId]);
    await writeStudentLifecycleAudit(client, {
      student,
      actor: req.authenticatedUser,
      role: 'admin',
      action: 'Permanent Gameplay Progress Delete',
      reason,
      description: 'Deleted student_game_progress, game_results, and derived insight state. Screen Time, Activity Log, accounts, and relationships remain preserved.',
    });
    await client.query('COMMIT');
    return res.json({ success: true, student_id: studentId, learning_cycle: descriptor });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Permanent gameplay progress delete failed:', err.message);
    return res.status(500).json({ error: 'Unable to permanently delete gameplay progress.' });
  } finally {
    client.release();
  }
});

app.post('/api/student-progress/:studentId/ai-insight', requireAnalyticsAccess, verifyScopedStudentAnalyticsAccess, async (req, res) => {
  try {
    const studentId = parseInt(req.params.studentId, 10);
    if (Number.isNaN(studentId)) return res.status(400).json({ error: 'Invalid student ID' });

    let progressQuery = buildCanonicalStudentProgressQuery();
    progressQuery += ' AND a.id = $1';
    progressQuery += ' ORDER BY p.last_played DESC NULLS LAST, a.id ASC LIMIT 1';
    const progressResult = await pool.query(progressQuery, [studentId]);
    if (progressResult.rows.length === 0) return res.status(404).json({ error: 'Student progress not found' });

    const [quizResult, playtimeResult] = await Promise.all([
      pool.query(
        `SELECT math_topic, difficulty, score, total_items, played_at
         FROM public.game_results
         WHERE resolved_student_id = $1
           AND ($2::TIMESTAMPTZ IS NULL OR played_at >= $2)
         ORDER BY played_at ASC NULLS LAST, id ASC
         LIMIT 500`,
        [studentId, progressResult.rows[0].current_learning_cycle_started_at || null]
      ),
      pool.query(
        `SELECT total_playtime_minutes, status
         FROM public.playtime_sessions
         WHERE student_id = $1
         ORDER BY date_played DESC, id DESC
         LIMIT 500`,
        [studentId]
      ),
    ]);
    const progress = normalizeStudentProgressRow(progressResult.rows[0]);
    const metrics = buildStudentAnalyticsMetrics({
      progress,
      quizSessions: quizResult.rows,
      playtimeSessions: playtimeResult.rows,
    });
    const input = buildGroundedInsightInput({ gradeLevel: progress.grade_level, metrics });
    const inputFingerprint = buildInsightFingerprint(input);
    const cachedResult = await pool.query(
      `SELECT input_fingerprint, insight, generated_at, stale_at
       FROM public.student_ai_insights
       WHERE student_id = $1
       LIMIT 1`,
      [studentId]
    );
    const cachedInsight = cachedResult.rows[0] || null;
    const currentState = buildAiInsightState({ metrics, cachedInsight, inputFingerprint });
    if (currentState.status === 'insufficient_data' || currentState.status === 'cached') {
      return res.status(currentState.status === 'insufficient_data' ? 422 : 200).json(currentState);
    }

    let insight;
    try {
      insight = await generateGroundedStudentInsight({ input });
    } catch (error) {
      if (error instanceof QuestionGenerationError && error.providerDiagnostics) {
        console.error('Grounded AI provider diagnostics:', error.providerDiagnostics);
      }
      const status = error?.code === 'ANALYTICS_AI_NOT_CONFIGURED' ? 503 : 502;
      return res.status(status).json({
        status: 'unavailable',
        error: status === 503
          ? 'Grounded AI Insights are not configured on the backend service.'
          : 'Grounded AI Insights are unavailable right now.',
      });
    }

    const savedResult = await pool.query(
      `INSERT INTO public.student_ai_insights (
         student_id, input_fingerprint, insight, generated_by, generated_at, stale_at, updated_at
       ) VALUES ($1, $2, $3::jsonb, $4, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP)
       ON CONFLICT (student_id) DO UPDATE
       SET input_fingerprint = EXCLUDED.input_fingerprint,
           insight = EXCLUDED.insight,
           generated_by = EXCLUDED.generated_by,
           generated_at = CURRENT_TIMESTAMP,
           stale_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       RETURNING insight, generated_at`,
      [studentId, inputFingerprint, JSON.stringify(insight), req.authenticatedUser.id]
    );
    return res.json({
      status: currentState.status === 'stale' ? 'regenerated' : 'generated',
      required_result_count: MIN_GROUNDED_INSIGHT_RESULTS,
      valid_result_count: metrics.validResultCount,
      generated_at: savedResult.rows[0]?.generated_at || null,
      insight: savedResult.rows[0]?.insight || insight,
    });
  } catch (err) {
    console.error('Generate grounded student insight failed:', err.message);
    return res.status(500).json({ error: 'Failed to generate grounded AI insight' });
  }
});

app.get('/api/student-progress/:studentId', requireAnalyticsAccess, verifyScopedStudentAnalyticsAccess, async (req, res) => {
  try {
    const studentId = parseInt(req.params.studentId, 10);
    if (Number.isNaN(studentId)) return res.status(400).json({ error: 'Invalid student ID' });
    const scope = resolveAnalyticsScope(req);
    const lifecycle = resolveStudentProgressLifecycle(req.query.lifecycle);
    if (!lifecycle) return res.status(400).json({ error: 'lifecycle must be active or archived.' });

    const params = [studentId];
    let query = buildCanonicalStudentProgressQuery(lifecycle);
    query += ' AND a.id = $1';
    query += appendAnalyticsScopeFilter({ scope, params, studentColumn: 'a.id' });
    query += ' ORDER BY p.last_played DESC NULLS LAST, a.id ASC LIMIT 1';

    const result = await pool.query(query, params);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Student progress not found' });

    const progress = normalizeStudentProgressRow(result.rows[0]);
    const cycleBoundary = progress.current_learning_cycle_started_at || null;
    const [quizResult, activityResult, playtimeResult] = await Promise.all([
      pool.query(
        `SELECT math_topic, difficulty, percentage, score, total_items, played_at
         FROM public.game_results
         WHERE resolved_student_id = $1
           AND ($2::TIMESTAMPTZ IS NULL OR played_at >= $2)
         ORDER BY played_at ASC NULLS LAST, id ASC
         LIMIT 100`,
        [studentId, cycleBoundary]
      ),
      pool.query(
        `SELECT student_id, activity_description, quest_progress, lesson_progress, activity_timestamp, last_played
         FROM public.activity_logs
         WHERE student_id = $1
           AND ($2::TIMESTAMPTZ IS NULL OR activity_timestamp >= $2)
         ORDER BY activity_timestamp DESC NULLS LAST, id DESC
         LIMIT 100`,
        [studentId, cycleBoundary]
      ),
      pool.query(
        `SELECT total_playtime_minutes, status, date_played, end_time
         FROM public.playtime_sessions
         WHERE student_id = $1
         ORDER BY date_played DESC, id DESC
         LIMIT 100`,
        [studentId]
      ),
    ]);
    const metrics = buildStudentAnalyticsMetrics({
      progress,
      quizSessions: quizResult.rows,
      playtimeSessions: playtimeResult.rows,
    });
    const insightInput = buildGroundedInsightInput({ gradeLevel: progress.grade_level, metrics });
    const insightFingerprint = buildInsightFingerprint(insightInput);
    const cachedInsightResult = await pool.query(
      `SELECT input_fingerprint, insight, generated_at, stale_at
       FROM public.student_ai_insights
       WHERE student_id = $1
       LIMIT 1`,
      [studentId]
    );
    const aiInsight = buildAiInsightState({
      metrics,
      cachedInsight: cachedInsightResult.rows[0] || null,
      inputFingerprint: insightFingerprint,
    });
    const analysis = generateStudentAnalysis(progress, quizResult.rows, activityResult.rows);
    const analyticsReadiness = buildStudentAnalyticsReadiness({
      progress,
      quizSessions: quizResult.rows,
      activityLogs: activityResult.rows,
    });
    res.json({ progress, metrics, analysis, analyticsReadiness, aiInsight });
  } catch (err) {
    console.error('Fetch student progress failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch student progress' });
  }
});

const clientBuildPath = path.join(__dirname, '..', 'build');
if (fs.existsSync(clientBuildPath)) {
  app.use(express.static(clientBuildPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientBuildPath, 'index.html'));
  });
}

if (require.main === module) {
  app.listen(port, () => {
    console.log(`✅ Server running at http://localhost:${port}`);
  });
}

module.exports = { app, verifyParentChildAccess };
