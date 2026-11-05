'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildAnnouncementSchemaRepairStatements } = require('../announcements.utils');

async function assertSyntheticDatabase(pool, databaseUrl) {
  if (process.env.NODE_ENV !== 'test' || process.env.CI !== 'true') {
    throw new Error('synthetic schema setup is available only in the isolated CI test environment');
  }
  let parsed;
  try { parsed = new URL(databaseUrl); } catch { throw new Error('a loopback synthetic PostgreSQL URL is required'); }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname.toLowerCase());
  const allowedDatabase = /^tq_(?:backend|archived_progress|game_metrics|auth_recovery|screen_time|parent_route|startup_safety)_test_ci$/i.test(databaseName);
  const sentinel = process.env.TQ_DISPOSABLE_DB_SENTINEL || '';
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !loopback || !allowedDatabase
      || parsed.search || parsed.hash || !/^[a-f0-9]{48}$/i.test(sentinel)) {
    throw new Error('synthetic schema setup refused: target must be a run-marked loopback tq_*_test_ci database');
  }

  const marker = await pool.query(`
    SELECT current_database() AS database_name,
           shobj_description(database_record.oid, 'pg_database') AS database_comment
    FROM pg_catalog.pg_database AS database_record
    WHERE database_record.datname = current_database()
  `);
  if (marker.rows[0]?.database_name !== databaseName
      || marker.rows[0]?.database_comment !== `tq-disposable-ci:${sentinel}`) {
    throw new Error('synthetic schema setup refused: database run marker does not match this CI run');
  }
}

const createSyntheticAccountsSchema = async (pool, databaseUrl) => {
  await assertSyntheticDatabase(pool, databaseUrl);
  await pool.query(`CREATE TABLE IF NOT EXISTS public.accounts (
    id SERIAL NOT NULL,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL,
    password VARCHAR(255) NOT NULL,
    mobile_number VARCHAR(20),
    role VARCHAR(50) NOT NULL DEFAULT 'Parent',
    parent_id VARCHAR(6),
    employee_id VARCHAR(50),
    otp_code VARCHAR(10),
    otp_expires_at TIMESTAMPTZ,
    is_archived BOOLEAN DEFAULT false,
    must_change_password BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    address VARCHAR(255),
    birthday DATE,
    gender VARCHAR(20),
    status VARCHAR(20) DEFAULT 'Offline',
    CONSTRAINT accounts_pkey PRIMARY KEY (id),
    CONSTRAINT accounts_email_key UNIQUE (email),
    CONSTRAINT accounts_parent_id_key UNIQUE (parent_id),
    CONSTRAINT accounts_employee_id_key UNIQUE (employee_id)
  )`);
};

const applySyntheticTestSchema = async (pool, databaseUrl) => {
  await createSyntheticAccountsSchema(pool, databaseUrl);
  try {
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS employee_id VARCHAR(50)');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT false');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS temporary_password_issued_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS temporary_password_expires_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS parent_id VARCHAR(6)');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS game_student_id VARCHAR(8)');
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
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS screen_time_reset_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS session_version INTEGER DEFAULT 0');
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
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS accounts_parent_id_key ON public.accounts(parent_id) WHERE parent_id IS NOT NULL');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS accounts_game_student_id_key ON public.accounts(game_student_id) WHERE game_student_id IS NOT NULL');
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
      current_map TEXT,
       score INTEGER NOT NULL,
      total_items INTEGER NOT NULL,
      percentage DECIMAL(5, 2) NOT NULL,
      played_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      question_set_id INTEGER,
      question_id INTEGER,
      is_unlinked BOOLEAN NOT NULL DEFAULT true
    );`);
    await pool.query('ALTER TABLE public.game_results ADD COLUMN IF NOT EXISTS question_set_id INTEGER');
    await pool.query('ALTER TABLE public.game_results ADD COLUMN IF NOT EXISTS question_id INTEGER');
    await pool.query('ALTER TABLE public.game_results ADD COLUMN IF NOT EXISTS playtime_session_id INTEGER');
    await pool.query('ALTER TABLE public.game_results ADD COLUMN IF NOT EXISTS current_map TEXT');
    await pool.query('ALTER TABLE public.game_results ADD COLUMN IF NOT EXISTS result_event_id VARCHAR(200)');
    await pool.query('ALTER TABLE public.game_results ADD COLUMN IF NOT EXISTS telemetry_contract_version VARCHAR(32)');
    await pool.query('ALTER TABLE public.game_results ADD COLUMN IF NOT EXISTS quest_graph_version VARCHAR(64)');
    await pool.query('ALTER TABLE public.game_results ADD COLUMN IF NOT EXISTS session_id BIGINT');
    await pool.query('ALTER TABLE public.game_results ADD COLUMN IF NOT EXISTS map_id VARCHAR(100)');
    await pool.query('ALTER TABLE public.game_results ADD COLUMN IF NOT EXISTS canonical_quest_id VARCHAR(160)');
    await pool.query('ALTER TABLE public.game_results ADD COLUMN IF NOT EXISTS canonical_task_id VARCHAR(160)');
    await pool.query('ALTER TABLE public.game_results ADD COLUMN IF NOT EXISTS canonical_battle_id VARCHAR(160)');
    await pool.query('ALTER TABLE public.game_results ADD COLUMN IF NOT EXISTS canonical_milestone_id VARCHAR(200)');
    await pool.query('ALTER TABLE public.game_results ADD COLUMN IF NOT EXISTS question_presented_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.game_results ADD COLUMN IF NOT EXISTS answer_submitted_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.game_results ADD COLUMN IF NOT EXISTS response_time_seconds INTEGER');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS game_results_student_result_event_unique ON public.game_results(resolved_student_id, result_event_id) WHERE resolved_student_id IS NOT NULL AND result_event_id IS NOT NULL');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_game_results_parent_id ON public.game_results(parent_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_game_results_resolved_student_id ON public.game_results(resolved_student_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_game_results_question_set_id ON public.game_results(question_set_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_game_results_question_id ON public.game_results(question_id) WHERE question_id IS NOT NULL');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_game_results_playtime_session_id ON public.game_results(playtime_session_id)');
    await pool.query(`CREATE TABLE IF NOT EXISTS public.playtime_deletion_tombstones (
      id BIGSERIAL PRIMARY KEY,
      deleted_record_id INTEGER NOT NULL,
      deleted_by INTEGER REFERENCES public.accounts(id) ON DELETE SET NULL,
      deletion_reason VARCHAR(1000) NOT NULL,
      deletion_operation_id UUID NOT NULL,
      target_fingerprint CHAR(64) NOT NULL,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`);
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS playtime_deletion_tombstone_record_unique ON public.playtime_deletion_tombstones(deleted_record_id)');
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
    await pool.query('ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS activity_event_id TEXT');
    await pool.query('ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS canonical_activity_id TEXT');
    await pool.query('ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS map_id TEXT');
    await pool.query('ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS session_id TEXT');
    await pool.query('ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS duration_seconds INTEGER');
    await pool.query('ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS telemetry_contract_version VARCHAR(32)');
    await pool.query('ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS quest_graph_version VARCHAR(64)');
    await pool.query('ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS canonical_quest_id VARCHAR(160)');
    await pool.query('ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS canonical_task_id VARCHAR(160)');
    await pool.query('ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS canonical_milestone_id VARCHAR(200)');
    await pool.query('ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS is_player_facing BOOLEAN');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS activity_logs_student_activity_event_id_unique ON public.activity_logs(student_id, activity_event_id) WHERE activity_event_id IS NOT NULL');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_activity_logs_timestamp ON public.activity_logs(activity_timestamp DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_activity_logs_student_name ON public.activity_logs(student_name)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_activity_logs_grade_section ON public.activity_logs(grade_level, section)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_activity_logs_actor_account_id ON public.activity_logs(actor_account_id)');
    await pool.query(`CREATE TABLE IF NOT EXISTS public.student_quest_milestones (
      id BIGSERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
      milestone_id TEXT NOT NULL,
      map_id TEXT,
      weight INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0),
      learning_cycle_version INTEGER NOT NULL DEFAULT 0,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (student_id, milestone_id, learning_cycle_version)
    );`);
    await pool.query('CREATE INDEX IF NOT EXISTS student_quest_milestones_student_cycle_idx ON public.student_quest_milestones(student_id, learning_cycle_version)');
    await pool.query('ALTER TABLE public.student_quest_milestones ADD COLUMN IF NOT EXISTS telemetry_contract_version VARCHAR(32)');
    await pool.query('ALTER TABLE public.student_quest_milestones ADD COLUMN IF NOT EXISTS quest_graph_version VARCHAR(64)');
    await pool.query('ALTER TABLE public.student_quest_milestones ADD COLUMN IF NOT EXISTS canonical_quest_id VARCHAR(160)');
    await pool.query('ALTER TABLE public.student_quest_milestones ADD COLUMN IF NOT EXISTS canonical_task_id VARCHAR(160)');
    await pool.query('ALTER TABLE public.student_quest_milestones ADD COLUMN IF NOT EXISTS canonical_milestone_id VARCHAR(200)');
    await pool.query('ALTER TABLE public.student_quest_milestones ADD COLUMN IF NOT EXISTS player_facing BOOLEAN NOT NULL DEFAULT true');
    await pool.query('ALTER TABLE public.student_quest_milestones ADD COLUMN IF NOT EXISTS source_activity_event_id VARCHAR(200)');

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
    // Keep the synthetic schema aligned with migration 019 and the read-only
    // startup readiness contract used by current playtime routes.
    await pool.query(`ALTER TABLE public.playtime_sessions
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS deleted_by INTEGER REFERENCES public.accounts(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS deletion_reason VARCHAR(1000),
      ADD COLUMN IF NOT EXISTS deletion_operation_id UUID`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_playtime_sessions_student_date ON public.playtime_sessions(student_id, date_played)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_playtime_sessions_parent_id ON public.playtime_sessions(parent_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_playtime_sessions_status ON public.playtime_sessions(status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_playtime_sessions_expiry ON public.playtime_sessions(status, expires_at)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_playtime_sessions_student_cycle ON public.playtime_sessions(student_id, learning_cycle_version, status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_playtime_sessions_visible_history ON public.playtime_sessions(deleted_at, date_played)');

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
    await pool.query('ALTER TABLE public.admin_audit_logs ADD COLUMN IF NOT EXISTS before_metadata JSONB');
    await pool.query('ALTER TABLE public.admin_audit_logs ADD COLUMN IF NOT EXISTS after_metadata JSONB');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at ON public.admin_audit_logs(created_at DESC)');
    await pool.query(`CREATE TABLE IF NOT EXISTS public.website_sessions (
      id BIGSERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
      credential_hash CHAR(64) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      revocation_reason VARCHAR(100),
      CONSTRAINT website_sessions_expiry_after_creation_check CHECK (expires_at > created_at)
    );`);
    await pool.query(`CREATE INDEX IF NOT EXISTS website_sessions_account_presence_index
      ON public.website_sessions (account_id, last_seen_at DESC)
      WHERE revoked_at IS NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS website_sessions_expiry_index
      ON public.website_sessions (expires_at)
      WHERE revoked_at IS NULL`);

    await pool.query(`CREATE TABLE IF NOT EXISTS public.folders (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );`);
    await pool.query('ALTER TABLE public.folders ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.folders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ');
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
    await pool.query("ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS generation_stage VARCHAR(32) NOT NULL DEFAULT 'queued'");
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS generation_completed_count INTEGER NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS generation_remaining_count INTEGER NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS generation_failed_batch_index INTEGER');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS generation_retry_count INTEGER NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS published_by INTEGER REFERENCES public.accounts(id) ON DELETE SET NULL');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS last_fetched_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS source_content_fingerprint VARCHAR(64)');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS source_file_bytes BYTEA');
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS source_file_mime_type VARCHAR(100)');
    await pool.query("ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS content_role VARCHAR(32) NOT NULL DEFAULT 'question_set'");
    await pool.query('ALTER TABLE public.learning_files ADD COLUMN IF NOT EXISTS source_learning_file_id INTEGER REFERENCES public.learning_files(id) ON DELETE RESTRICT');
    await pool.query("ALTER TABLE public.learning_files ALTER COLUMN generation_status SET DEFAULT 'not_applicable'");
    await pool.query("ALTER TABLE public.learning_files ALTER COLUMN publish_status SET DEFAULT 'staged'");
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
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS questions_id_learning_file_id_unique ON public.questions(id, learning_file_id)');
    await pool.query(`DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'game_results_question_set_question_fkey'
          AND conrelid = 'public.game_results'::regclass
      ) THEN
        ALTER TABLE public.game_results
          ADD CONSTRAINT game_results_question_set_question_fkey
          FOREIGN KEY (question_id, question_set_id)
          REFERENCES public.questions(id, learning_file_id)
          ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'game_results_question_requires_set_check'
          AND conrelid = 'public.game_results'::regclass
      ) THEN
        ALTER TABLE public.game_results
          ADD CONSTRAINT game_results_question_requires_set_check
          CHECK (question_id IS NULL OR question_set_id IS NOT NULL);
      END IF;
    END $$;`);
    const teacherAssignmentsSql = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '008_add_teacher_class_assignments.sql'),
      'utf8',
    );
    await pool.query(teacherAssignmentsSql);
    const saveCommitReceiptsSql = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '026_game_progress_save_commit_idempotency.sql'),
      'utf8',
    );
    await pool.query(saveCommitReceiptsSql);
  } catch (err) {
    console.error('Synthetic test schema bootstrap failed:', err.message);
    throw err;
  }
};

module.exports = { applySyntheticTestSchema, assertSyntheticDatabase, createSyntheticAccountsSchema };
