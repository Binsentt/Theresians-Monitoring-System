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
  validateLearningMetadata,
  normalizeDifficultyValue,
  parseLessonQuestionCount,
} = require('./learningContentRules.utils');
const {
  QuestionGenerationError,
  generateLessonQuestions,
} = require('./lessonQuestionGeneration');
const {
  toQuestionSetResponse,
} = require('./questionSetLifecycle.utils');
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
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS session_version INTEGER DEFAULT 0');
    await pool.query('UPDATE public.accounts SET is_archived = false WHERE is_archived IS NULL');
    await pool.query('UPDATE public.accounts SET session_version = 0 WHERE session_version IS NULL');
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
    await pool.query('CREATE INDEX IF NOT EXISTS idx_activity_logs_timestamp ON public.activity_logs(activity_timestamp DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_activity_logs_student_name ON public.activity_logs(student_name)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_activity_logs_grade_section ON public.activity_logs(grade_level, section)');

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
    await pool.query('CREATE INDEX IF NOT EXISTS idx_playtime_sessions_student_date ON public.playtime_sessions(student_id, date_played)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_playtime_sessions_parent_id ON public.playtime_sessions(parent_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_playtime_sessions_status ON public.playtime_sessions(status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_playtime_sessions_expiry ON public.playtime_sessions(status, expires_at)');

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
      math_topic VARCHAR(100) NOT NULL,
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
      source VARCHAR(50) NOT NULL,
      published BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`);
    await pool.query('ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS difficulty VARCHAR(20)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_learning_files_published ON public.learning_files(published)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_questions_published ON public.questions(published)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_learning_files_grade_difficulty_topic ON public.learning_files(grade_level, difficulty, math_topic)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_learning_files_lifecycle ON public.learning_files(generation_status, publish_status)');
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_files_client_provided_fingerprint
      ON public.learning_files (source_content_fingerprint)
      WHERE source_content_fingerprint IS NOT NULL
        AND source IN ('restored_import', 'client_provided')`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_questions_grade_difficulty_topic ON public.questions(grade_level, difficulty, math_topic)');
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

const requireLessonQuestionManagerAccess = requireAuthenticatedRoles(['admin', 'teacher', 'parent_teacher']);
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

const PARENT_CHILD_GRADE_LEVELS = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'];
const PARENT_CHILD_SECTIONS_BY_GRADE = {
  'Grade 1': ['Section A', 'Section B'],
  'Grade 2': ['Section A', 'Section B', 'Section C'],
  'Grade 3': ['Section A', 'Section B', 'Section C'],
  'Grade 4': ['Section A', 'Section B', 'Section C'],
  'Grade 5': ['Section A', 'Section B', 'Section C'],
  'Grade 6': ['Section A', 'Section B', 'Section C'],
};

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

  const sectionResult = normalizeSchoolSection(payload.section);
  if (sectionResult.error) return sectionResult;

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
    section: sectionResult.section,
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

const buildCanonicalStudentProgressQuery = () => `
  SELECT p.*,
         a.id AS student_id,
         a.name AS student_name,
         a.email AS student_email,
         a.role AS student_role,
         a.game_student_id,
         COALESCE(NULLIF(a.grade_level, ''), p.grade_level) AS grade_level,
         COALESCE(NULLIF(a.section, ''), p.section) AS section
  FROM public.accounts a
  LEFT JOIN LATERAL (
    SELECT progress.*
    FROM public.student_game_progress progress
    WHERE progress.student_id = a.id
    ORDER BY progress.updated_at DESC NULLS LAST, progress.id DESC
    LIMIT 1
  ) p ON true
  WHERE LOWER(a.role) = 'student'
    AND COALESCE(a.is_archived, false) = false
`;

const calculateGameResultPercentage = ({ score, totalItems }) => {
  const scoreValue = toNullableNumber(score);
  const totalItemsValue = toNullableNumber(totalItems);
  if (scoreValue === null || totalItemsValue === null || totalItemsValue <= 0) return null;

  return Math.min(100, Math.max(0, Number(((scoreValue / totalItemsValue) * 100).toFixed(2))));
};

const normalizeGameGradeLevel = (value) => {
  const normalized = String(value || '').trim();
  const numericMatch = normalized.match(/^(?:grade\s*)?([1-6])$/i);
  if (numericMatch) return `Grade ${numericMatch[1]}`;
  return normalized || null;
};

const QUESTION_GRADE_LEVELS = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6'];
const QUESTION_DIFFICULTIES = ['Easy', 'Medium', 'Hard'];

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
  const grade = String(gradeLevel || '').trim();
  const level = normalizeDifficultyValue(difficulty);
  if (!grade) return 'Questions/';
  if (!level) return `Questions/${grade}/`;
  return `Questions/${grade}/${level}`;
};

const canonicalDifficultySql = (columnName) => (
  `CASE
     WHEN LOWER(COALESCE(${columnName}, '')) IN ('normal', 'average', 'medium', 'normal / average') THEN 'Medium'
     WHEN LOWER(COALESCE(${columnName}, '')) IN ('difficult', 'hard') THEN 'Hard'
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
    folder_name: buildQuestionFolderPath(safeRow.grade_level, difficulty),
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

const resolveGameResultQuestionSet = async ({ rawQuestionSetId, gradeLevel, difficulty, mathTopic }) => {
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
    `SELECT id, grade_level, difficulty, math_topic, publish_status
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

  const matchingScope = (
    normalizeGameGradeLevel(questionSet.grade_level) === normalizeGameGradeLevel(gradeLevel)
    && normalizeDifficultyValue(questionSet.difficulty) === normalizeDifficultyValue(difficulty)
    && String(questionSet.math_topic || '').trim() === String(mathTopic || '').trim()
  );
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
    if (!originalName.endsWith('.pdf') || !hasAllowedMimeType(file, ['application/pdf'])) {
      return 'Lesson PDF files must be uploaded as a valid PDF.';
    }
    try {
      const signature = fs.readFileSync(file.path).subarray(0, 5).toString('utf8');
      if (signature !== '%PDF-') return 'Lesson PDF files must be uploaded as a valid PDF.';
    } catch {
      return 'The uploaded Lesson PDF could not be read.';
    }
    return '';
  }

  if (fileType === 'fixed_questions') {
    const jsonFile = originalName.endsWith('.json')
      && hasAllowedMimeType(file, ['application/json', 'text/json']);
    const csvFile = originalName.endsWith('.csv')
      && hasAllowedMimeType(file, ['text/csv', 'application/csv', 'application/vnd.ms-excel']);
    return jsonFile || csvFile ? '' : 'Fixed Question Files must be uploaded as JSON or CSV.';
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
    `INSERT INTO public.questions (learning_file_id, question, options, correct_answer, grade_level, difficulty, math_topic, source, published)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [learningFileId, item.question, JSON.stringify(item.options || []), item.correct_answer, item.grade_level, item.difficulty || null, item.math_topic, item.source || 'ai', false]
  ));
  await Promise.all(insertPromises);
};

const parseFixedQuestionsFile = async (file) => {
  const buffer = fs.readFileSync(file.path);
  const content = buffer.toString('utf8');
  const lowerName = String(file.originalname).toLowerCase();
  if (lowerName.endsWith('.json')) {
    const payload = JSON.parse(content);
    if (!Array.isArray(payload)) throw new Error('JSON must contain an array of questions');
    return payload.map((item) => ({
      question: String(item.question || '').trim(),
      options: Array.isArray(item.options) ? item.options : [],
      correct_answer: String(item.correct_answer || item.answer || '').trim(),
      grade_level: String(item.grade_level || '').trim(),
      math_topic: String(item.math_topic || '').trim(),
      source: 'fixed',
    })).filter((item) => item.question && item.correct_answer);
  }
  if (lowerName.endsWith('.csv')) {
    const rows = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return rows.map((line) => {
      const [question, ...rest] = line.split(',').map((cell) => cell.trim());
      const options = rest.slice(0, 4).filter(Boolean);
      return {
        question,
        options,
        correct_answer: options[0] || '',
        grade_level: '',
        math_topic: '',
        source: 'fixed',
      };
    }).filter((item) => item.question && item.correct_answer);
  }
  throw new Error('Unsupported fixed question file format');
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

const generateQuestionTextFromLesson = async (filePath, title, grade_level, difficulty, math_topic, questionCount) => {
  const buffer = fs.readFileSync(filePath);
  let pdfData;
  try {
    pdfData = await pdfParse(buffer);
  } catch {
    throw new QuestionGenerationError('QUESTION_AI_EMPTY_LESSON', 'The Lesson PDF could not be read for question generation.');
  }
  const lessonText = String(pdfData?.text || '').trim();
  if (!lessonText) {
    throw new QuestionGenerationError('QUESTION_AI_EMPTY_LESSON', 'The Lesson PDF does not contain readable text for question generation.');
  }

  return generateLessonQuestions({
    lessonText,
    title,
    gradeLevel: grade_level,
    difficulty,
    mathTopic: math_topic,
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

const publishLearningFile = async (fileId, publisherId) => {
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

    if (learningFile.generation_status === 'generating') {
      throw createLifecycleHttpError('Question generation is still in progress.', 409);
    }
    if (learningFile.generation_status === 'failed') {
      throw createLifecycleHttpError('Failed question sets must be generated successfully before publishing.', 409);
    }

    const questionCountResult = await client.query(
      `SELECT COUNT(*)::INTEGER AS question_count
       FROM public.questions
       WHERE learning_file_id = $1
         AND BTRIM(question) <> ''
         AND BTRIM(correct_answer) <> ''`,
      [fileId]
    );
    if (Number(questionCountResult.rows[0]?.question_count || 0) < 1) {
      throw createLifecycleHttpError('A question set must contain valid questions before it can be published.', 422);
    }

    const canonicalDifficulty = normalizeDifficultyValue(learningFile.difficulty);
    const scopeKey = `${learningFile.grade_level}|${canonicalDifficulty}|${learningFile.math_topic}`;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [scopeKey]);

    const destinationParams = [
      learningFile.grade_level,
      canonicalDifficulty,
      learningFile.math_topic,
      fileId,
    ];
    const learningDifficulty = canonicalDifficultySql('difficulty');
    const linkedLearningDifficulty = canonicalDifficultySql('lf.difficulty');

    await client.query(
      `UPDATE public.learning_files
       SET published = false,
           publish_status = 'superseded'
       WHERE grade_level = $1
         AND ${learningDifficulty} = $2
         AND math_topic = $3
         AND id <> $4
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
         AND lf.math_topic = $3
         AND lf.id <> $4
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
    await client.query('COMMIT');
    return normalizeLearningFileRow(publishedResult.rows[0] || learningFile);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const unpublishLearningFile = async (fileId) => {
  await pool.query(
    `UPDATE public.learning_files
     SET published = false,
         publish_status = 'staged'
     WHERE id = $1`,
    [fileId]
  );
  await pool.query('UPDATE public.questions SET published = false WHERE learning_file_id = $1', [fileId]);
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
      path.join(uploadsDir, fileRecord.file_name),
      fileRecord.title,
      fileRecord.grade_level,
      fileRecord.difficulty,
      fileRecord.math_topic,
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

const getGameQuestions = async ({ grade_level, difficulty, math_topic }) => {
  const params = ['Mathematics'];
  let clause = 'WHERE lf.subject = $1 AND lf.published = true AND lf.deleted_at IS NULL';
  const normalizedDifficulty = difficulty ? normalizeDifficultyValue(difficulty) : null;
  const lfDifficulty = canonicalDifficultySql('lf.difficulty');
  const activeDifficulty = canonicalDifficultySql('active_lf.difficulty');
  if (grade_level) {
    params.push(grade_level);
    clause += ` AND lf.grade_level = $${params.length}`;
  }
  if (normalizedDifficulty) {
    params.push(normalizedDifficulty);
    clause += ` AND ${lfDifficulty} = $${params.length}`;
  }
  if (math_topic) {
    params.push(math_topic);
    clause += ` AND lf.math_topic = $${params.length}`;
  }
  if (grade_level && difficulty && math_topic) {
    clause += `
      AND lf.id = (
        SELECT active_lf.id
        FROM public.learning_files active_lf
        WHERE active_lf.subject = $1
          AND active_lf.published = true
          AND active_lf.deleted_at IS NULL
          AND active_lf.grade_level = $2
          AND ${activeDifficulty} = $3
          AND active_lf.math_topic = $4
        ORDER BY active_lf.uploaded_at DESC, active_lf.id DESC
        LIMIT 1
      )`;
  }
  const result = await pool.query(
    `SELECT q.* FROM public.questions q
     JOIN public.learning_files lf ON lf.id = q.learning_file_id
     ${clause}
     AND q.published = true
     ORDER BY q.created_at DESC`,
    params
  );
  return result.rows.map((row) => ({
    id: row.id,
    learning_file_id: row.learning_file_id,
    question: row.question,
    options: row.options,
    correct_answer: row.correct_answer,
    grade_level: row.grade_level,
    difficulty: normalizeDifficultyValue(row.difficulty),
    math_topic: row.math_topic,
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

const getGameFiles = async ({ grade_level, difficulty, math_topic }) => {
  const params = ['Mathematics'];
  let clause = 'WHERE subject = $1 AND published = true AND deleted_at IS NULL';
  const normalizedDifficulty = difficulty ? normalizeDifficultyValue(difficulty) : null;
  const difficultySql = canonicalDifficultySql('difficulty');
  if (grade_level) {
    params.push(grade_level);
    clause += ` AND grade_level = $${params.length}`;
  }
  if (normalizedDifficulty) {
    params.push(normalizedDifficulty);
    clause += ` AND ${difficultySql} = $${params.length}`;
  }
  if (math_topic) {
    params.push(math_topic);
    clause += ` AND math_topic = $${params.length}`;
  }
  if (grade_level && difficulty && math_topic) {
    clause += `
      AND id = (
        SELECT id
        FROM public.learning_files
        WHERE subject = $1
          AND published = true
          AND deleted_at IS NULL
          AND grade_level = $2
          AND ${difficultySql} = $3
          AND math_topic = $4
        ORDER BY uploaded_at DESC, id DESC
        LIMIT 1
      )`;
  }
  const result = await pool.query(`SELECT * FROM public.learning_files ${clause} ORDER BY uploaded_at DESC`, params);
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    file_url: row.file_url,
    grade_level: row.grade_level,
    difficulty: normalizeDifficultyValue(row.difficulty),
    math_topic: row.math_topic,
    file_type: row.file_type,
    published: row.published,
  }));
};

const getPublishedLearningData = async (query) => ({
  learning_files: await getGameFiles(query),
  questions: await getGameQuestions(query),
});

const buildLearningFileView = (row) => ({
  ...row,
  folder_name: row.folder_name || 'Unassigned',
});

const buildQuestionView = (row) => ({
  id: row.id,
  question: row.question,
  options: row.options,
  correct_answer: row.correct_answer,
  grade_level: row.grade_level,
  math_topic: row.math_topic,
  published: row.published,
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

const fetchPublishedGameData = async ({ grade_level, math_topic }) => {
  const files = await getGameFiles({ grade_level, math_topic });
  const questions = await getGameQuestions({ grade_level, math_topic });
  return { learning_files: files, questions };
};

const safeString = (value) => String(value || '').trim();

const readJsonFile = (pathInput) => JSON.parse(fs.readFileSync(pathInput, 'utf8'));

// Keep existing helper definitions after this point.

const buildPublishedGameQuery = ({ grade_level, math_topic }) => {
  const params = ['Mathematics'];
  let clause = 'lf.subject = $1 AND lf.published = true AND lf.deleted_at IS NULL';
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

const getGameQuestionsByQuery = async ({ grade_level, math_topic }) => {
  const { clause, params } = buildPublishedGameQuery({ grade_level, math_topic });
  const query = `
    SELECT q.*
    FROM public.questions q
    JOIN public.learning_files lf ON q.learning_file_id = lf.id
    WHERE q.published = true
      AND ${clause}
    ORDER BY q.created_at DESC
  `;
  const result = await pool.query(query, params);
  return result.rows.map(buildQuestionView);
};

const getGameLearningFilesByQuery = async ({ grade_level, math_topic }) => {
  const { clause, params } = buildPublishedGameQuery({ grade_level, math_topic });
  const result = await pool.query(`
    SELECT lf.*, f.name AS folder_name
    FROM public.learning_files lf
    LEFT JOIN public.folders f ON lf.folder_id = f.id
    WHERE ${clause}
    ORDER BY lf.uploaded_at DESC
  `, params);
  return result.rows.map(buildLearningFileView);
};

const getGameDataByQuery = async (query) => ({
  learning_files: await getGameLearningFilesByQuery(query),
  questions: await getGameQuestionsByQuery(query),
});

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

const getPublishedGameContent = async (query) => {
  const files = await getGameLearningFilesByQuery(query);
  const questions = await getGameQuestionsByQuery(query);
  return { learning_files: files, questions };
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
    const mobileResult = normalizePhilippineMobile(mobile_number !== undefined ? mobile_number : old.mobile_number);
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
      `SELECT 1 AS active_question_set
       FROM public.learning_files
       WHERE folder_id = $1
         AND deleted_at IS NULL
         AND (published = true OR publish_status = 'active')
       LIMIT 1`,
      [folderId]
    );
    if (activeQuestionSetResult.rows.length > 0) {
      return res.status(409).json({
        error: 'This folder contains an Active in Game question set. Publish a replacement before moving it to Trash.',
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
      `SELECT 1 AS active_question_set
       FROM public.learning_files
       WHERE folder_id = $1
         AND (published = true OR publish_status = 'active')
       LIMIT 1`,
      [folderId]
    );
    if (activeQuestionSetResult.rows.length > 0) {
      return res.status(409).json({
        error: 'This folder contains an Active in Game question set. Publish a replacement before permanently deleting it.',
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

app.post('/api/learning-files/upload', requireLessonQuestionManagerAccess, upload.single('file'), async (req, res) => {
  let storedFilePath = null;
  let persistedLearningFileId = null;
  try {
    const { title, grade_level, difficulty, math_topic, file_type, folder_id, expected_question_count } = req.body;
    if (!req.file) return res.status(400).json({ error: 'File is required' });
    if (!title || !grade_level || !difficulty || !math_topic || !file_type) {
      return res.status(400).json({ error: 'Missing required metadata' });
    }

    const normalizedGrade = String(grade_level).trim();
    const normalizedDifficulty = normalizeDifficultyValue(difficulty);
    const normalizedTopic = String(math_topic).trim();
    const normalizedType = String(file_type).trim().toLowerCase();

    const learningMetadataError = validateLearningMetadata({
      grade_level: normalizedGrade,
      difficulty: normalizedDifficulty,
      math_topic: normalizedTopic,
    });
    if (learningMetadataError) {
      cleanTemporaryUpload(req.file.path);
      return res.status(400).json({ error: learningMetadataError });
    }
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
    if (normalizedType === 'lesson') {
      const parsedCount = parseLessonQuestionCount(expected_question_count);
      if (parsedCount.error) {
        cleanTemporaryUpload(req.file.path);
        return res.status(400).json({ error: parsedCount.error });
      }
      requestedQuestionCount = parsedCount.value;
    } else {
      if (String(expected_question_count ?? '').trim()) {
        cleanTemporaryUpload(req.file.path);
        return res.status(400).json({ error: 'Question Count is only available for Lesson PDF files.' });
      }
      fixedQuestions = await parseFixedQuestionsFile({ path: req.file.path, originalname: req.file.originalname });
      if (fixedQuestions.length === 0) {
        cleanTemporaryUpload(req.file.path);
        return res.status(400).json({ error: 'Fixed Question File does not contain valid questions.' });
      }
    }

    const fileName = generateUploadFileName(req.file.originalname);
    const destinationPath = path.join(uploadsDir, fileName);
    fs.renameSync(req.file.path, destinationPath);
    storedFilePath = destinationPath;
    const fileUrl = buildFileUrl(fileName);

    const createLearningFile = async (generationStatus) => {
      const insertResult = await pool.query(
        `INSERT INTO public.learning_files (
          title, file_name, file_url, grade_level, difficulty, math_topic,
          file_type, subject, folder_id, published, source, uploaded_by,
          file_size, requested_question_count, generation_status, publish_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Mathematics', $8, false, $9, $10, $11, $12, $13, 'staged')
         RETURNING *`,
        [
          String(title).trim(),
          req.file.originalname,
          fileUrl,
          normalizedGrade,
          normalizedDifficulty,
          normalizedTopic,
          normalizedType,
          folderResolution.folderId,
          normalizedType === 'lesson' ? 'lesson' : 'fixed',
          req.authenticatedUser.id,
          req.file.size || null,
          requestedQuestionCount,
          generationStatus,
        ]
      );
      persistedLearningFileId = insertResult.rows[0].id;
      return insertResult.rows[0];
    };

    if (normalizedType === 'lesson') {
      let learningFile = await createLearningFile('generating');
      try {
        if (!String(process.env.OPENAI_API_KEY || '').trim()) {
          throw new QuestionGenerationError('QUESTION_AI_NOT_CONFIGURED', 'Question AI is not configured. Set OPENAI_API_KEY on the backend service.');
        }
        const questions = await generateQuestionTextFromLesson(
          storedFilePath,
          String(title).trim(),
          normalizedGrade,
          normalizedDifficulty,
          normalizedTopic,
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
          title, file_name, file_url, grade_level, difficulty, math_topic,
          file_type, subject, folder_id, published, source, uploaded_by,
          file_size, requested_question_count, generation_status, publish_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Mathematics', $8, false, $9, $10, $11, NULL, 'not_applicable', 'staged')
         RETURNING *`,
        [
          String(title).trim(),
          req.file.originalname,
          fileUrl,
          normalizedGrade,
          normalizedDifficulty,
          normalizedTopic,
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
        : err.code === 'QUESTION_AI_EMPTY_LESSON' || err.code === 'QUESTION_AI_INVALID_REQUEST' ? 422
          : 502;
      const error = err.code === 'QUESTION_AI_NOT_CONFIGURED'
        ? err.message
        : 'Question generation could not be completed. Please review the Lesson PDF and try again.';
      return res.status(status).json({ error });
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
    res.json(result.rows.map(normalizeLearningFileRow));
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

    const result = await pool.query(
      `SELECT q.id, q.learning_file_id, q.question, q.options, q.correct_answer,
              q.grade_level, q.difficulty, q.math_topic, q.source, q.published
       FROM public.questions q
       JOIN public.learning_files lf ON lf.id = q.learning_file_id
       WHERE q.learning_file_id = $1
         AND lf.deleted_at IS NULL
       ORDER BY q.id ASC`,
      [fileId]
    );

    res.json({
      questions: result.rows.map((question) => ({
        ...question,
        difficulty: normalizeDifficultyValue(question.difficulty),
      })),
    });
  } catch (err) {
    console.error('Preview generated questions failed:', err.message);
    res.status(500).json({ error: 'Failed to preview questions' });
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

    const result = await pool.query(
      `UPDATE public.learning_files
       SET title = $1
       WHERE id = $2
         AND deleted_at IS NULL
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
    const { title, grade_level, difficulty, math_topic, file_type, folder_id } = req.body;
    if (!title || !grade_level || !difficulty || !math_topic || !file_type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const normalizedGrade = String(grade_level).trim();
    const normalizedDifficulty = normalizeDifficultyValue(difficulty);
    const normalizedTopic = String(math_topic).trim();
    const normalizedType = String(file_type).trim().toLowerCase();
    const learningMetadataError = validateLearningMetadata({
      grade_level: normalizedGrade,
      difficulty: normalizedDifficulty,
      math_topic: normalizedTopic,
    });
    if (learningMetadataError) {
      return res.status(400).json({ error: learningMetadataError });
    }
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
           math_topic = $4,
           file_type = $5,
           folder_id = $6,
           published = false,
           publish_status = 'staged',
           published_at = NULL,
           published_by = NULL
     WHERE id = $7
        AND deleted_at IS NULL
       RETURNING *`,
      [String(title).trim(), normalizedGrade, normalizedDifficulty, normalizedTopic, normalizedType, folderResolution.folderId, fileId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'File not found' });

    await pool.query(
      `UPDATE public.questions
       SET grade_level = $1,
           difficulty = $2,
           math_topic = $3
       WHERE learning_file_id = $4`,
      [normalizedGrade, normalizedDifficulty, normalizedTopic, fileId]
    );

    res.json(normalizeLearningFileRow(result.rows[0]));
  } catch (err) {
    console.error('Update learning file failed:', err.message);
    res.status(500).json({ error: 'Failed to update file' });
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
        error: 'This question set is Active in Game. Publish a replacement before moving it to Trash.',
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
        error: 'This question set is Active in Game. Publish a replacement before permanently deleting it.',
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
    const learningFile = await publishLearningFile(fileId, req.authenticatedUser.id);
    res.json({ success: true, message: 'Content pushed to game.', learningFile });
  } catch (err) {
    console.error('Publish failed:', err.message);
    res.status(err.statusCode || 500).json({ error: err.statusCode === 404 ? err.message : 'Failed to publish content' });
  }
});

app.post('/api/questions/unpublish/:id', requireLessonQuestionManagerAccess, async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    if (Number.isNaN(fileId)) return res.status(400).json({ error: 'Invalid file ID' });
    await unpublishLearningFile(fileId);
    res.json({ success: true, message: 'Content removed from game.' });
  } catch (err) {
    console.error('Unpublish failed:', err.message);
    res.status(500).json({ error: 'Failed to remove content from game' });
  }
});

app.get('/api/game/questions', async (req, res) => {
  try {
    const grade_level = normalizeGameGradeLevel(req.query.grade_level || req.query.grade);
    const difficulty = req.query.difficulty || null;
    const math_topic = req.query.math_topic || req.query.topic || null;
    const learningFiles = await getGameFiles({ grade_level, difficulty, math_topic });
    const gameQuestions = await getGameQuestions({ grade_level, difficulty, math_topic });
    if (gameQuestions.length > 0) {
      await markLearningFilesFetchedByGame(gameQuestions);
    }
    res.json({ learning_files: learningFiles, questions: gameQuestions });
  } catch (err) {
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
      `SELECT s.id
       FROM public.accounts s
       JOIN public.teacher_student_relationships r ON r.student_id = s.id
       JOIN public.accounts p ON p.id = r.teacher_id
       WHERE s.game_student_id = $1
         AND p.parent_id = $2
         AND LOWER(r.relationship_type) = 'parent'
         AND COALESCE(s.is_archived, false) = false
         AND COALESCE(p.is_archived, false) = false
       LIMIT 1`,
      [studentCode, parentCode]
    );

    if (linkedStudent.rows.length === 0) {
      const existingStudent = await pool.query(
        'SELECT id FROM public.accounts WHERE game_student_id = $1 LIMIT 1',
        [studentCode]
      );
      if (existingStudent.rows.length > 0) {
        return res.status(409).json({
          ok: false,
          exists: true,
          should_block: true,
          can_play: false,
          error: 'Student ID already has an existing game profile. Please use Load Game.',
          message: 'Student ID already has an existing game profile. Please use Load Game.',
        });
      }
      return res.status(200).json({
        ok: true,
        exists: false,
        should_block: false,
        can_play: true,
        message: 'Student ID is available for a new game.',
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
        if (studentResult.rows.length > 0) student = studentResult.rows[0];
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
    const resolvedSection = String(student.section || '').trim() || section || null;

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
      `SELECT id, student_id, parent_id, status, expires_at, session_credential_hash
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

    const questionSetResolution = await resolveGameResultQuestionSet({
      rawQuestionSetId: req.body?.question_set_id,
      gradeLevel: resultGradeLevel,
      difficulty,
      mathTopic: math_topic,
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
    const result = await pool.query('SELECT * FROM accounts WHERE id = $1', [req.params.id]);
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
    const mobileResult = normalizePhilippineMobile(
      req.body.mobile_number !== undefined ? req.body.mobile_number : old.mobile_number
    );
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
             LEAST(NOW(), COALESCE(expires_at, NOW()))
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
             LEAST(NOW(), COALESCE(expires_at, NOW()))
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
  if (status) filters.push(`ps.status = ${addParam(normalizePlaytimeStatus(status, status))}`);

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
        status: normalizePlaytimeStatus(row.status, 'Offline'),
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
      `SELECT s.id, s.name, s.grade_level, s.section
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
    let resolvedStudentName = studentName;
    let resolvedGradeLevel = String(req.body.grade_level || req.body.grade || '').trim() || null;
    let resolvedSection = String(req.body.section || '').trim() || null;
    if (linkedStudentResult.rows.length > 0) {
      // Parent-created profiles own identity, grade, and section. Never allow
      // the game client to overwrite those fields while starting a lease.
      const linkedStudent = linkedStudentResult.rows[0];
      studentId = linkedStudent.id;
      resolvedStudentName = String(linkedStudent.name || '').trim() || studentName;
      resolvedGradeLevel = String(linkedStudent.grade_level || '').trim() || resolvedGradeLevel;
      resolvedSection = String(linkedStudent.section || '').trim() || resolvedSection;
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
              )))::INTEGER AS remaining_seconds
       FROM public.playtime_sessions
       WHERE student_id = $1
         AND status = 'Playing'
       ORDER BY COALESCE(server_started_at, start_time) DESC NULLS LAST, id DESC
       LIMIT 1`,
      [studentId]
    );

    if (activeSessionResult.rows.length > 0) {
      const activeSession = activeSessionResult.rows[0];
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
        session_credential_hash, last_heartbeat_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        CURRENT_DATE, NOW(), NOW(),
        LEAST(
          NOW() + ($6::INTEGER * INTERVAL '1 second'),
          date_trunc('day', NOW()) + INTERVAL '1 day'
        ),
        'Playing', 0, 0, $7, NOW(), NOW(), NOW()
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
      ]
    );

    const session = result.rows[0];
    return res.status(201).json(toPlaytimeResponse({
      session,
      totalPlaytimeSeconds,
      sessionCredential,
      remainingSeconds: session?.remaining_seconds,
      message: 'Playtime session started.',
    }));
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
              GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (
                COALESCE(expires_at, NOW()) - NOW()
              )))::INTEGER AS remaining_seconds
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
              COALESCE(p.grade_level, s.grade_level) AS grade_level,
              COALESCE(p.section, s.section) AS section,
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
         ORDER BY progress.updated_at DESC NULLS LAST, progress.id DESC
         LIMIT 1
       ) p ON true
       LEFT JOIN public.game_results gr ON gr.resolved_student_id = s.id
       WHERE tsr.teacher_id = $1
         AND LOWER(tsr.relationship_type) = 'parent'
         AND COALESCE(s.is_archived, false) = false
       GROUP BY s.id, p.id, p.grade_level, p.section, p.current_quest, p.score, p.progress_percentage
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
        `SELECT id, parent_id, student_name, resolved_student_id, grade_level, difficulty,
                math_topic, score, total_items, percentage, played_at
         FROM public.game_results
         WHERE resolved_student_id = $1
         ORDER BY played_at DESC NULLS LAST, id DESC
         LIMIT $2 OFFSET $3`,
        [studentId, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::INTEGER AS total
         FROM public.game_results
         WHERE resolved_student_id = $1`,
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
      `SELECT math_topic,
              COUNT(*)::INTEGER AS times_played,
              MAX(score) AS best_score
       FROM public.game_results
       WHERE resolved_student_id = $1
         AND math_topic IS NOT NULL
       GROUP BY math_topic
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
        LEFT JOIN public.student_game_progress p ON a.id = p.student_id
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
    const params = [];
    let query = buildCanonicalStudentProgressQuery();
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

app.post('/api/student-progress/:studentId/ai-insight', requireAnalyticsAccess, verifyScopedStudentAnalyticsAccess, async (req, res) => {
  try {
    const studentId = parseInt(req.params.studentId, 10);
    if (Number.isNaN(studentId)) return res.status(400).json({ error: 'Invalid student ID' });

    const progressResult = await pool.query(
      `SELECT p.*, a.name AS student_name
       FROM public.student_game_progress p
       LEFT JOIN public.accounts a ON a.id = p.student_id
       WHERE p.student_id = $1
       ORDER BY p.last_played DESC NULLS LAST, p.id DESC
       LIMIT 1`,
      [studentId]
    );
    if (progressResult.rows.length === 0) return res.status(404).json({ error: 'Student progress not found' });

    const [quizResult, playtimeResult] = await Promise.all([
      pool.query(
        `SELECT math_topic, difficulty, score, total_items, played_at
         FROM public.game_results
         WHERE resolved_student_id = $1
         ORDER BY played_at ASC NULLS LAST, id ASC
         LIMIT 500`,
        [studentId]
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

    const params = [studentId];
    let query = buildCanonicalStudentProgressQuery();
    query += ' AND a.id = $1';
    query += appendAnalyticsScopeFilter({ scope, params, studentColumn: 'a.id' });
    query += ' ORDER BY p.last_played DESC NULLS LAST, a.id ASC LIMIT 1';

    const result = await pool.query(query, params);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Student progress not found' });

    const progress = normalizeStudentProgressRow(result.rows[0]);
    const [quizResult, activityResult, playtimeResult] = await Promise.all([
      pool.query(
        `SELECT math_topic, difficulty, percentage, score, total_items, played_at
         FROM public.game_results
         WHERE resolved_student_id = $1
         ORDER BY played_at ASC NULLS LAST, id ASC
         LIMIT 100`,
        [studentId]
      ),
      pool.query(
        `SELECT student_id, activity_description, quest_progress, lesson_progress, activity_timestamp, last_played
         FROM public.activity_logs
         WHERE student_id = $1
         ORDER BY activity_timestamp DESC NULLS LAST, id DESC
         LIMIT 100`,
        [studentId]
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
